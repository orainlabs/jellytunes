/**
 * macOS filesystem detection for paths that are not volume roots (ORAIN-0746).
 *
 * The previous implementation in `src/main/index.ts` ran
 * `diskutil info <path>` directly. `diskutil info` only accepts a volume
 * identifier or a mount point — anything else returns "Could not find disk"
 * and the label falls back to `unknown`, leaving `sanitizePathComponent` a
 * no-op so filenames containing `:` `?` `"` reach the destination.
 *
 * Resolution path:
 *   1. `df -P <path>` resolves the actual mount point. The user can pick
 *      `/Volumes/STICK/Music` and we recover `/Volumes/STICK`. `-P` keeps
 *      the output in POSIX columns, but the mountpoint in column 6 can
 *      still contain spaces (`/Volumes/Macintosh HD`) — so we keep every
 *      trailing field instead of splitting on whitespace.
 *   2. `diskutil info <mount>` returns the personality (`File System
 *      Personality : APFS`, `MS-DOS (FAT32)`, `ExFAT`, `NTFS`, ...).
 *
 * Why two binaries instead of one:
 *   - `df -P` alone is not enough: macOS reports the *type* of the device
 *     differently per release (e.g. APFS snapshots appear as `apfs` but a
 *     DMG mount shows `hfs`), and we already centralize that mapping in
 *     `parseDiskutilFilesystem`.
 *   - `diskutil` alone fails for non-mount paths — the bug being fixed.
 *
 * The runners are injected (`DarwinFsRunner`) so tests stub the binaries
 * without forking. Mirrors the `windows-fsutil.ts` pattern.
 */

import { spawnSync } from 'child_process';

/** Filesystem labels the sync layer cares about for sanitization. */
export type DarwinFilesystemLabel = 'fat32' | 'exfat' | 'ntfs' | 'apfs' | 'hfs+' | 'unknown';

/**
 * Surface this module needs from `child_process`. Narrowed so tests can stub
 * `df` and `diskutil` without touching the real `spawnSync`.
 */
export interface DarwinFsRunner {
  df(
    args: string[],
    options: { timeout: number },
  ): {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  };
  diskutil(
    args: string[],
    options: { timeout: number },
  ): {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  };
}

/** Default production runner — calls the real `df` and `diskutil` binaries. */
export const realDarwinFs: DarwinFsRunner = {
  df(args, options) {
    const result = spawnSync('df', args, {
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
  diskutil(args, options) {
    const result = spawnSync('diskutil', args, {
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
 * Parse a single `df -P <path>` line.
 *
 * `df -P` output is a header + data lines; for our use case the user
 * supplied a single path so we expect a single data line:
 *
 *     Filesystem   512-blocks      Used Available Capacity  Mounted on
 *     /dev/disk1s5  779298768 591875152 101191136    86%    /System/Volumes/Data
 *
 * The mountpoint in column 6 can contain spaces (e.g. `/Volumes/Macintosh HD`),
 * so we keep every field from column 6 onwards as the mountpoint rather than
 * splitting on whitespace — that is the only way to disambiguate the
 * `<space>` in `/Volumes/Macintosh HD` from the column separator.
 *
 * Returns the resolved mountpoint, or empty string when the output is not
 * a `df -P` data line.
 */
export function parseDfMountpoint(stdout: string): string {
  // Drop the header line ("Filesystem   512-blocks ...").
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    // Header lines start with "Filesystem" — skip them.
    if (/^Filesystem\b/.test(line)) continue;
    // We need columns 1..5 + everything from 6 onwards (the mountpoint,
    // which may contain spaces). Use a regex anchored to column widths:
    // the first five whitespace-separated fields are fixed content.
    const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const mountpoint = m[6].trim();
    if (!mountpoint) continue;
    // `df` reports `df: <path>: No such file or directory` on stderr only;
    // stdout for a missing path is empty, so we just return ''.
    return mountpoint;
  }
  return '';
}

/**
 * Parse `diskutil info <mount>` output for the `File System Personality` line.
 *
 * Sample (APFS, captured on Darwin24.6.0 2026-09-28):
 *
 *     Device Node:               /dev/disk1s5
 *     Device Identifier:         disk1s5
 *     ...
 *     File System Personality:   APFS
 *     ...
 *
 * Returns the lowercase label, or `unknown` when no recognizable
 * filesystem is found. Pure: same input → same output.
 */
export function parseDiskutilFilesystem(stdout: string): DarwinFilesystemLabel {
  const match = stdout.match(/File System Personality\s*:\s*([^\r\n]+)/i);
  if (!match) return 'unknown';
  const t = match[1].trim().toLowerCase();
  // `diskutil` reports FAT32 sticks as `MS-DOS (FAT32)` (some releases:
  // `MS-DOS FAT32`); accept any FAT32 variant.
  if (t.includes('fat32') || t === 'ms-dos' || t === 'msdos' || t.startsWith('ms-dos')) {
    return 'fat32';
  }
  if (t.includes('exfat')) return 'exfat';
  if (t.includes('ntfs')) return 'ntfs';
  if (t.includes('apfs')) return 'apfs';
  if (t.includes('hfs')) return 'hfs+';
  return 'unknown';
}

/**
 * Detect the filesystem mounted at `devicePath` on macOS.
 *
 * Flow:
 *   1. `df -P <devicePath>` — resolve the actual mount point. `df` on macOS
 *      resolves symbolic links and turns `/Volumes/STICK/Music` into
 *      `/Volumes/STICK`, so the user's subdirectory picks up the stick's
 *      filesystem label.
 *   2. `diskutil info <mount>` — read the `File System Personality` line.
 *
 * Returns `unknown` for any failure mode:
 *   - `df` exits non-zero or times out (binary missing, permission denied)
 *   - the `df` output has no data line (path does not exist)
 *   - the resolved mountpoint is empty
 *   - `diskutil` exits non-zero or times out
 *   - the `diskutil` output has no recognizable personality
 *
 * Failures never throw: this is called from `detectFilesystem`, which
 * catches every error and returns `unknown` on its own. The 5 s and 2 s
 * timeouts match the previous `diskutil` call (5 s) and a tight budget for
 * the `df` step (2 s) so the two-binary chain never blocks the device
 * watcher longer than the old single-call implementation did.
 */
export function detectDarwinFilesystem(
  runner: DarwinFsRunner,
  devicePath: string,
  options: { dfTimeoutMs?: number; diskutilTimeoutMs?: number } = {},
): DarwinFilesystemLabel {
  const dfTimeout = options.dfTimeoutMs ?? 2000;
  let dfResult;
  try {
    dfResult = runner.df(['-P', devicePath], { timeout: dfTimeout });
  } catch {
    return 'unknown';
  }
  if (dfResult.error) return 'unknown';
  if (dfResult.status === null || dfResult.status !== 0) return 'unknown';

  const mountpoint = parseDfMountpoint(dfResult.stdout);
  if (!mountpoint) return 'unknown';

  const diskutilTimeout = options.diskutilTimeoutMs ?? 5000;
  let duResult;
  try {
    duResult = runner.diskutil(['info', mountpoint], { timeout: diskutilTimeout });
  } catch {
    return 'unknown';
  }
  if (duResult.error) return 'unknown';
  if (duResult.status === null || duResult.status !== 0) return 'unknown';

  return parseDiskutilFilesystem(duResult.stdout);
}
