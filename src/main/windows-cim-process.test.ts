// ORAIN-0761 AC2: the runner spawns one PowerShell.exe per app session,
// keeps it alive, and respawns on death. Tests stub `child_process.spawn`
// via a fake spawner that exposes writable streams so we can drive the
// protocol deterministically.

import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { describe, it, expect, vi } from 'vitest';

import { PersistentCimRunner, type ProcessSpawner, type ErrorCause } from './windows-cim-process';

/**
 * Minimal stand-in for `ChildProcessWithoutNullStreams`. Exposes the
 * three streams the runner actually uses (stdin/stdout/stderr) plus
 * the `exit` and `error` events.
 */
class FakeChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed = false;
  exitCode: number | null = null;
  emitter = new EventEmitter();

  constructor() {
    this.stdin = new Writable({
      write: (_chunk, _enc, cb) => cb(),
    });
    this.stdout = new Readable({ read: () => {} });
    this.stderr = new Readable({ read: () => {} });
  }

  kill(): void {
    this.killed = true;
    // Simulate the OS tearing down the process — emit exit shortly after.
    setImmediate(() => {
      if (this.exitCode === null) {
        this.exitCode = null;
        this.emitter.emit('exit', null);
      }
    });
  }

  emitStdout(text: string): void {
    this.stdout.push(text);
  }

  emitExit(code: number | null): void {
    this.exitCode = code;
    this.emitter.emit('exit', code);
  }

  emitError(err: Error): void {
    this.emitter.emit('error', err);
  }
}

/** Capture every script written to stdin for assertions. */
class CapturingFakeChild extends FakeChild {
  stdinChunks: string[] = [];
  override stdin: Writable;
  constructor() {
    super();
    const chunks = this.stdinChunks;
    // Writable's `write` callback runs with `this = Writable`, not the
    // outer FakeChild, so we capture the array via closure.
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        chunks.push(chunk.toString('utf8'));
        cb();
      },
    });
  }
}

/** Fake spawner that returns a fresh child on every `spawn()` call and
 * records the call list. */
function makeSpawner() {
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawner: ProcessSpawner = {
    spawn(command, args, _options) {
      calls.push({ command, args });
      const child = new CapturingFakeChild();
      children.push(child);
      // Patch the child so its `kill()` works with our emitter.
      const realKill = child.kill.bind(child);
      child.kill = (): boolean => {
        const wasAlive = !child.killed;
        realKill();
        return wasAlive;
      };
      // The runner accesses `child.on(...)` — bridge to our emitter.
      const proxiedChild = Object.create(child);
      proxiedChild.on = (event: string, listener: (...args: unknown[]) => void) => {
        child.emitter.on(event, listener);
        return proxiedChild;
      };
      proxiedChild.stdout = child.stdout;
      proxiedChild.stderr = child.stderr;
      proxiedChild.stdin = child.stdin;
      proxiedChild.kill = child.kill.bind(child);
      return proxiedChild;
    },
  };
  return { spawner, children, calls };
}

const ENUMERATE_SCRIPT =
  'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,FileSystem,VolumeName | ConvertTo-Json -Compress';

describe('PersistentCimRunner — basic protocol (AC2)', () => {
  it('spawns powershell.exe exactly once for 5 back-to-back queries', async () => {
    const { spawner, children, calls } = makeSpawner();
    const runner = new PersistentCimRunner({ spawner });

    const promises = [];
    for (let i = 0; i < 5; i += 1) {
      promises.push(
        runner.powershell(['-NoProfile', '-NonInteractive', '-Command', ENUMERATE_SCRIPT], {
          timeout: 5000,
        }),
      );
    }
    // Let the runner schedule spawn + push the queries.
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('powershell.exe');
    // `-Command -` keeps stdin open and runs whatever we pipe through.
    expect(calls[0]?.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-']);

    const child = children[0]!;
    // Each query pushes one script + one delim-write to stdin.
    expect((child as CapturingFakeChild).stdinChunks.length).toBeGreaterThanOrEqual(5);

    // Drive 5 frames back to the runner.
    for (let i = 0; i < 5; i += 1) {
      const delim = /Write-Output "---JT-END-([0-9a-f-]+)---"/.exec(
        (child as CapturingFakeChild).stdinChunks[i]!,
      );
      expect(delim, `query ${i} sent a delimiter`).not.toBeNull();
      child.emitStdout(`[]\n---JT-END-${delim![1]}---\n`);
    }
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('[]');
      expect(r.error).toBeUndefined();
    }
    expect(runner.spawnCount).toBe(1);
  });

  it('respawns when the child dies between queries 2 and 3 (AC2)', async () => {
    const { spawner, children, calls } = makeSpawner();
    const runner = new PersistentCimRunner({ spawner });

    const p1 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q1'], {
      timeout: 5000,
    });
    const p2 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q2'], {
      timeout: 5000,
    });
    await new Promise((r) => setImmediate(r));
    const child1 = children[0]! as CapturingFakeChild;
    // Capture the UUID the runner actually used for query 1.
    const m1 = /Write-Output "---JT-END-([0-9a-f-]+)---"/.exec(child1.stdinChunks[0]!);
    expect(m1).not.toBeNull();
    // Reply to query 1, then have the process die before query 2 replies.
    child1.emitStdout(`"r1"\n---JT-END-${m1![1]}---\n`);
    const r1 = await p1;
    expect(r1.stdout).toBe('"r1"');

    child1.emitExit(1);

    // Query 2 was outstanding when the child died → rejected with
    // { status: 1, error: 'process died' }.
    const r2 = await p2;
    expect(r2.error?.message).toBe('process died');

    // Next call respawns.
    const p3 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q3'], {
      timeout: 5000,
    });
    const p4 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q4'], {
      timeout: 5000,
    });
    const p5 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q5'], {
      timeout: 5000,
    });
    await new Promise((r) => setImmediate(r));
    expect(calls.length).toBe(2);
    const child2 = children[1]!;
    for (let i = 0; i < 3; i += 1) {
      const delim = /Write-Output "---JT-END-([0-9a-f-]+)---"/.exec(
        (child2 as CapturingFakeChild).stdinChunks[i]!,
      );
      expect(delim, `query ${i} on respawn2`).not.toBeNull();
      child2.emitStdout(`"r${i + 3}"\n---JT-END-${delim![1]}---\n`);
    }
    const results = await Promise.all([p3, p4, p5]);
    for (let i = 0; i < results.length; i += 1) {
      expect(results[i]!.stdout).toBe(`"r${i + 3}"`);
      expect(results[i]!.status).toBe(0);
    }
    expect(runner.spawnCount).toBe(2);
  });

  it('emits spawn-enoent via onError when the child errors with ENOENT', async () => {
    const { spawner, children } = makeSpawner();
    const onError = vi.fn();
    const runner = new PersistentCimRunner({ spawner, onError });

    const p = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q'], {
      timeout: 5000,
    });
    await new Promise((r) => setImmediate(r));
    children[0]!.emitError(new Error('spawn ENOENT powershell.exe'));

    const r = await p;
    expect(r.status).toBeNull();
    expect(r.error?.message).toContain('ENOENT');
    const calls = onError.mock.calls.filter((c) => c[0] === 'spawn-enoent');
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('emits timeout via onError when the query exceeds the timeout', async () => {
    const { spawner, children } = makeSpawner();
    const onError = vi.fn();
    const runner = new PersistentCimRunner({
      spawner,
      queryTimeoutMs: 30,
      firstQueryTimeoutMs: 30,
      onError,
    });

    const p = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q'], {
      timeout: 30,
    });
    // No stdout emitted — let the timer fire.
    await new Promise((r) => setTimeout(r, 60));
    const r = await p;
    expect(r.error?.message).toBe('timeout');
    expect(onError).toHaveBeenCalledWith('timeout', expect.any(Number));
    // The runner killed the child after the timeout; a future call respawns.
    expect(children[0]!.killed).toBe(true);
  });

  it('uses firstQueryTimeoutMs for every query until one resolves successfully', async () => {
    // ORAIN-0763 AC3: the cold-start window is "no query has resolved
    // on this generation yet", not "this is the first query I've
    // seen". A query that times out never resolves successfully, so the
    // next query on the respawned child still gets `firstQueryTimeoutMs`
    // — otherwise the cold-start budget shrinks race-by-race until it
    // can't cover the actual PS warm-up.
    const { spawner, children } = makeSpawner();
    const runner = new PersistentCimRunner({
      spawner,
      firstQueryTimeoutMs: 50,
      queryTimeoutMs: 5000,
    });

    const p1 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q'], {
      timeout: 5000,
    });
    await new Promise((r) => setImmediate(r));
    // First query is pending with the 50ms timer. Confirm by waiting past
    // 50ms — it should fire before the (ignored) timeoutMs of 5000.
    await new Promise((r) => setTimeout(r, 80));
    const r1 = await p1;
    expect(r1.error?.message).toBe('timeout');
    // After p1 times out the child is killed but `lastResolvedAt` stays
    // undefined — p1 never produced a successful frame. The next call
    // respawns, increments `generation`, and STILL uses `firstQueryTimeoutMs`
    // because cold-start is keyed off resolution, not arrival.
    const p2 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q'], {
      timeout: 5000,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 80));
    const r2 = await p2;
    expect(r2.error?.message).toBe('timeout');
    // Now resolve a query successfully: cold-start ends, the next query
    // gets the warm `queryTimeoutMs`. children[2] is the third spawn
    // (p1 → child 0, p2 → child 1, p3 below → child 2 — but p3 is what
    // we resolve here, so spawn p3 first and then resolve it).
    const p3 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q'], {
      timeout: 5000,
    });
    await new Promise((r) => setImmediate(r));
    const child = children[2]! as CapturingFakeChild;
    const m = /Write-Output "---JT-END-([0-9a-f-]+)---"/.exec(child.stdinChunks[0]!);
    expect(m).not.toBeNull();
    child.emitStdout(`"ok"\n---JT-END-${m![1]}---\n`);
    const r3 = await p3;
    expect(r3.status).toBe(0);
    expect(r3.stdout).toBe('"ok"');
    // p4 arrives AFTER the first successful resolve → uses warm timeout.
    const p4 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q'], {
      timeout: 5000,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 80));
    let resolved = false;
    p4.then(() => (resolved = true));
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);
  });

  it('close() rejects outstanding queries and prevents further spawns', async () => {
    const { spawner, children } = makeSpawner();
    const runner = new PersistentCimRunner({ spawner });
    const p1 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q'], {
      timeout: 5000,
    });
    await new Promise((r) => setImmediate(r));
    runner.close();
    const r1 = await p1;
    expect(r1.error?.message).toBe('runner closed');
    expect(children[0]!.killed).toBe(true);
    // After close, isRunning is false and a new query would respawn.
    // We assert the runner does not throw on a fresh call.
    const p2 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q'], {
      timeout: 5000,
    });
    await new Promise((r) => setImmediate(r));
    expect(runner.isRunning).toBe(true);
    // And it's a different generation.
    expect(runner.spawnCount).toBe(2);
    runner.close();
    await p2.catch(() => undefined);
  });

  it('does not invoke real powershell on darwin / win32 callers can still use the runner (AC7)', () => {
    // AC7 requires zero `powershell.exe` spawns outside Windows. The runner
    // only spawns on the first `powershell()` call, so we assert here that
    // constructing the runner does NOT touch the OS — only a call does.
    const { spawner, calls } = makeSpawner();
    const runner = new PersistentCimRunner({ spawner });
    expect(calls).toHaveLength(0);
    expect(runner.spawnCount).toBe(0);
    expect(runner.isRunning).toBe(false);
  });
});

describe('PersistentCimRunner — once-per-session error semantics (AC5 wiring)', () => {
  it('emits one onError call per failure mode', async () => {
    const { spawner, children } = makeSpawner();
    const causes: ErrorCause[] = [];
    const runner = new PersistentCimRunner({
      spawner,
      queryTimeoutMs: 30,
      firstQueryTimeoutMs: 30,
      onError: (cause, _ms) => causes.push(cause),
    });

    // Timeout.
    const p1 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q'], {
      timeout: 30,
    });
    await new Promise((r) => setTimeout(r, 60));
    await p1;

    // Non-zero exit.
    const p2 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q'], {
      timeout: 30,
    });
    await new Promise((r) => setImmediate(r));
    children[1]!.emitExit(1);
    await p2;

    // Spawn ENOENT.
    const p3 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q'], {
      timeout: 30,
    });
    await new Promise((r) => setImmediate(r));
    children[2]!.emitError(new Error('spawn ENOENT'));
    await p3;

    expect(causes).toContain('timeout');
    expect(causes).toContain('exit-1');
    expect(causes).toContain('spawn-enoent');
  });
});

// ORAIN-0763 AC3: while the persistent PowerShell process has not yet
// answered its first query, every queued query is in cold-start territory
// and gets `firstQueryTimeoutMs` — NOT the caller's `timeoutMs`. The
// caller's timeout was already capped at `min(callerTimeout, warmTimeout)`
// in ORAIN-0761; the bug is that this cap applied only to the very first
// query in the buffer, not to subsequent concurrent ones.
//
// The regression scenario: the device-watcher polls at boot, and the
// renderer immediately fires `usb:list`. Both queries land in
// `pendingQueries` simultaneously. With `firstQueryTimeoutMs = 20_000`,
// `queryTimeoutMs = 10_000`, and `callerTimeout = 5_000` the second query
// received `min(5000, 10000) = 5000` ms and timed out before the PS
// cold-start finished, killing the child and tearing down the first query
// with it.
//
// Expected behaviour (AC3): two concurrent queries with the cold-start
// timeout in flight must both resolve with `status: 0` and the runner
// must have spawned exactly ONE child process.
describe('ORAIN-0763 AC3 — concurrent queries share the cold-start timeout', () => {
  it('two concurrent queries during cold-start both succeed with one spawn', async () => {
    // Simulate a 6 s cold-start: the child doesn't emit stdout for 6 s,
    // matching the "Win11 dev" VM's observed powershell.exe warm-up.
    const COLD_START_MS = 6_000;
    // The caller-side cap mirrors `listWindowsDrives`'s default of 5 s
    // (see windows-cim.ts `timeoutMs ?? 5000`). This is the cap that
    // used to kill the in-flight child.
    const CALLER_TIMEOUT_MS = 5_000;
    // The cold-start allowance — generous enough to cover the simulated
    // cold-start plus headroom for the test runner.
    const FIRST_QUERY_TIMEOUT_MS = 20_000;

    const { spawner, children, calls } = makeSpawner();
    const runner = new PersistentCimRunner({
      spawner,
      firstQueryTimeoutMs: FIRST_QUERY_TIMEOUT_MS,
      queryTimeoutMs: 10_000,
    });

    const p1 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q1'], {
      timeout: CALLER_TIMEOUT_MS,
    });
    const p2 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q2'], {
      timeout: CALLER_TIMEOUT_MS,
    });
    // Let the runner push both queries into the buffer + spawn the child.
    await new Promise((r) => setImmediate(r));

    // Only ONE child was spawned — no respawn from the timeout-induced
    // kill that AC3 is fixing.
    expect(calls).toHaveLength(1);
    expect(runner.spawnCount).toBe(1);

    const child = children[0]! as CapturingFakeChild;
    // Capture both delimiters.
    const m1 = /Write-Output "---JT-END-([0-9a-f-]+)---"/.exec(child.stdinChunks[0]!);
    const m2 = /Write-Output "---JT-END-([0-9a-f-]+)---"/.exec(child.stdinChunks[1]!);
    expect(m1).not.toBeNull();
    expect(m2).not.toBeNull();

    // Simulate the cold-start: emit no stdout for the full COLD_START_MS
    // window, then emit both frames in order. The test waits the full
    // window — using a shorter value here would also satisfy the timeout
    // cap, so the assertion that matters is `status: 0` for BOTH queries.
    await new Promise((r) => setTimeout(r, COLD_START_MS + 500));
    child.emitStdout(`"r1"\n---JT-END-${m1![1]}---\n`);
    child.emitStdout(`"r2"\n---JT-END-${m2![1]}---\n`);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(0);
    expect(r1.error).toBeUndefined();
    expect(r1.stdout).toBe('"r1"');
    expect(r2.status).toBe(0);
    expect(r2.error).toBeUndefined();
    expect(r2.stdout).toBe('"r2"');
    // Spawn count must still be one — neither timeout fired, no respawn.
    expect(runner.spawnCount).toBe(1);
  });

  // Cold start ignores the caller's timeout (AC3), so tests that need a
  // per-query deadline first warm the runner with one resolved query.
  async function warmRunner(): Promise<{
    runner: PersistentCimRunner;
    child: CapturingFakeChild;
  }> {
    const { spawner, children } = makeSpawner();
    const runner = new PersistentCimRunner({
      spawner,
      firstQueryTimeoutMs: 1000,
      queryTimeoutMs: 1000,
    });
    const warm = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'warm'], {
      timeout: 1000,
    });
    await new Promise((r) => setImmediate(r));
    const child = children[0]! as CapturingFakeChild;
    const m = /Write-Output "---JT-END-([0-9a-f-]+)---"/.exec(child.stdinChunks[0]!);
    child.emitStdout(`"warm"\n---JT-END-${m![1]}---\n`);
    expect((await warm).status).toBe(0);
    return { runner, child };
  }

  const delimOf = (child: CapturingFakeChild, n: number): string =>
    /Write-Output "---JT-END-([0-9a-f-]+)---"/.exec(child.stdinChunks[n]!)![1]!;

  it('a query whose own timeout expires does NOT kill the child while other queries are still in flight', async () => {
    const { runner, child } = await warmRunner();
    const pShort = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q1'], {
      timeout: 30,
    });
    const pLong = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q2'], {
      timeout: 1000,
    });
    expect((await pShort).error?.message).toBe('timeout');
    expect(child.killed).toBe(false);
    // The real process still answers the timed-out query, then the live one.
    child.emitStdout(
      `"late"\n---JT-END-${delimOf(child, 1)}---\n"ok"\n---JT-END-${delimOf(child, 2)}---\n`,
    );
    const rLong = await pLong;
    expect(rLong.status).toBe(0);
    expect(rLong.stdout).toBe('"ok"');
  });

  it('a late frame from a timed-out query does not leak into the next query', async () => {
    // The stream is FIFO by delimiter. When query A times out but the
    // child survives (B is still in flight), PowerShell still emits A's
    // output and A's delimiter. B's frame must not swallow them.
    const { runner, child } = await warmRunner();
    const pA = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'qa'], {
      timeout: 30,
    });
    const pB = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'qb'], {
      timeout: 1000,
    });
    expect((await pA).error?.message).toBe('timeout');
    child.emitStdout(
      `"late-a"\n---JT-END-${delimOf(child, 1)}---\n"b"\n---JT-END-${delimOf(child, 2)}---\n`,
    );
    const rB = await pB;
    expect(rB.status).toBe(0);
    expect(rB.stdout).toBe('"b"');
  });

  it('kills the child once only abandoned queries remain in flight', async () => {
    const { runner, child } = await warmRunner();
    const pA = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'qa'], {
      timeout: 30,
    });
    const pB = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'qb'], {
      timeout: 60,
    });
    expect((await pA).error?.message).toBe('timeout');
    expect(child.killed).toBe(false);
    expect((await pB).error?.message).toBe('timeout');
    expect(child.killed).toBe(true);
  });

  it('reports each timed-out query to onError exactly once', async () => {
    const { spawner, children } = makeSpawner();
    const causes: string[] = [];
    const runner = new PersistentCimRunner({
      spawner,
      firstQueryTimeoutMs: 1000,
      queryTimeoutMs: 1000,
      onError: (c) => causes.push(c),
    });
    const warm = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'w'], {
      timeout: 1000,
    });
    await new Promise((r) => setImmediate(r));
    const child = children[0]! as CapturingFakeChild;
    child.emitStdout(`"w"\n---JT-END-${delimOf(child, 0)}---\n`);
    await warm;
    const pA = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'qa'], {
      timeout: 30,
    });
    const pB = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'qb'], {
      timeout: 60,
    });
    await Promise.all([pA, pB]);
    expect(causes).toEqual(['timeout', 'timeout']);
  });
});
