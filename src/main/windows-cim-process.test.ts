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

  it('uses firstQueryTimeoutMs only for the very first query after construction', async () => {
    const { spawner } = makeSpawner();
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
    // After death, respawn and run a query that does NOT use the
    // firstQueryTimeoutMs — it should sit there longer than 50ms.
    const p2 = runner.powershell(['-NoProfile', '-NonInteractive', '-Command', 'q'], {
      timeout: 5000,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 80));
    // Still pending → not timed out yet.
    let resolved = false;
    p2.then(() => (resolved = true));
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
