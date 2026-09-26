/**
 * Windows volume detection without the pre-24H2 binary (ORAIN-0725 / GitHub issue #23).
 *
 * Windows 11 24H2+ removed that binary. The previous implementation in
 * `src/main/index.ts` spawned it (a `logicaldisk ...` lookup) for three
 * different needs (drive enumeration, free space, filesystem type) and
 * the missing binary produced a `spawnSync ... ENOENT` on every 15 s
 * polling tick — not just noise, but `detectFilesystem` then returned
 * `'unknown'`, which left `sanitizePathComponent` a no-op so paths
 * containing `<>:"/\|?*` reached FFmpeg and the sync failed with exit
 * code 1.
 *
 * This module replaces those three spawns with one `fsutil fsinfo volumeinfo`
 * per drive. `fsutil` ships in `C:\Windows\System32` on every supported
 * Windows install, so no new dependency. We keep the calls behind a single
 * `runFsutil` injection point so tests can stub them.
 *
 * Important constraints (driven by the polling fallback that runs every
 * 15 s when `usb-detection` is unavailable):
 *
 *   - Each call must be quick and not block the main process. `fsutil`
 *     with no piped stdin completes in single-digit ms for a single drive,
 *     but we still cap it at 2 s and bail to `unknown` on timeout.
 *   - Errors must not throw out of the helper; callers (e.g. the polling
 *     loop) log once per session, not per attempt — see
 *     `windowsDriveDetectionErrorDedup` in `index.ts`.
 *
 * Volume-info output format (`fsutil fsinfo volumeinfo E:`):
 *
 *     Volume Name : USB
 *     Volume Serial Number : 0xABCD...
 *     Max Component Length : 255
 *     File System Name : FAT32
 *     ...
 *
 * We only need the `File System Name` line and the drive letter.
 */

import { spawnSync } from 'child_process';

/** Filesystem labels the sync layer cares about for sanitization. */
export type WindowsFilesystemLabel = 'fat32' | 'exfat' | 'ntfs' | 'unknown';

/**
 * Surface this module needs from `child_process`. Narrowed so tests can
 * stub it without touching the real `spawnSync`.
 */
export interface FsutilRunner {
  fsutil(
    args: string[],
    options: { timeout: number },
  ): {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  };
}

/** Default production runner — calls the real `fsutil` binary. */
export const realFsutil: FsutilRunner = {
  fsutil(args, options) {
    const result = spawnSync('fsutil', args, {
      encoding: 'utf8',
      timeout: options.timeout,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
    };
  },
};

/**
 * Parse a single `fsutil fsinfo volumeinfo <drive>:` output for the
 * `File System Name` line. Returns the lowercase label, or `unknown`
 * when the output does not contain a recognizable filesystem.
 *
 * Pure function: same input → same output. Easy to unit test.
 */
export function parseWindowsVolumeInfo(stdout: string): WindowsFilesystemLabel {
  // Match "File System Name : FAT32" with any whitespace.
  const match = stdout.match(/File System Name\s*:\s*([^\r\n]+)/i);
  if (!match) return 'unknown';
  const t = match[1].trim().toLowerCase();
  if (t === 'ntfs') return 'ntfs';
  if (t === 'fat32') return 'fat32';
  if (t === 'exfat') return 'exfat';
  return 'unknown';
}

/**
 * Extract the drive letter from a Windows path (e.g. `E:\Music` → `E`).
 * Returns uppercase, or empty string if the path is not a drive path.
 */
export function extractDriveLetter(devicePath: string): string {
  if (!devicePath) return '';
  // Match an ASCII letter followed by a colon, optionally followed by a path
  // separator or end of string. `E:` alone is also a valid drive path.
  const m = devicePath.match(/^([A-Za-z])(?::(?:[\\/]|$))/);
  return m ? m[1].toUpperCase() : '';
}

/**
 * Detect the filesystem mounted at `devicePath` using `fsutil fsinfo volumeinfo`.
 *
 * Returns `unknown` for any failure mode:
 *   - `devicePath` is not a drive letter path
 *   - `fsutil` is not available (returns ENOENT)
 *   - `fsutil` times out (2 s)
 *   - the output does not contain a recognized filesystem label
 *
 * The caller is responsible for translating `unknown` into a sanitizer
 * decision — `sanitizePathComponent` already does this by gating on
 * platform, so `unknown` is safe to fall through.
 */
export function detectWindowsFilesystem(
  runner: FsutilRunner,
  devicePath: string,
  options: { timeoutMs?: number } = {},
): WindowsFilesystemLabel {
  const driveLetter = extractDriveLetter(devicePath);
  if (!driveLetter) return 'unknown';

  const timeout = options.timeoutMs ?? 2000;
  let result;
  try {
    result = runner.fsutil(['fsinfo', 'volumeinfo', `${driveLetter}:`], { timeout });
  } catch {
    return 'unknown';
  }

  if (result.error) return 'unknown';
  if (result.status === null || result.status !== 0) return 'unknown';

  return parseWindowsVolumeInfo(result.stdout);
}

/**
 * Parse the output of `fsutil fsinfo drives`. Example:
 *
 *     Drives: C:\ D:\ E:\
 *
 * Returns uppercase drive letters (`C`, `D`, `E`).
 */
export function parseWindowsDrives(stdout: string): string[] {
  // Strip the optional "Drives:" prefix and any leading/trailing whitespace,
  // then split on whitespace. fsutil joins paths with single spaces.
  const tail = stdout.replace(/^Drives:\s*/i, '').trim();
  if (!tail) return [];
  const letters: string[] = [];
  for (const token of tail.split(/\s+/)) {
    const m = token.match(/^([A-Za-z]):/);
    if (m) letters.push(m[1].toUpperCase());
  }
  return letters;
}

/**
 * Enumerate Windows drive letters using `fsutil fsinfo drives`.
 * Returns an empty array on any failure (binary missing, timeout, parse error).
 */
export function listWindowsDriveLetters(
  runner: FsutilRunner,
  options: { timeoutMs?: number } = {},
): string[] {
  const timeout = options.timeoutMs ?? 2000;
  let result;
  try {
    result = runner.fsutil(['fsinfo', 'drives'], { timeout });
  } catch {
    return [];
  }
  if (result.error) return [];
  if (result.status === null || result.status !== 0) return [];
  return parseWindowsDrives(result.stdout);
}

/**
 * Surface this module needs from `fs`. Narrowed so tests can stub the
 * `statfsSync` call without touching the real `fs` module.
 */
export interface StatfsProvider {
  statfsSync(path: string): { bsize: number; bavail: number; blocks: number; bfree: number };
}

/**
 * Compute free bytes for `path` using `fs.statfsSync` — no subprocess.
 *
 * On Windows, `fs.statfsSync` returns the same fields as on POSIX; Node
 * fills them from `GetDiskFreeSpaceExW`. We multiply by `bsize` because
 * Node returns the values in fragments (clusters × sectors-per-cluster).
 * Returns `null` when the path is not statable so callers can fall back.
 *
 * ORAIN-0725: replaces the previous `logicaldisk where caption='X:' get
 * freespace` spawn — that binary no longer ships in Win11 24H2+.
 */
export function statfsFreeBytes(fs: StatfsProvider, path: string): number | null {
  try {
    const stats = fs.statfsSync(path);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * Side-effect wrapper that logs an error only the first time it is called.
 *
 * ORAIN-0725 / GitHub issue #23: when Windows drive detection fails
 * (e.g. `fsutil` is unavailable in some restricted environment), the
 * device-watcher polls every 15 s. Logging on every poll would fill the
 * log file with thousands of identical entries. This wrapper runs the
 * given side effect (typically `log.error(...)`) at most once per session.
 *
 * The flag is exposed so callers can reset it between polling generations
 * — in practice we never do, but it keeps the helper unit-testable.
 */
export function oncePerSession(state: { logged: boolean }, fn: () => void): void {
  if (state.logged) return;
  state.logged = true;
  fn();
}
