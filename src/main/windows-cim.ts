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

import { spawn } from 'child_process';

/** A single WMI `Win32_LogicalDisk` record after JSON parsing. */
export interface CimLogicalDisk {
  deviceId: string; // "C:" / "G:"
  driveType: number; // 2 removable, 3 local, 4 network, 5 optical
  filesystem: string; // "NTFS" / "FAT32" / "exFAT" / ""
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
 */
export function parseCimLogicalDisks(stdout: string): CimLogicalDisk[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: CimLogicalDisk[] = [];
  for (const item of parsed) {
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
}

/**
 * Render the device-list `displayName` for a Windows drive.
 * ORAIN-0758 AC4: v0.7.1 used `X:` (with the colon); the ORAIN-0757
 * call site passed `d.letter` alone and produced 'G' instead of 'G:'.
 * Exported so the consumer (index.ts) can use a single source of truth.
 */
export function formatWindowsDriveDisplayName(letter: string): string {
  return `${letter.toUpperCase()}:`;
}

const POWERSHELL_ENUMERATE = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,FileSystem | ConvertTo-Json -Compress',
];

const POWERSHELL_FILESYSTEM = (letter: string) => [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'").FileSystem`,
];

/** Default production runner — invokes the real `powershell.exe`. */
export const realCim: CimRunner = {
  powershell(args, options) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn('powershell.exe', args, { windowsHide: true });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({ status: null, stdout, stderr, error: new Error('timeout') });
      }, options.timeout);
      child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: null, stdout, stderr, error: err });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr });
      });
    });
  },
};

/**
 * Enumerate Windows drives via `Get-CimInstance Win32_LogicalDisk`.
 * Returns `[]` on any failure mode (binary missing, timeout, parse error).
 *
 * Filters `DriveType` to 2 (removable) and 3 (local) only — matches the
 * v0.7.1 behaviour and excludes network (4), optical (5), RAM disk (6),
 * no-root (1) and unknown (0).
 */
export async function listWindowsDrives(
  runner: CimRunner,
  options: { timeoutMs?: number } = {},
): Promise<WindowsDrive[]> {
  const timeout = options.timeoutMs ?? 5000;
  let result;
  try {
    result = await runner.powershell(POWERSHELL_ENUMERATE, { timeout });
  } catch {
    return [];
  }
  if (result.error) return [];
  if (result.status === null || result.status !== 0) return [];
  const disks = parseCimLogicalDisks(result.stdout);
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
      };
    });
}

/**
 * Detect the filesystem mounted at `driveLetter` using the WMI
 * `FileSystem` property. Returns `unknown` for any failure mode:
 *
 *   - `driveLetter` has no leading drive letter (UNC, POSIX, empty)
 *   - `powershell.exe` is not available (returns ENOENT)
 *   - PowerShell times out (5 s)
 *   - the returned value is not one of ntfs/fat32/exfat
 *
 * ORAIN-0758 AC3: the caller in src/main/index.ts passes a full path
 * ('C:\\Users\\user\\Music' or 'G:\\'), not just the letter. The
 * ORAIN-0757 regex `replace(/[^A-Z]/g, '')` stripped the separator and
 * concatenated every alpha into a wrong DeviceID ('CUSERSUSERMUSIC:'),
 * which WMI never matched and the probe returned `unknown`. Anchor the
 * extraction to the start of the path with `^([A-Za-z]):` so 'G:\\foo'
 * and 'g:/' both resolve to 'G', while UNC / POSIX paths return
 * `unknown` without invoking PowerShell.
 */
export async function detectWindowsFilesystem(
  runner: CimRunner,
  driveLetter: string,
  options: { timeoutMs?: number } = {},
): Promise<WindowsFilesystemLabel> {
  const match = /^([A-Za-z]):/.exec(driveLetter);
  const letter = match ? match[1]!.toUpperCase() : '';
  if (!letter) return 'unknown';
  const timeout = options.timeoutMs ?? 5000;
  let result;
  try {
    result = await runner.powershell(POWERSHELL_FILESYSTEM(letter), { timeout });
  } catch {
    return 'unknown';
  }
  if (result.error) return 'unknown';
  if (result.status === null || result.status !== 0) return 'unknown';
  const value = result.stdout.trim().toLowerCase();
  if (value === 'ntfs') return 'ntfs';
  if (value === 'fat32') return 'fat32';
  if (value === 'exfat') return 'exfat';
  return 'unknown';
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
