/**
 * Windows volume detection via `Get-CimInstance Win32_LogicalDisk` (ORAIN-0757).
 *
 * Replaces the previous `fsutil fsinfo volumeinfo / fsinfo drives` path
 * (ORAIN-0725). Two reasons:
 *
 *  1. The `fsutil` output for the filesystem label is the localized column
 *     header "File System Name" — on a Spanish (or any non-English) Windows
 *     install the value would also be localized. Matching by regex against
 *     that column made the parser fragile outside English locales.
 *  2. The previous enumeration built `` `${letter}\\` `` (no colon) — that
 *     path did not pass `extractDriveLetter`, so filesystem detection
 *     short-circuited to `unknown` and `fs.statfsSync('G\\')` resolved
 *     relative to the cwd and threw, leaving the storage bar empty.
 *
 * `Get-CimInstance` returns JSON whose property names (`DeviceID`,
 * `DriveType`, `FileSystem`) come from the WMI schema and are
 * language-independent. We filter `DriveType` to 2 (removable) and 3
 * (local) and drop 4 (network), 5 (optical), 6 (RAM disk), 1 (no root dir)
 * and 0 (unknown) — the v0.7.1 behaviour.
 *
 * Async invocation: a single `spawn('powershell.exe', ...)` per probe, no
 * shell, with `-NoProfile -NonInteractive` and a 5 s timeout. ENOENT and
 * timeouts are caught and surfaced as `unknown` / `[]`; the caller logs
 * once per session via `oncePerSession`.
 */

import { PersistentCimRunner, realSpawner, type ErrorCause } from './windows-cim-process';
import { log } from './logger';
// Re-export so `index.ts` can wire the runner into `before-quit` without
// importing the process module directly.
export { PersistentCimRunner } from './windows-cim-process';

/** A single WMI `Win32_LogicalDisk` record after JSON parsing. */
export interface CimLogicalDisk {
  deviceId: string; // "C:" / "G:"
  driveType: number; // 2 removable, 3 local, 4 network, 5 optical
  filesystem: string; // "NTFS" / "FAT32" / "exFAT" / ""
  // ORAIN-0759 AC2: `VolumeName` from the WMI record. ConvertTo-Json 5.1
  // serialises absent strings as `null`; on a labelled volume it is the
  // string (potentially with `\uXXXX` escapes for non-ASCII characters,
  // which `JSON.parse` decodes for us). Empty string when the property is
  // missing or null — the formatter trims and decides whether to include
  // the parenthetical. Whitespace-only labels are kept verbatim here so
  // the formatter can drop them, which keeps this parser a pure shape
  // transform.
  volumeLabel: string;
}

/** Filesystem labels the sync layer cares about for sanitization. */
export type WindowsFilesystemLabel = 'fat32' | 'exfat' | 'ntfs' | 'unknown';

/**
 * Surface this module needs from `child_process`. Narrowed so tests can stub
 * the PowerShell spawn without touching the real binary.
 */
export interface CimRunner {
  powershell(
    args: string[],
    options: { timeout: number },
  ): Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }>;
}

/**
 * Parse a `ConvertTo-Json -Compress` array of `Win32_LogicalDisk` records.
 *
 * Pure function: same input → same output. Drops entries that don't have
 * `DeviceID` and `DriveType` (CIM sometimes returns partial records for
 * drives being mounted/unmounted mid-call).
 *
 * ORAIN-0761 AC4: ConvertTo-Json 5.1 serialises a single record as a
 * JSON object (`{…}`), not as a 1-element array — wrap the non-array case
 * so a VM with exactly one logical disk still produces a 1-row result.
 */
export function parseCimLogicalDisks(stdout: string): CimLogicalDisk[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  // ORAIN-0761 AC4: `ConvertTo-Json -Compress` on a single record emits
  // `{…}`. Normalise to an array so the rest of the pipeline is unchanged.
  const records: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? [parsed]
      : [];
  const out: CimLogicalDisk[] = [];
  for (const item of records) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).DeviceID === 'string' &&
      typeof (item as Record<string, unknown>).DriveType === 'number'
    ) {
      const rec = item as Record<string, unknown>;
      out.push({
        deviceId: rec.DeviceID as string,
        driveType: rec.DriveType as number,
        filesystem: typeof rec.FileSystem === 'string' ? (rec.FileSystem as string) : '',
        // ORAIN-0759: missing property, null, or non-string → empty string.
        // Whitespace-only labels are preserved so the formatter can decide.
        volumeLabel: typeof rec.VolumeName === 'string' ? (rec.VolumeName as string) : '',
      });
    }
  }
  return out;
}

/** Caller-facing shape produced by `listWindowsDrives`. */
export interface WindowsDrive {
  letter: string; // "G"
  mountPath: string; // "G:\\" — ends with :\\ for `extractDriveLetter`
  isRemovable: boolean;
  vendorName: string; // "Removable" for DriveType=2, "Local" for 3
  // ORAIN-0759 AC1: optional `VolumeName` from WMI. Missing/empty/whitespace
  // means "no label"; the consumer renders just the letter in that case.
  volumeLabel: string;
}

/**
 * Render the device-list `displayName` for a Windows drive.
 *
 * ORAIN-0758 AC4: v0.7.1 used `X:` (with the colon); the ORAIN-0757
 * call site passed `d.letter` alone and produced 'G' instead of 'G:'.
 *
 * ORAIN-0759 AC1: when a `volumeLabel` is present (non-empty after trim),
 * the displayName becomes `"<label> (<letter>:)"` so a user with several
 * USB sticks can tell them apart. The label is trimmed here; the
 * upstream parser passes it through verbatim. Without a label we fall
 * back to the ORAIN-0758 shape `"<letter>:"`.
 */
export function formatWindowsDriveDisplayName(letter: string, volumeLabel?: string | null): string {
  const drive = `${letter.toUpperCase()}:`;
  const trimmed = typeof volumeLabel === 'string' ? volumeLabel.trim() : '';
  if (!trimmed) return drive;
  return `${trimmed} (${drive})`;
}

const POWERSHELL_ENUMERATE = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  // ORAIN-0759 AC2: add `VolumeName` to the same `Select-Object` list so the
  // label travels alongside DriveType/FileSystem in the existing JSON
  // enumeration. No second PowerShell call. ConvertTo-Json 5.1 escapes
  // non-ASCII characters as `\uXXXX` in the output (verified in the VM),
  // which `JSON.parse` decodes transparently.
  //
  // ORAIN-0761 AC3: the same enumeration also returns `FileSystem`, which
  // powers the per-folder filesystem badge. We no longer spawn a per-letter
  // `-Filter` query — the badge reads from `lastFilesystemByLetter`.
  'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,FileSystem,VolumeName | ConvertTo-Json -Compress',
];

/**
 * Default production runner — one persistent `powershell.exe` per app
 * session, lazily spawned on first use. The first query gets a generous
 * timeout (`DEFAULT_FIRST_QUERY_TIMEOUT_MS`, currently 20 s) to absorb the
 * cold-start cost on a fresh Win11 boot; subsequent queries assume the
 * process is warm (`DEFAULT_QUERY_TIMEOUT_MS`, 10 s).
 *
 * AC2: replaces the previous per-call `spawn('powershell.exe', …)` so we
 * pay the cold-start cost once, not once per poll. `close()` is wired in
 * `index.ts` to the `before-quit` handler so the process is reaped when
 * the app exits.
 *
 * AC5: every error path goes through `cimErrorState`, which logs
 * timeout / non-zero / invalid JSON / ENOENT once per session after the
 * third failed poll, with the cause and the duration in ms.
 *
 * AC7: constructing `realCim` does NOT spawn the process — it only spawns
 * on the first `powershell()` call. The renderer only invokes
 * `listWindowsDrives` / `detectWindowsFilesystem` from the win32 branch,
 * so macOS / Linux never spawn `powershell.exe`.
 */
export const realCim: CimRunner & { close?: () => void; spawnCount?: () => number } = (() => {
  if (process.platform !== 'win32') {
    // AC7: darwin / linux never invoke the runner. We still expose a
    // CimRunner-shaped object so call sites don't need a platform branch
    // for the type — but every call resolves to an empty failure rather
    // than ever spawning powershell.exe.
    return {
      async powershell() {
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: new Error('powershell runner disabled on non-win32'),
        };
      },
    };
  }
  const runner = new PersistentCimRunner({
    spawner: realSpawner,
    // ORAIN-0763 AC4: the runner's `onError` is no longer wired to
    // `recordCimError`. Failure reporting is the responsibility of
    // `listWindowsDrives`, which inspects the result and counts each
    // query once. The runner still accepts an `onError` callback so
    // tests can spy on the per-failure signal, but production does not.
    onError: () => {},
  });
  // Expose the runner's underlying `close()` so `index.ts` can wire it
  // into `before-quit`. Production code only ever calls `powershell()`,
  // never `close()`, on this object. `pendingQueriesCount` is the AC2
  // test-only surface — production never reads it.
  const proxy: CimRunner & {
    close: () => void;
    spawnCount: () => number;
    pendingQueriesCount: () => number;
  } = {
    powershell: (args, options) => runner.powershell(args, options),
    close: () => runner.close(),
    spawnCount: () => runner.spawnCount,
    pendingQueriesCount: () => runner.pendingQueriesCount,
  };
  return proxy;
})();

/**
 * Close the persistent PowerShell process. `index.ts` wires this into the
 * `before-quit` handler so the process is reaped when the app exits.
 * No-op on darwin / linux (the runner never spawned).
 */
export function closeRealCim(): void {
  realCim.close?.();
}

/**
 * ORAIN-0761 AC3: filesystem cache populated by the most recent
 * `listWindowsDrives` call. Keyed by uppercase drive letter. The per-folder
 * filesystem badge (`detectWindowsFilesystem`) reads from this map and
 * avoids spawning PowerShell again — that was the second cold-start cost
 * (one PowerShell per saved folder).
 *
 * Tests reset this between cases via `resetFilesystemCacheForTests` so a
 * cached value never leaks across describe blocks.
 */
let lastFilesystemByLetter: Map<string, WindowsFilesystemLabel> = new Map();

/**
 * ORAIN-0765 AC1: coalescing slot for concurrent `listWindowsDrives` calls.
 *
 * While one enumeration is in flight, every additional concurrent caller
 * attaches to the same promise instead of pushing another query into
 * `runner.powershell`. The slot is cleared in the `.finally` so the next
 * enumeration starts fresh.
 *
 * Why this lives in `listWindowsDrives` and not in the runner: the runner's
 * own "kill the child when every query is abandoned" rule already
 * (`src/main/windows-cim-process.ts:252`) recovers from a hung
 * `powershell.exe` cold-start — but only if there is at most ONE pending
 * query at any time. The coalescing guarantees that invariant.
 *
 * Without coalescing, the four overlapping production call sites (the
 * device-watcher backup poll, the fallback poll, the attach retry, and the
 * `usb:list` IPC) can each push a query into the runner before the previous
 * one resolves. If `powershell.exe` is hung in the cold-start, the first
 * caller never resolves, the child is never killed, and every later
 * enumeration piles up in `pendingQueries` for the rest of the session.
 */
let inFlightEnumeration: Promise<WindowsDrive[]> | null = null;

/** Test-only — clear the in-memory filesystem cache. Production code
 * never needs this; the cache is internal state. */
export function resetFilesystemCacheForTests(): void {
  lastFilesystemByLetter = new Map();
}

/**
 * ORAIN-0761 AC5: track enumeration failures and log them once per
 * session after the third failed poll. The device-watcher polls every
 * 15 s; without this dedup, a missing binary would flood main.log at
 * ~4 lines/minute. The state is a tiny counter + a logged flag — both
 * mutable and exposed for tests to reset.
 *
 * Logging uses the injected `onCimError` callback rather than `electron-log`
 * directly, so unit tests can supply a spy and assert against the call
 * site without touching global log state.
 */
interface CimErrorState {
  failures: number;
  logged: boolean;
}
const cimErrorState: CimErrorState = { failures: 0, logged: false };

/** Injected logger so tests can spy on AC5 output without touching
 * electron-log. */
export type CimErrorLogger = (cause: string, durationMs: number) => void;

/** Default — write to electron-log via a static import. ORAIN-0763 AC1
 * replaces the previous dynamic `require('electron-log')`, which loaded a
 * second copy of the package from `node_modules` when the main process
 * was already bundled into `dist/main/index.js` by electron-vite.
 * `electron-log`'s default export wires an IPC handler the first time
 * it's loaded — a second load throws `Attempted to register a second
 * handler for '__ELECTRON_LOG__'`, killing the watcher before its first
 * poll could complete. In CJS the dynamic `default` wrapper would also
 * never have written anything, so the cause of the failure never made
 * it to `main.log`. */
export const defaultCimErrorLogger: CimErrorLogger = (cause, durationMs) => {
  log.error(`[windows-cim] enumeration failed after 3 polls: ${cause} (${durationMs}ms)`);
};

/** Test seam — reset the AC5 once-per-session state. */
export function resetCimErrorStateForTests(): void {
  cimErrorState.failures = 0;
  cimErrorState.logged = false;
}

/** Test seam — override the AC5 logger. */
export function setCimErrorLoggerForTests(logger: CimErrorLogger | null): void {
  cimErrorLogger = logger;
}
let cimErrorLogger: CimErrorLogger | null = null;

/** Callback the persistent runner calls for every failed query. Increments
 * the failure counter; logs via the injected logger once the counter
 * crosses the threshold. Also called directly from `listWindowsDrives`
 * for failure modes the runner can't see (invalid JSON). */
export function recordCimError(cause: ErrorCause | string, durationMs: number): void {
  cimErrorState.failures += 1;
  if (cimErrorState.logged) return;
  if (cimErrorState.failures < 3) return;
  cimErrorState.logged = true;
  const logger: CimErrorLogger = cimErrorLogger ?? defaultCimErrorLogger;
  logger(cause, durationMs);
}

/**
 * Enumerate Windows drives via `Get-CimInstance Win32_LogicalDisk`.
 * Returns `[]` on any failure mode (binary missing, timeout, parse error).
 *
 * Filters `DriveType` to 2 (removable) and 3 (local) only — matches the
 * v0.7.1 behaviour and excludes network (4), optical (5), RAM disk (6),
 * no-root (1) and unknown (0).
 *
 * ORAIN-0763 AC4: this function is the SOLE caller of `recordCimError`
 * for the failure modes it can detect from the result. The persistent
 * runner used to also call `onError: recordCimError`, which fired once
 * per failed query — and so did we, doubling the count and tripping the
 * 3-poll threshold after only 2 failed queries. The runner is no longer
 * wired with `recordCimError`; it still emits an `onError` callback for
 * callers that want a separate signal, but the production wiring passes
 * a no-op there. Every error path below goes through `recordCimError`
 * exactly once.
 */
export async function listWindowsDrives(
  runner: CimRunner,
  options: { timeoutMs?: number } = {},
): Promise<WindowsDrive[]> {
  // ORAIN-0765 AC1: coalesce concurrent callers onto a single in-flight
  // enumeration. The slot is cleared in `.finally` so a failed/coalesced
  // call does not block the next enumeration.
  if (inFlightEnumeration) return inFlightEnumeration;
  inFlightEnumeration = (async () => {
    const timeout = options.timeoutMs ?? 5000;
    const startedAt = Date.now();
    let result;
    try {
      result = await runner.powershell(POWERSHELL_ENUMERATE, { timeout });
    } catch {
      recordCimError('runner-threw', Date.now() - startedAt);
      return [];
    }
    if (result.error) {
      const msg = result.error.message;
      // ORAIN-0765 AC3: preserve the cause the runner actually emitted.
      // The runner tags `runner closed` separately from `process died`
      // (see `windows-cim-process.ts:177` and `:317`), so the consumer
      // must keep them distinct — `runner-closed` indicates a deliberate
      // shutdown (`close()` was called), `process-died` indicates the
      // child exited on its own.
      const cause = msg.includes('ENOENT')
        ? 'spawn-enoent'
        : msg.includes('timeout')
          ? 'timeout'
          : msg.includes('runner closed')
            ? 'runner-closed'
            : msg.includes('process died')
              ? 'process-died'
              : 'runner-error';
      recordCimError(cause, Date.now() - startedAt);
      return [];
    }
    if (result.status === null || result.status !== 0) {
      // ORAIN-0765 AC3: surface the exit code the runner delivered. `0`
      // is the success path; non-zero or `null` (signal) round-trip as
      // `exit-<code>` / `exit-null` to match the runner's own
      // `ErrorCause` enum (`windows-cim-process.ts:83-91`).
      recordCimError(`exit-${result.status ?? 'null'}`, Date.now() - startedAt);
      return [];
    }
    const parsed = parseCimLogicalDisks(result.stdout);
    // `parseCimLogicalDisks` returns [] for invalid JSON. Distinguish "no
    // records" (valid empty list) from "couldn't parse" by re-checking the
    // raw stdout: an empty / non-JSON string is the failure mode.
    const disks = parsed;
    if (disks.length === 0 && result.stdout.trim() !== '' && result.stdout.trim() !== '[]') {
      recordCimError('invalid-json', Date.now() - startedAt);
      return [];
    }
    // ORAIN-0761 AC3: refresh the filesystem cache with this enumeration
    // before filtering by DriveType. A drive we don't list (optical, RAM,
    // etc.) doesn't update the cache either — its filesystem shouldn't
    // appear in any badge.
    const newCache = new Map<string, WindowsFilesystemLabel>();
    for (const d of disks) {
      if (d.driveType !== 2 && d.driveType !== 3) continue;
      const letter = d.deviceId.replace(/:$/, '').toUpperCase();
      const value = d.filesystem.trim().toLowerCase();
      if (value === 'ntfs' || value === 'fat32' || value === 'exfat') {
        newCache.set(letter, value);
      }
    }
    lastFilesystemByLetter = newCache;
    return disks
      .filter((d) => d.driveType === 2 || d.driveType === 3)
      .map((d) => {
        const letter = d.deviceId.replace(/:$/, '').toUpperCase();
        const isRemovable = d.driveType === 2;
        return {
          letter,
          mountPath: `${letter}:\\`,
          isRemovable,
          vendorName: isRemovable ? 'Removable' : 'Local',
          // ORAIN-0759 AC1: thread the WMI volume label through to the
          // formatter. The formatter decides whether to include it based on
          // trim — absent/null/empty/whitespace renders as `<letter>:` only.
          volumeLabel: d.volumeLabel,
        };
      });
  })().finally(() => {
    inFlightEnumeration = null;
  });
  return inFlightEnumeration;
}

/**
 * Detect the filesystem mounted at `driveLetter`.
 *
 * ORAIN-0761 AC3: this no longer spawns PowerShell. The `FileSystem`
 * property travels in the same `Get-CimInstance Win32_LogicalDisk`
 * enumeration as `DriveType` / `VolumeName` — `listWindowsDrives` caches
 * the value in `lastFilesystemByLetter`, and this function reads it back.
 * The renderer triggers `listWindowsDrives` first (USB polling), so by
 * the time it asks for a badge the cache is warm. `unknown` means
 * either no enumeration has run yet, or the letter isn't present.
 *
 * ORAIN-0758 AC3: the caller passes a full path ('C:\\Users\\user\\Music'
 * or 'G:\\'), not just the letter. The previous ORAIN-0757 regex
 * `replace(/[^A-Z]/g, '')` stripped the separator and concatenated every
 * alpha into a wrong DeviceID ('CUSERSUSERMUSIC:'), which WMI never
 * matched. Anchor the extraction to the start of the path with
 * `^([A-Za-z]):` so 'G:\\foo' and 'g:/' both resolve to 'G', while UNC /
 * POSIX paths return `unknown` without invoking PowerShell (still no
 * spawn here either).
 */
export async function detectWindowsFilesystem(
  _runner: CimRunner,
  driveLetter: string,
  _options: { timeoutMs?: number } = {},
): Promise<WindowsFilesystemLabel> {
  const match = /^([A-Za-z]):/.exec(driveLetter);
  const letter = match ? match[1]!.toUpperCase() : '';
  if (!letter) return 'unknown';
  return lastFilesystemByLetter.get(letter) ?? 'unknown';
}

/**
 * Side-effect wrapper that logs an error only the first time it is called.
 *
 * The device-watcher polls every 15 s; without this wrapper, a single
 * missing PowerShell would flood main.log. The flag is exposed so callers
 * can reset it between polling generations — in practice we never do, but
 * it keeps the helper unit-testable.
 */
export function oncePerSession(state: { logged: boolean }, fn: () => void): void {
  if (state.logged) return;
  state.logged = true;
  fn();
}
