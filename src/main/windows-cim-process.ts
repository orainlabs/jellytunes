/**
 * ORAIN-0761 AC2: persistent PowerShell process per app session.
 *
 * Why: Win11 24H2 removed `wmic`. ORAIN-0725 replaced it with `fsutil`
 * (fast but locale-fragile). ORAIN-0757 switched to
 * `Get-CimInstance Win32_LogicalDisk` via `powershell.exe` — locale-clean,
 * but `powershell.exe` cold-start takes a few seconds on the "Win11 dev"
 * VM, well above the 5 s timeout that `windows-cim.ts` had. The list was
 * empty and the badge never showed a filesystem.
 *
 * The `systeminformation` package solves the same problem with a single
 * persistent process (`util.js` `powerShellStart()`): keep one
 * `powershell.exe` alive, send each query on its stdin, mark the end of
 * the response with a delimiter, and reuse it for every call. We do the
 * same here, but in-process — no new dependency.
 *
 * Wire protocol:
 *
 *   runner  → child stdin:   <script>\nWrite-Output "<delim>"\n
 *   child   → runner stdout:  <stdout>\n<delim>\n
 *
 * The delimiter is `---JT-END-<UUID>---`. The UUID is generated per
 * process start, so a frame from a previous run can never match the
 * current delimiter. The script body is whatever the caller supplied
 * (e.g. `Get-CimInstance … | ConvertTo-Json -Compress`) — `ConvertTo-Json
 * -Compress` produces single-line output with no newlines, so reading
 * until the delimiter is safe.
 *
 * Restart-on-death: if the child exits with outstanding queries, every
 * pending promise rejects with `{ status: null, error: new Error('process
 * died') }`. The next call lazily respawns.
 *
 * Close on quit: `close()` kills the child. `index.ts` calls it in the
 * `before-quit` handler so we don't leak a PowerShell.exe after the app
 * exits.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';

import type { CimRunner } from './windows-cim';

/**
 * Subset of `child_process.spawn` that the runner uses. Narrowed so tests
 * can stub the binary without touching the real `powershell.exe`.
 */
export interface ProcessSpawner {
  spawn(
    command: string,
    args: string[],
    options: { windowsHide: boolean },
  ): ChildProcessWithoutNullStreams;
}

/** Real spawner — wraps the actual `child_process.spawn`. */
export const realSpawner: ProcessSpawner = {
  spawn(command, args, options) {
    return spawn(command, args, options) as ChildProcessWithoutNullStreams;
  },
};

interface PendingQuery {
  delim: string;
  startedAt: number;
  resolve: (value: {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Default timeouts (ms). The first query allows for cold-start; later
 * queries assume the process is warm. AC1 lets the operator override these
 * after measuring the VM cold-start. */
export const DEFAULT_FIRST_QUERY_TIMEOUT_MS = 20_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

export type ErrorCause =
  | 'timeout'
  | 'exit-0'
  | 'exit-1'
  | 'exit-null'
  | 'spawn-enoent'
  | 'process-died'
  | 'runner-closed'
  | 'invalid-script';

export interface PersistentCimRunnerOptions {
  /** Injected spawner — production passes `realSpawner`. */
  spawner: ProcessSpawner;
  /** Override the first-query timeout (cold-start). Default 20 s. */
  firstQueryTimeoutMs?: number;
  /** Override subsequent-query timeout. Default 10 s. */
  queryTimeoutMs?: number;
  /** Called once for every error a query ends with (timeout, exit, ENOENT,
   * process-died). The runner itself never logs — wiring it through this
   * callback lets `windows-cim.ts` decide once-per-session (AC5). */
  onError?: (cause: ErrorCause, durationMs: number) => void;
}

/**
 * A persistent PowerShell process that fulfils the `CimRunner` contract.
 *
 * Lazily spawns on the first `powershell()` call. Respawns if the child
 * dies. `close()` terminates the child and rejects outstanding queries.
 */
export class PersistentCimRunner implements CimRunner {
  private readonly spawner: ProcessSpawner;
  private readonly firstQueryTimeoutMs: number;
  private readonly queryTimeoutMs: number;
  private readonly onError: (cause: ErrorCause, durationMs: number) => void;

  private child: ChildProcessWithoutNullStreams | null = null;
  private pendingQueries: PendingQuery[] = [];
  private stdoutBuffer = '';
  /** Generation increments every time we respawn; lets tests verify
   * "5 queries → 1 spawn" and "process dies → next call respawns". */
  private generation = 0;

  constructor(options: PersistentCimRunnerOptions) {
    this.spawner = options.spawner;
    this.firstQueryTimeoutMs = options.firstQueryTimeoutMs ?? DEFAULT_FIRST_QUERY_TIMEOUT_MS;
    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.onError = options.onError ?? (() => {});
  }

  powershell(
    args: string[],
    options: { timeout: number },
  ): Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }> {
    return this.run(args, options.timeout);
  }

  /** Number of distinct child-process spawns since construction. Tests use
   * this to verify "5 queries → 1 spawn" and "process dies between query
   * 2 and 3 → 2 spawns". */
  get spawnCount(): number {
    return this.generation;
  }

  /** True when a child is currently alive. */
  get isRunning(): boolean {
    return this.child !== null;
  }

  /** Kill the child and reject outstanding queries. Idempotent. */
  close(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* swallow — process may already be dead */
      }
      this.child = null;
    }
    const outstanding = this.pendingQueries;
    this.pendingQueries = [];
    for (const q of outstanding) {
      if (q.timer !== null) clearTimeout(q.timer);
      this.onError('runner-closed', Date.now() - q.startedAt);
      q.resolve({ status: null, stdout: '', stderr: '', error: new Error('runner closed') });
    }
  }

  private run(
    args: string[],
    timeoutMs: number,
  ): Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }> {
    if (args.length === 0) {
      this.onError('invalid-script', 0);
      return Promise.resolve({
        status: null,
        stdout: '',
        stderr: '',
        error: new Error('no script'),
      });
    }
    const script = args[args.length - 1]!;
    const requestStartedAt = Date.now();
    const isFirstQuery = this.pendingQueries.length === 0 && this.generation === 0;
    // First query gets the cold-start allowance (`firstQueryTimeoutMs`).
    // Subsequent queries are capped at `queryTimeoutMs` so the operator
    // can dial in the warm-process ceiling via AC1. The caller's
    // `timeoutMs` shrinks the cap, never grows it.
    const effectiveTimeout = isFirstQuery
      ? this.firstQueryTimeoutMs
      : Math.min(timeoutMs, this.queryTimeoutMs);

    if (!this.child) {
      this.spawnChild();
    }
    const child = this.child!;

    const delim = `---JT-END-${randomUUID()}---`;

    return new Promise((resolve) => {
      const query: PendingQuery = {
        delim,
        startedAt: requestStartedAt,
        resolve,
        timer: null,
      };
      const onTimeout = (): void => {
        const idx = this.pendingQueries.indexOf(query);
        if (idx >= 0) this.pendingQueries.splice(idx, 1);
        const durationMs = Date.now() - requestStartedAt;
        this.onError('timeout', durationMs);
        resolve({
          status: null,
          stdout: '',
          stderr: '',
          error: new Error('timeout'),
        });
        // Kill the child so subsequent calls respawn fresh — a hung PS
        // will keep producing no output for every following query.
        try {
          child.kill();
        } catch {
          /* swallow */
        }
      };
      query.timer = setTimeout(onTimeout, effectiveTimeout);
      this.pendingQueries.push(query);

      try {
        child.stdin.write(`${script}\nWrite-Output "${delim}"\n`);
      } catch (err) {
        const idx = this.pendingQueries.indexOf(query);
        if (idx >= 0) this.pendingQueries.splice(idx, 1);
        if (query.timer !== null) clearTimeout(query.timer);
        const message = err instanceof Error ? err.message : String(err);
        this.onError('process-died', Date.now() - requestStartedAt);
        resolve({ status: null, stdout: '', stderr: '', error: new Error(message) });
      }
    });
  }

  private spawnChild(): void {
    const child = this.spawner.spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '-'],
      { windowsHide: true },
    );
    this.child = child;
    this.stdoutBuffer = '';
    this.generation += 1;

    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.stdoutBuffer += text;
      this.drainFrames();
    });
    child.stderr.on('data', (_chunk: Buffer | string) => {
      // We deliberately drop stderr — frames are delimited on stdout.
      // Real PS errors surface as a non-zero exit, not as text on stderr.
    });
    child.on('exit', (code) => {
      // Only clear state if this child is still the current one — a
      // close() may have already replaced it with a respawn.
      if (this.child !== child) {
        return;
      }
      const outstanding = this.pendingQueries;
      this.pendingQueries = [];
      const cause: ErrorCause = code === 0 ? 'exit-0' : code === 1 ? 'exit-1' : 'exit-null';
      for (const q of outstanding) {
        if (q.timer !== null) clearTimeout(q.timer);
        this.onError(cause, Date.now() - q.startedAt);
        q.resolve({
          status: code,
          stdout: '',
          stderr: '',
          error: new Error('process died'),
        });
      }
      this.stdoutBuffer = '';
      this.child = null;
    });
    child.on('error', (err) => {
      if (this.child !== child) {
        return;
      }
      const outstanding = this.pendingQueries;
      this.pendingQueries = [];
      const cause: ErrorCause = err.message.includes('ENOENT') ? 'spawn-enoent' : 'process-died';
      for (const q of outstanding) {
        if (q.timer !== null) clearTimeout(q.timer);
        this.onError(cause, Date.now() - q.startedAt);
        q.resolve({ status: null, stdout: '', stderr: '', error: err });
      }
      this.child = null;
    });
  }

  private drainFrames(): void {
    // Frames end with `\n<delim>\n` on stdout (we appended `\nWrite-Output
    // "<delim>"\n`, which prints `<delim>` followed by the trailing
    // newline PS adds). Walk pending in order and split as many complete
    // frames as the buffer allows.
    let cursor = 0;
    while (cursor < this.stdoutBuffer.length) {
      const pending = this.pendingQueries[0];
      if (!pending) break;
      const delim = pending.delim;
      const frameEnd = this.stdoutBuffer.indexOf(delim, cursor);
      if (frameEnd === -1) break;
      // Frame text is everything between `cursor` and `frameEnd`, minus
      // the trailing newline that precedes the delimiter.
      let frame = this.stdoutBuffer.slice(cursor, frameEnd);
      if (frame.endsWith('\r\n')) frame = frame.slice(0, -2);
      else if (frame.endsWith('\n')) frame = frame.slice(0, -1);
      // Consume through the delimiter and any trailing newline.
      cursor = frameEnd + delim.length;
      if (this.stdoutBuffer[cursor] === '\n') cursor += 1;

      this.pendingQueries.shift();
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.resolve({
        status: 0,
        stdout: frame,
        stderr: '',
      });
    }
    if (cursor > 0) this.stdoutBuffer = this.stdoutBuffer.slice(cursor);
  }
}
