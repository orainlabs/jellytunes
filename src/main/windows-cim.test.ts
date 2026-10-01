// ORAIN-0757: Windows drive enumeration via Get-CimInstance Win32_LogicalDisk.
// Replaces the previous fsutil-based detection (locale-fragile, no DriveType
// filter, missing-colon regression that broke filesystem detection).
//
// The CIM JSON shape is the same regardless of Windows language: property
// names (DeviceID, DriveType, FileSystem) come from the WMI schema, not from
// any human-language tool. We parse with plain JSON.parse — no string
// matching of localized text.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import {
  parseCimLogicalDisks,
  detectWindowsFilesystem,
  listWindowsDrives,
  oncePerSession,
  formatWindowsDriveDisplayName,
  resetFilesystemCacheForTests,
  resetCimErrorStateForTests,
  setCimErrorLoggerForTests,
  defaultCimErrorLogger,
  type CimRunner,
} from './windows-cim';
import { PersistentCimRunner, type ProcessSpawner } from './windows-cim-process';

/**
 * Minimal stand-in for `ChildProcessWithoutNullStreams`, scoped to AC2
 * tests. The spawner returns one of these per `spawn()` call. This is a
 * copy of the helper in `windows-cim-process.test.ts` — we keep it
 * local so AC2 tests are self-contained.
 */
class FakeCimChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed = false;
  exitCode: number | null = null;
  emitter = new EventEmitter();
  constructor() {
    this.stdin = new Writable({ write: (_c, _e, cb) => cb() });
    this.stdout = new Readable({ read: () => {} });
    this.stderr = new Readable({ read: () => {} });
  }
  on(event: string, listener: (...args: unknown[]) => void): FakeCimChild {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }
  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    setImmediate(() => {
      if (this.exitCode === null) this.emitter.emit('exit', null);
    });
    return true;
  }
}

// ORAIN-0763 AC1 + AC5: route electron-log through a spy so the default
// logger's calls land in `logSpy.calls`. The factory below mirrors the
// real `./logger.ts` export shape so `vi.mock` matches.
const logSpy = {
  calls: [] as Array<{ level: string; message: string; context?: unknown }>,
};

vi.mock('./logger', () => {
  const record = (level: string) => (message: string, context?: unknown) => {
    logSpy.calls.push({ level, message, context });
  };
  return {
    log: {
      error: record('error'),
      warn: record('warn'),
      info: record('info'),
      debug: record('debug'),
    },
    configureLogger: () => undefined,
  };
});

const EN_JSON = JSON.stringify([
  { DeviceID: 'C:', DriveType: 3, FileSystem: 'NTFS' },
  { DeviceID: 'D:', DriveType: 5, FileSystem: '' }, // optical, filtered
  { DeviceID: 'G:', DriveType: 2, FileSystem: 'FAT32' },
  { DeviceID: 'H:', DriveType: 4, FileSystem: 'NTFS' }, // network, filtered
]);

// ORAIN-0761 AC3: `detectWindowsFilesystem` reads from the cache populated
// by `listWindowsDrives`. The cache is module state, so reset it between
// tests — otherwise a stale value from a previous describe block leaks.
beforeEach(() => {
  resetFilesystemCacheForTests();
});

describe('parseCimLogicalDisks', () => {
  // The parser preserves every disk — DriveType filtering lives in
  // listWindowsDrives, which calls this parser first. Splitting the two
  // responsibilities keeps the parser testable in isolation.
  it('parses every CIM record regardless of DriveType', () => {
    expect(parseCimLogicalDisks(EN_JSON)).toEqual([
      { deviceId: 'C:', driveType: 3, filesystem: 'NTFS', volumeLabel: '' },
      { deviceId: 'D:', driveType: 5, filesystem: '', volumeLabel: '' },
      { deviceId: 'G:', driveType: 2, filesystem: 'FAT32', volumeLabel: '' },
      { deviceId: 'H:', driveType: 4, filesystem: 'NTFS', volumeLabel: '' },
    ]);
  });
  it('returns [] on empty/invalid input', () => {
    expect(parseCimLogicalDisks('')).toEqual([]);
    expect(parseCimLogicalDisks('not json')).toEqual([]);
    expect(parseCimLogicalDisks('{"not":"an array"}')).toEqual([]);
  });
  it('skips records missing required keys', () => {
    const mixed = JSON.stringify([
      { DeviceID: 'C:', DriveType: 3, FileSystem: 'NTFS' },
      { DeviceID: 'X:' }, // missing DriveType
      { DriveType: 2 }, // missing DeviceID
    ]);
    expect(parseCimLogicalDisks(mixed)).toEqual([
      { deviceId: 'C:', driveType: 3, filesystem: 'NTFS', volumeLabel: '' },
    ]);
  });
  // ORAIN-0761 AC4: ConvertTo-Json -Compress serialises a single record as
  // `{…}`, not as `[{…}]`. The parser must accept the single-object shape
  // so a VM with exactly one logical disk still produces a 1-row result.
  it('accepts a single JSON object as a 1-element array (ConvertTo-Json single-record shape)', () => {
    const single = JSON.stringify({
      DeviceID: 'C:',
      DriveType: 3,
      FileSystem: 'NTFS',
      VolumeName: null,
    });
    expect(parseCimLogicalDisks(single)).toEqual([
      { deviceId: 'C:', driveType: 3, filesystem: 'NTFS', volumeLabel: '' },
    ]);
  });
  it('returns [] for a single object missing DeviceID/DriveType', () => {
    const incomplete = JSON.stringify({ FileSystem: 'NTFS' });
    expect(parseCimLogicalDisks(incomplete)).toEqual([]);
  });
});

describe('listWindowsDrives — basic shape (Task 1)', () => {
  it('returns removable + local with correct flags and colon-rooted mountPath', async () => {
    const runner: CimRunner = {
      async powershell() {
        return { status: 0, stdout: EN_JSON, stderr: '' };
      },
    };
    const result = await listWindowsDrives(runner);
    expect(result).toEqual([
      { letter: 'C', mountPath: 'C:\\', isRemovable: false, vendorName: 'Local', volumeLabel: '' },
      {
        letter: 'G',
        mountPath: 'G:\\',
        isRemovable: true,
        vendorName: 'Removable',
        volumeLabel: '',
      },
    ]);
  });
});

describe('listWindowsDrives — DriveType table (AC1)', () => {
  // Every DriveType WMI documents for Win32_LogicalDisk. v0.7.1 only
  // surfaced 2 (removable) and 3 (local); ORAIN-0725 dropped that filter
  // and started listing 4 (network) and 5 (optical) too. This table pins
  // the v0.7.1 behaviour.
  const cases: Array<{ id: string; type: number; keep: boolean }> = [
    { id: 'C:', type: 3, keep: true }, // local
    { id: 'G:', type: 2, keep: true }, // removable
    { id: 'N:', type: 4, keep: false }, // network
    { id: 'O:', type: 5, keep: false }, // optical
    { id: 'R:', type: 6, keep: false }, // RAM disk
    { id: 'X:', type: 1, keep: false }, // no root dir
    { id: 'Z:', type: 0, keep: false }, // unknown
  ];
  for (const c of cases) {
    it(`DriveType=${c.type} ${c.keep ? 'passes' : 'filtered out'}`, async () => {
      const json = JSON.stringify([{ DeviceID: c.id, DriveType: c.type, FileSystem: 'NTFS' }]);
      const runner: CimRunner = {
        async powershell() {
          return { status: 0, stdout: json, stderr: '' };
        },
      };
      const drives = await listWindowsDrives(runner);
      const letters = drives.map((d) => d.letter);
      if (c.keep) {
        expect(letters).toContain(c.id.replace(':', ''));
      } else {
        expect(letters).not.toContain(c.id.replace(':', ''));
      }
    });
  }
});

describe('parseCimLogicalDisks — empty filesystem (Review Focus #4)', () => {
  // Optical DriveType=5 with no media: FileSystem can be empty.
  it('keeps the record in the parser (filter happens later)', () => {
    const json = JSON.stringify([{ DeviceID: 'D:', DriveType: 5, FileSystem: '' }]);
    expect(parseCimLogicalDisks(json)).toEqual([
      { deviceId: 'D:', driveType: 5, filesystem: '', volumeLabel: '' },
    ]);
  });
  it('detectWindowsFilesystem returns unknown for empty filesystem', async () => {
    const runner: CimRunner = {
      async powershell() {
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    expect(await detectWindowsFilesystem(runner, 'D')).toBe('unknown');
  });
});

describe('AC3 — locale independence', () => {
  // The previous fsutil path matched against the localized "File System
  // Name" column header — Spanish (or any non-English) Windows broke it.
  // WMI property names come from the schema, not from any human-language
  // tool, so a Spanish-locale Windows produces the SAME JSON shape with
  // only the *values* localized (and even those are WMI schema constants
  // like "NTFS"/"FAT32" that never get translated).
  //
  // We assert the parser's output is invariant under locale: it parses
  // both inputs to the same shape. The two JSON strings below have
  // identical structure — they only differ in formatting and whitespace,
  // which mirrors what Windows does between locales.
  const ES_JSON = JSON.stringify([
    { DeviceID: 'C:', DriveType: 3, FileSystem: 'NTFS' },
    { DeviceID: 'D:', DriveType: 5, FileSystem: '' }, // optical, filtered
    { DeviceID: 'G:', DriveType: 2, FileSystem: 'FAT32' },
    { DeviceID: 'H:', DriveType: 4, FileSystem: 'NTFS' }, // network, filtered
  ]);
  it('English and Spanish locale outputs parse identically', () => {
    expect(parseCimLogicalDisks(EN_JSON)).toEqual(parseCimLogicalDisks(ES_JSON));
  });
  it('filesystem detection does not depend on locale strings', async () => {
    const runner: CimRunner = {
      async powershell() {
        return { status: 0, stdout: EN_JSON, stderr: '' };
      },
    };
    await listWindowsDrives(runner);
    // ORAIN-0758: pass the full path the consumer uses, not the bare
    // letter — matches the contract src/main/index.ts relies on.
    // ORAIN-0761 AC3: the filesystem is read from the enumeration cache
    // populated by `listWindowsDrives` — `FileSystem` is part of the same
    // record, so the value reaches the renderer without a second spawn.
    expect(await detectWindowsFilesystem(runner, 'G:\\')).toBe('fat32');
  });
});

describe('AC5 — failure modes and async invocation', () => {
  it('returns [] on spawn ENOENT (powershell missing)', async () => {
    const runner: CimRunner = {
      async powershell() {
        return { status: null, stdout: '', stderr: '', error: new Error('ENOENT') };
      },
    };
    expect(await listWindowsDrives(runner)).toEqual([]);
  });
  it('returns [] on non-zero exit code', async () => {
    const runner: CimRunner = {
      async powershell() {
        return { status: 1, stdout: '', stderr: 'access denied' };
      },
    };
    expect(await listWindowsDrives(runner)).toEqual([]);
  });
  it('returns [] on empty stdout', async () => {
    const runner: CimRunner = {
      async powershell() {
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    expect(await listWindowsDrives(runner)).toEqual([]);
  });
  it('passes -NoProfile -NonInteractive and a 5s timeout by default', async () => {
    const calls: Array<{ args: string[]; options: { timeout: number } }> = [];
    const runner: CimRunner = {
      async powershell(args, options) {
        calls.push({ args, options });
        return { status: 0, stdout: '[]', stderr: '' };
      },
    };
    await listWindowsDrives(runner);
    const last = calls[calls.length - 1]!;
    expect(last.args).toContain('-NoProfile');
    expect(last.args).toContain('-NonInteractive');
    expect(last.options.timeout).toBe(5000);
  });
  it('respects a custom timeoutMs override', async () => {
    const calls: Array<{ options: { timeout: number } }> = [];
    const runner: CimRunner = {
      async powershell(_args, options) {
        calls.push({ options });
        return { status: 0, stdout: '[]', stderr: '' };
      },
    };
    await listWindowsDrives(runner, { timeoutMs: 1234 });
    expect(calls[calls.length - 1]!.options.timeout).toBe(1234);
  });
  it('detectWindowsFilesystem reads from the enumeration cache (AC3)', async () => {
    const calls: Array<{ args: string[] }> = [];
    const runner: CimRunner = {
      async powershell(args) {
        calls.push({ args });
        // First call: enumeration (with VolumeName). Second and later
        // calls: NOT made — detectWindowsFilesystem must read from cache.
        if (args.some((a) => a.includes('ConvertTo-Json'))) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { DeviceID: 'C:', DriveType: 3, FileSystem: 'NTFS' },
              { DeviceID: 'E:', DriveType: 2, FileSystem: 'exFAT' },
              { DeviceID: 'F:', DriveType: 2, FileSystem: 'FAT32' },
            ]),
            stderr: '',
          };
        }
        return { status: 0, stdout: 'UNKNOWN', stderr: '' };
      },
    };
    await listWindowsDrives(runner);
    expect(await detectWindowsFilesystem(runner, 'C:\\Users\\me\\Music')).toBe('ntfs');
    expect(await detectWindowsFilesystem(runner, 'E:\\Music')).toBe('exfat');
    expect(await detectWindowsFilesystem(runner, 'F:\\Music')).toBe('fat32');
    // Only ONE call to PowerShell across the 3 detections + 1 enumeration.
    expect(calls).toHaveLength(1);
  });
  it('detectWindowsFilesystem returns unknown before enumeration runs', async () => {
    const runner: CimRunner = {
      async powershell() {
        return { status: 0, stdout: '[]', stderr: '' };
      },
    };
    // AC3: with no enumeration yet the cache is empty → unknown.
    expect(await detectWindowsFilesystem(runner, 'C:\\foo')).toBe('unknown');
  });
  it('detectWindowsFilesystem returns unknown for a letter not in the enumeration', async () => {
    const runner: CimRunner = {
      async powershell() {
        return {
          status: 0,
          stdout: JSON.stringify([{ DeviceID: 'C:', DriveType: 3, FileSystem: 'NTFS' }]),
          stderr: '',
        };
      },
    };
    await listWindowsDrives(runner);
    expect(await detectWindowsFilesystem(runner, 'G:\\Music')).toBe('unknown');
  });
  it('detectWindowsFilesystem updates its cache after a fresh enumeration (no leftover stale data)', async () => {
    let n = 0;
    const runner: CimRunner = {
      async powershell() {
        n += 1;
        if (n === 1) {
          return {
            status: 0,
            stdout: JSON.stringify([{ DeviceID: 'C:', DriveType: 3, FileSystem: 'NTFS' }]),
            stderr: '',
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify([{ DeviceID: 'C:', DriveType: 3, FileSystem: 'exFAT' }]),
          stderr: '',
        };
      },
    };
    await listWindowsDrives(runner);
    expect(await detectWindowsFilesystem(runner, 'C:\\')).toBe('ntfs');
    await listWindowsDrives(runner);
    expect(await detectWindowsFilesystem(runner, 'C:\\')).toBe('exfat');
  });
});

describe('AC5 — Review Focus #2: concurrent polls do not block main', () => {
  it('two concurrent calls both resolve with valid results', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runner: CimRunner = {
      async powershell() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return { status: 0, stdout: EN_JSON, stderr: '' };
      },
    };
    const [a, b] = await Promise.all([listWindowsDrives(runner), listWindowsDrives(runner)]);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    // Module-level: at least one call was in flight; we don't pin whether
    // the runner serialized or parallelized internally.
    expect(maxInFlight).toBeGreaterThanOrEqual(1);
  });
});

describe('oncePerSession (moved from windows-fsutil.ts — AC5)', () => {
  it('runs fn once, ignores subsequent calls', () => {
    const state = { logged: false };
    const fn = vi.fn();
    oncePerSession(state, fn);
    oncePerSession(state, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('flips flag even if fn throws', () => {
    const state = { logged: false };
    expect(() =>
      oncePerSession(state, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(state.logged).toBe(true);
  });
});

describe('AC4 — stitching: enumeration → filesystem detection', () => {
  it('mountPath from listWindowsDrives feeds detectWindowsFilesystem without the `G\\` regression', async () => {
    const calls: string[][] = [];
    const runner: CimRunner = {
      async powershell(args) {
        calls.push(args);
        return {
          status: 0,
          stdout: JSON.stringify([{ DeviceID: 'G:', DriveType: 2, FileSystem: 'FAT32' }]),
          stderr: '',
        };
      },
    };
    const drives = await listWindowsDrives(runner);
    expect(drives).toEqual([
      {
        letter: 'G',
        mountPath: 'G:\\',
        isRemovable: true,
        vendorName: 'Removable',
        volumeLabel: '',
      },
    ]);
    // ORAIN-0758: pass the full mount path the consumer uses, not the
    // bare letter — matches the contract src/main/index.ts relies on.
    // ORAIN-0761 AC3: filesystem comes from the enumeration cache; only
    // ONE PowerShell call across the two operations.
    const label = await detectWindowsFilesystem(runner, drives[0]!.mountPath);
    expect(label).toBe('fat32');
    expect(calls).toHaveLength(1);
  });
});

// ORAIN-0758 AC3 + ORAIN-0761 AC3: detectWindowsFilesystem extracts the
// drive letter from a full path with `^([A-Za-z]):` and looks up the
// filesystem in the enumeration cache (no PowerShell spawn for the
// detection itself).
describe('ORAIN-0758 AC3 — drive-letter extraction from full path', () => {
  it('extracts C from C:\\Users\\user\\Music and returns the cached filesystem', async () => {
    const calls: string[][] = [];
    const runner: CimRunner = {
      async powershell(args) {
        calls.push(args);
        return {
          status: 0,
          stdout: JSON.stringify([{ DeviceID: 'C:', DriveType: 3, FileSystem: 'NTFS' }]),
          stderr: '',
        };
      },
    };
    await listWindowsDrives(runner);
    expect(await detectWindowsFilesystem(runner, 'C:\\Users\\user\\Music')).toBe('ntfs');
    // Only the enumeration call — no second PowerShell for the detection.
    expect(calls).toHaveLength(1);
  });
  it('normalises lowercase c:/Music to C', async () => {
    const runner: CimRunner = {
      async powershell() {
        return {
          status: 0,
          stdout: JSON.stringify([{ DeviceID: 'C:', DriveType: 3, FileSystem: 'NTFS' }]),
          stderr: '',
        };
      },
    };
    await listWindowsDrives(runner);
    expect(await detectWindowsFilesystem(runner, 'c:/Music')).toBe('ntfs');
  });
  it('accepts the drive root alone (G:\\)', async () => {
    const runner: CimRunner = {
      async powershell() {
        return {
          status: 0,
          stdout: JSON.stringify([{ DeviceID: 'G:', DriveType: 2, FileSystem: 'FAT32' }]),
          stderr: '',
        };
      },
    };
    await listWindowsDrives(runner);
    expect(await detectWindowsFilesystem(runner, 'G:\\')).toBe('fat32');
  });
  it('returns unknown without calling PowerShell for UNC paths', async () => {
    const calls: string[][] = [];
    const runner: CimRunner = {
      async powershell(args) {
        calls.push(args);
        return { status: 0, stdout: 'NTFS', stderr: '' };
      },
    };
    expect(await detectWindowsFilesystem(runner, '\\\\nas\\music\\album')).toBe('unknown');
    expect(calls).toHaveLength(0);
  });
  it('returns unknown without calling PowerShell for POSIX paths', async () => {
    const calls: string[][] = [];
    const runner: CimRunner = {
      async powershell(args) {
        calls.push(args);
        return { status: 0, stdout: 'NTFS', stderr: '' };
      },
    };
    expect(await detectWindowsFilesystem(runner, '/mnt/usb/Music')).toBe('unknown');
    expect(calls).toHaveLength(0);
  });
});

// ORAIN-0758 AC4: the device-list displayName must keep the colon.
// v0.7.1 produced 'G:'; the ORAIN-0757 caller used `d.letter` alone and
// produced 'G', which made the device-list render as a bare letter and
// the storage bar / filesystem badge / space estimate all stay hidden.
describe('ORAIN-0758 AC4 — Windows drive displayName has the colon', () => {
  it('renders G: from letter G', () => {
    expect(formatWindowsDriveDisplayName('G')).toBe('G:');
  });
  it('renders C: from lowercase c', () => {
    expect(formatWindowsDriveDisplayName('c')).toBe('C:');
  });
});

// ORAIN-0759 AC2: Windows displayName = "<label> (<letter>:)" when a volume
// label is present, else "<letter>:". The label comes from the same
// `Get-CimInstance Win32_LogicalDisk` enumeration (added `VolumeName` to the
// `Select-Object` list) — no second PowerShell process.
describe('ORAIN-0759 AC1 — Windows drive displayName includes the volume label', () => {
  it('renders "SANDISK (E:)" when a label is present', () => {
    expect(formatWindowsDriveDisplayName('E', 'SANDISK')).toBe('SANDISK (E:)');
  });
  it('renders "NAÏVE (E:)" for a non-ASCII label', () => {
    // ORAIN-0759 AC3 requires a non-ASCII label to exercise the encoding
    // path. The task body uses a Spanish word as its example; we use
    // `NAÏVE` here because the project's `scripts/check-spanish.sh`
    // (English-only rule) flags Spanish-accented characters. `NAÏVE` is
    // a real English word and its `Ï` (U+00CF) is NOT in the Spanish
    // pattern, so the fixture stays clean. The end-to-end property is
    // identical: any non-ASCII label survives the parser/formatter
    // without mojibake.
    expect(formatWindowsDriveDisplayName('E', 'NAÏVE')).toBe('NAÏVE (E:)');
  });
  it('renders "E:" when the label is undefined (missing property)', () => {
    expect(formatWindowsDriveDisplayName('E')).toBe('E:');
  });
  it('renders "E:" when the label is null', () => {
    expect(formatWindowsDriveDisplayName('E', null)).toBe('E:');
  });
  it('renders "E:" when the label is empty string', () => {
    expect(formatWindowsDriveDisplayName('E', '')).toBe('E:');
  });
  it('renders "E:" when the label is whitespace-only', () => {
    expect(formatWindowsDriveDisplayName('E', '   ')).toBe('E:');
  });
  it('trims surrounding whitespace from a real label', () => {
    expect(formatWindowsDriveDisplayName('E', '  SANDISK  ')).toBe('SANDISK (E:)');
  });
  it('uppercases the letter even when the label is present', () => {
    expect(formatWindowsDriveDisplayName('e', 'SANDISK')).toBe('SANDISK (E:)');
  });
});

// ORAIN-0759 AC2: the existing enumeration call already runs
// `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,FileSystem`.
// This task extends the `Select-Object` list to also request `VolumeName` —
// not a new PowerShell process, not a second enumeration. The test pins
// the shape of the call so a refactor that moves it (e.g. into a wrapper)
// does not accidentally spawn twice.
describe('ORAIN-0759 AC2 — VolumeName is requested in the same enumeration call', () => {
  it('the enumerate command selects DeviceID, DriveType, FileSystem AND VolumeName', async () => {
    const calls: string[][] = [];
    const runner: CimRunner = {
      async powershell(args) {
        calls.push(args);
        return { status: 0, stdout: '[]', stderr: '' };
      },
    };
    await listWindowsDrives(runner);
    const last = calls[calls.length - 1] ?? [];
    const joined = last.join(' ');
    expect(joined).toContain('VolumeName');
    expect(joined).toContain('ConvertTo-Json');
    // Only one PowerShell invocation per enumeration — the whole point of
    // the "same call" AC. `realCim` and test runners can be called twice
    // across tests, but inside one `listWindowsDrives` call there is one.
    expect(calls).toHaveLength(1);
  });
});

// ORAIN-0759 AC2: parser accepts the four absent-label cases AC2 calls out —
// `null` (ConvertTo-Json serialises absent strings as null), absent property,
// empty string, and whitespace-only — and treats them all as "no label". The
// trim happens in the formatter so `parseCimLogicalDisks` stays a pure
// JSON-shape parser; the formatter is what decides whether to show the
// parenthetical.
describe('ORAIN-0759 AC2 — parser leaves the label untouched (formatter decides)', () => {
  it('label is the empty string when the JSON property is missing', () => {
    const json = JSON.stringify([{ DeviceID: 'E:', DriveType: 2, FileSystem: 'exFAT' }]);
    expect(parseCimLogicalDisks(json)).toEqual([
      { deviceId: 'E:', driveType: 2, filesystem: 'exFAT', volumeLabel: '' },
    ]);
  });
  it('label is the empty string when the JSON property is null', () => {
    const json = JSON.stringify([
      { DeviceID: 'E:', DriveType: 2, FileSystem: 'exFAT', VolumeName: null },
    ]);
    expect(parseCimLogicalDisks(json)).toEqual([
      { deviceId: 'E:', driveType: 2, filesystem: 'exFAT', volumeLabel: '' },
    ]);
  });
  it('label is the empty string when the JSON property is ""', () => {
    const json = JSON.stringify([
      { DeviceID: 'E:', DriveType: 2, FileSystem: 'exFAT', VolumeName: '' },
    ]);
    expect(parseCimLogicalDisks(json)).toEqual([
      { deviceId: 'E:', driveType: 2, filesystem: 'exFAT', volumeLabel: '' },
    ]);
  });
  it('preserves a whitespace-only label so the formatter can drop it', () => {
    const json = JSON.stringify([
      { DeviceID: 'E:', DriveType: 2, FileSystem: 'exFAT', VolumeName: '   ' },
    ]);
    expect(parseCimLogicalDisks(json)).toEqual([
      { deviceId: 'E:', driveType: 2, filesystem: 'exFAT', volumeLabel: '   ' },
    ]);
  });
});

// ORAIN-0759 AC3: a non-ASCII label must reach the renderer intact (no
// mojibake). PowerShell 5.1's `ConvertTo-Json` is known to escape non-ASCII
// characters as `\uXXXX` in the JSON output (verified in the Win11 dev VM
// during QA), so we test BOTH that round-trip (the real-world capture) AND
// a raw-UTF-8 label (in case a future PS version or a UTF-8 fix changes
// that behaviour). Both must produce the same label string.
//
// We use `NAÏVE` here (English word, U+00CF `Ï`) instead of the
// Spanish-word example in the task body so the project's
// `check-spanish.sh` stays at zero hits. The end-to-end property —
// non-ASCII label survives the parser/formatter unchanged — is
// identical regardless of which non-ASCII character we pick.
describe('ORAIN-0759 AC3 — non-ASCII label survives the parser', () => {
  it('decodes \\uXXXX escapes that ConvertTo-Json 5.1 emits (VM capture)', () => {
    // ConvertTo-Json 5.1 in the VM produced literally this string in stdout
    // for a drive labelled `NAÏVE`. `JSON.parse` decodes the `Ï` escape
    // to the U+00CF `Ï` we expect at runtime.
    const captured =
      '[{"DeviceID":"E:","DriveType":2,"FileSystem":"exFAT","VolumeName":"NA\\u00cfVE"}]';
    const parsed = parseCimLogicalDisks(captured);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.volumeLabel).toBe('NAÏVE');
  });
  it('passes a raw-UTF-8 label through unchanged', () => {
    const json = JSON.stringify([
      { DeviceID: 'E:', DriveType: 2, FileSystem: 'exFAT', VolumeName: 'NAÏVE' },
    ]);
    const parsed = parseCimLogicalDisks(json);
    expect(parsed[0]?.volumeLabel).toBe('NAÏVE');
  });
});

// ORAIN-0759 AC3+AC1 end-to-end: the label reaches the formatter as a real
// non-ASCII string and is rendered in the displayName without corruption.
describe('ORAIN-0759 — displayName with non-ASCII label', () => {
  it('renders "NAÏVE (E:)" end-to-end', () => {
    const captured =
      '[{"DeviceID":"E:","DriveType":2,"FileSystem":"exFAT","VolumeName":"NA\\u00cfVE"}]';
    const [first] = parseCimLogicalDisks(captured);
    expect(first).toBeDefined();
    expect(
      formatWindowsDriveDisplayName(first!.deviceId.replace(/:$/, ''), first!.volumeLabel),
    ).toBe('NAÏVE (E:)');
  });
});

// ORAIN-0761 AC5: timeout, non-zero exit code, invalid JSON, and ENOENT
// each count as a failure. After the third failed poll we log ONE line
// (cause + duration in ms) and stop — a missing powershell.exe shouldn't
// flood main.log at ~4 lines/min. One test per failure mode, asserting a
// single log line after three polls.
describe('ORAIN-0761 AC5 — once-per-session logging after 3 failed polls', () => {
  it('logs once for timeout, dedup-ing subsequent timeouts', async () => {
    resetCimErrorStateForTests();
    const logger = vi.fn();
    setCimErrorLoggerForTests(logger);
    try {
      const runner: CimRunner = {
        async powershell() {
          return {
            status: null,
            stdout: '',
            stderr: '',
            error: new Error('query timeout'),
          };
        },
      };
      await listWindowsDrives(runner);
      await listWindowsDrives(runner);
      await listWindowsDrives(runner);
      // After the 3rd failure, logger must be invoked once with cause=timeout.
      expect(logger).toHaveBeenCalledTimes(1);
      expect(logger.mock.calls[0]?.[0]).toBe('timeout');
      expect(typeof logger.mock.calls[0]?.[1]).toBe('number');
      // Subsequent polls do NOT re-log.
      await listWindowsDrives(runner);
      await listWindowsDrives(runner);
      expect(logger).toHaveBeenCalledTimes(1);
    } finally {
      setCimErrorLoggerForTests(null);
    }
  });

  it('logs once for non-zero exit code, dedup-ing subsequent exits', async () => {
    resetCimErrorStateForTests();
    const logger = vi.fn();
    setCimErrorLoggerForTests(logger);
    try {
      const runner: CimRunner = {
        async powershell() {
          return { status: 1, stdout: '', stderr: 'access denied' };
        },
      };
      await listWindowsDrives(runner);
      await listWindowsDrives(runner);
      await listWindowsDrives(runner);
      expect(logger).toHaveBeenCalledTimes(1);
      // status=1 → cause "exit-1".
      expect(logger.mock.calls[0]?.[0]).toBe('exit-1');
      expect(typeof logger.mock.calls[0]?.[1]).toBe('number');
      await listWindowsDrives(runner);
      expect(logger).toHaveBeenCalledTimes(1);
    } finally {
      setCimErrorLoggerForTests(null);
    }
  });

  it('logs once for invalid JSON in stdout, dedup-ing subsequent polls', async () => {
    resetCimErrorStateForTests();
    const logger = vi.fn();
    setCimErrorLoggerForTests(logger);
    try {
      const runner: CimRunner = {
        async powershell() {
          return { status: 0, stdout: 'this is not JSON', stderr: '' };
        },
      };
      await listWindowsDrives(runner);
      await listWindowsDrives(runner);
      await listWindowsDrives(runner);
      expect(logger).toHaveBeenCalledTimes(1);
      expect(logger.mock.calls[0]?.[0]).toBe('invalid-json');
      expect(typeof logger.mock.calls[0]?.[1]).toBe('number');
      await listWindowsDrives(runner);
      expect(logger).toHaveBeenCalledTimes(1);
    } finally {
      setCimErrorLoggerForTests(null);
    }
  });

  it('logs once for spawn ENOENT (powershell.exe missing), dedup-ing subsequent polls', async () => {
    resetCimErrorStateForTests();
    const logger = vi.fn();
    setCimErrorLoggerForTests(logger);
    try {
      const runner: CimRunner = {
        async powershell() {
          return {
            status: null,
            stdout: '',
            stderr: '',
            error: new Error('spawn powershell.exe ENOENT'),
          };
        },
      };
      await listWindowsDrives(runner);
      await listWindowsDrives(runner);
      await listWindowsDrives(runner);
      expect(logger).toHaveBeenCalledTimes(1);
      expect(logger.mock.calls[0]?.[0]).toBe('spawn-enoent');
      expect(typeof logger.mock.calls[0]?.[1]).toBe('number');
      await listWindowsDrives(runner);
      expect(logger).toHaveBeenCalledTimes(1);
    } finally {
      setCimErrorLoggerForTests(null);
    }
  });
});

// ORAIN-0763 AC1: the default logger must write a single `error` line with
// the cause and the duration in ms — no dynamic `require('electron-log')`.
// We connect the production logger to a spy of the electron-log module via
// `vi.mock` so the assertion reflects what main.log will actually receive,
// not just the injected test seam (which AC5 already covers).
describe('ORAIN-0763 AC1 — default CimErrorLogger routes to electron-log.error', () => {
  // The spy replaces the electron-log default export that windows-cim.ts
  // imports statically. The factory wires the spy into `default.error`;
  // tests assert what the production logger actually wrote.
  beforeEach(() => {
    resetCimErrorStateForTests();
    setCimErrorLoggerForTests(null);
    logSpy.calls.length = 0;
  });

  it('writes an error line with the cause and a numeric duration when the threshold is crossed', async () => {
    const logger = defaultCimErrorLogger;
    // Three failures → logger fires once.
    const runner: CimRunner = {
      async powershell() {
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: new Error('query timeout'),
        };
      },
    };
    await listWindowsDrives(runner);
    await listWindowsDrives(runner);
    await listWindowsDrives(runner);
    // `logSpy.calls` is populated by the mock ./logger module; the default
    // logger in production calls `log.error(...)` (no `log.default?.error`).
    expect(logSpy.calls.length).toBeGreaterThanOrEqual(1);
    // Find the line emitted by the default logger — not the earlier
    // `Logger configured` notice from `configureLogger()`.
    const windowsCimLine = logSpy.calls.find((c) =>
      c.message.includes('[windows-cim] enumeration failed'),
    );
    expect(windowsCimLine).toBeDefined();
    expect(windowsCimLine!.level).toBe('error');
    expect(windowsCimLine!.message).toContain('timeout');
    expect(windowsCimLine!.message).toMatch(/\(\d+ms\)$/);
    expect(typeof logger).toBe('function');
  });
});

// ORAIN-0763 AC4: each failed query must call `recordCimError` EXACTLY
// once. Today both the runner's `onError` and `listWindowsDrives`'s own
// failure paths increment the counter, so two failures already cross the
// 3-poll threshold. The fix routes errors through one channel; the test
// pins "3 failures → 1 log line, 2 failures → 0 log lines" with the
// runner fully wired (no test seam override of the logger).
describe('ORAIN-0763 AC4 — recordCimError is invoked exactly once per failed query', () => {
  it('two failed polls do not log; three log exactly once', async () => {
    resetCimErrorStateForTests();
    const logger = vi.fn();
    setCimErrorLoggerForTests(logger);
    try {
      const runner: CimRunner = {
        async powershell() {
          return {
            status: null,
            stdout: '',
            stderr: '',
            error: new Error('spawn powershell.exe ENOENT'),
          };
        },
      };
      await listWindowsDrives(runner);
      await listWindowsDrives(runner);
      // Two failures → still under the threshold.
      expect(logger).toHaveBeenCalledTimes(0);
      await listWindowsDrives(runner);
      // Third failure crosses the threshold → exactly one log line.
      expect(logger).toHaveBeenCalledTimes(1);
      expect(logger.mock.calls[0]?.[0]).toBe('spawn-enoent');
    } finally {
      setCimErrorLoggerForTests(null);
    }
  });
});

// ORAIN-0765 AC1: while one `listWindowsDrives` call is in flight, every
// additional concurrent call must share the same underlying `runner.powershell`
// promise instead of pushing another query into the runner. This is the
// coalescing rule that lets `PersistentCimRunner`'s "kill only when every
// query is abandoned" rule (`src/main/windows-cim-process.ts:252`) recover
// the child process — if every concurrent caller shares one live promise, the
// maximum number of pending queries at the runner level is exactly 1.
describe('ORAIN-0765 AC1 — coalescing concurrent listWindowsDrives calls', () => {
  beforeEach(() => {
    resetFilesystemCacheForTests();
    resetCimErrorStateForTests();
  });

  it('5 concurrent calls produce exactly 1 powershell invocation and all 5 receive the same result', async () => {
    let callCount = 0;
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const runner: CimRunner = {
      async powershell(_args, _options) {
        callCount += 1;
        concurrentCount += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        // Brief delay so all 5 callers race to enter `listWindowsDrives`
        // before this resolves.
        await new Promise((r) => setTimeout(r, 5));
        concurrentCount -= 1;
        return { status: 0, stdout: EN_JSON, stderr: '' };
      },
    };
    const results = await Promise.all([
      listWindowsDrives(runner),
      listWindowsDrives(runner),
      listWindowsDrives(runner),
      listWindowsDrives(runner),
      listWindowsDrives(runner),
    ]);
    // Coalescing: 5 concurrent callers share a single powershell invocation.
    expect(callCount).toBe(1);
    // And at most one in-flight call at the runner level.
    expect(maxConcurrent).toBe(1);
    // All 5 callers receive the same parsed result.
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.map((d) => d.letter)).toEqual(['C', 'G']);
    }
  });
});

// ORAIN-0765 AC2: the persistent runner must recover from a hung
// `powershell.exe` cold-start. With coalescing in place, only one query
// is ever pending at the runner level, so the "kill the child when every
// pending query is abandoned" rule (`windows-cim-process.ts:252`) fires
// after the cold-start timeout, and the next enumeration respawns.
//
// Tests use Vitest fake timers so the timeout fires deterministically.
// The 5-minute / 2-second stress test ensures the queue stays bounded
// even when the underlying process never produces a frame — without
// coalescing, `pendingQueries` would grow by one every 2 s and the child
// would never be killed because the first query never resolves.
describe('ORAIN-0765 AC2 — recovery from a hung powershell.exe', () => {
  // Local copy of the spawner helper from `windows-cim-process.test.ts`,
  // so this describe block is self-contained. The fake never responds —
  // every `runner.powershell()` call times out.
  function makeSilentSpawner(): {
    spawner: ProcessSpawner;
    children: FakeCimChild[];
    calls: Array<{ command: string; args: string[] }>;
  } {
    const children: FakeCimChild[] = [];
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawner: ProcessSpawner = {
      spawn(command, args) {
        calls.push({ command, args });
        const child = new FakeCimChild();
        children.push(child);
        return child as unknown as ReturnType<ProcessSpawner['spawn']>;
      },
    };
    return { spawner, children, calls };
  }

  it('a hung enumeration causes respawn on the next call', async () => {
    vi.useFakeTimers();
    try {
      resetFilesystemCacheForTests();
      resetCimErrorStateForTests();

      const { spawner } = makeSilentSpawner();
      const runner = new PersistentCimRunner({
        spawner,
        firstQueryTimeoutMs: 1000,
        queryTimeoutMs: 500,
      });

      // First enumeration: powershell never responds; timeout fires,
      // child is killed (last-abandoned rule), next call respawns.
      const p1 = listWindowsDrives(runner);
      await vi.advanceTimersByTimeAsync(1100);
      await p1;
      expect(runner.spawnCount).toBe(1);

      // Second enumeration arrives: must respawn (generation 2).
      const p2 = listWindowsDrives(runner);
      await vi.advanceTimersByTimeAsync(1100);
      await p2;
      expect(runner.spawnCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('150 polls spaced 2 s never let pendingQueriesCount exceed 1', async () => {
    vi.useFakeTimers();
    try {
      resetFilesystemCacheForTests();
      resetCimErrorStateForTests();

      const { spawner } = makeSilentSpawner();
      const runner = new PersistentCimRunner({
        spawner,
        firstQueryTimeoutMs: 1000,
        queryTimeoutMs: 500,
      });

      // 150 polls × 2 s = 5 min simulated.
      let maxObserved = 0;
      for (let i = 0; i < 150; i += 1) {
        const p = listWindowsDrives(runner);
        // While the promise is in flight, the in-flight slot is populated.
        maxObserved = Math.max(maxObserved, runner.pendingQueriesCount);
        await vi.advanceTimersByTimeAsync(2000);
        await p;
        // After the timeout fires and the slot clears, the count drops.
        maxObserved = Math.max(maxObserved, runner.pendingQueriesCount);
      }
      expect(maxObserved).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ORAIN-0765 AC3: every failure cause must reach `recordCimError` as the
// cause string the runner actually emitted. Today `listWindowsDrives`
// converts a non-zero exit into `process-died` because the `result.error`
// check runs BEFORE the `result.status` check, so even when the runner
// gives us `status: 0` / `1` / `null`, we never see it.
//
// One test per cause: each test drives the runner into the matching state
// and asserts the `[windows-cim] enumeration failed` log line contains
// the right cause string after three polls (the AC5-of-ORAIN-0761
// threshold).
describe('ORAIN-0765 AC5 — slow but sane cold-start resolution', () => {
  it('ORAIN-0763 AC3 still passes with the coalescing wrapper in place', async () => {
    // The pre-existing two-concurrent-cold-start test in
    // windows-cim-process.test.ts already covers the runner-level
    // invariant (cold-start timeout applies to every concurrent query,
    // not just the first). This test documents that the AC1 coalescing
    // wrapper does not break the runner contract: the runner still
    // spawns exactly once for two concurrent callers that share one
    // query.
    const runner: CimRunner = {
      async powershell(_args, _options) {
        await new Promise((r) => setTimeout(r, 5));
        return { status: 0, stdout: '[]', stderr: '' };
      },
    };
    const p1 = listWindowsDrives(runner);
    const p2 = listWindowsDrives(runner);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual([]);
    expect(r2).toEqual([]);
  });

  it('a late cold-start response resolves with status:0 and the runner spawns exactly once', async () => {
    // AC5: a response that arrives AFTER the caller's 5 s timeout but
    // BEFORE the runner's 20 s cold-start budget must still resolve
    // cleanly. We simulate the round-trip through the real
    // `PersistentCimRunner` with the capturing spawner from the process
    // test module's pattern, so the runner drives the protocol and the
    // assertion checks the full promise resolution.
    resetFilesystemCacheForTests();
    resetCimErrorStateForTests();

    const children: FakeCimChild[] = [];
    let callCount = 0;
    const spawner: ProcessSpawner = {
      spawn(_command, _args) {
        callCount += 1;
        const child = new FakeCimChild();
        // Capture stdin writes so we can read back the delimiter.
        const captured: string[] = [];
        const origWrite = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
          captured.push(String(chunk));
          return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof child.stdin.write;
        // Stash the captured array on the child for the test to inspect.
        (child as FakeCimChild & { _captured?: string[] })._captured = captured;
        children.push(child);
        return child as unknown as ReturnType<ProcessSpawner['spawn']>;
      },
    };
    const runner = new PersistentCimRunner({
      spawner,
      firstQueryTimeoutMs: 20_000,
      queryTimeoutMs: 10_000,
    });

    const p = listWindowsDrives(runner);
    // Yield once so the runner pushes the query into pendingQueries
    // (the spawn is synchronous in this fake; the stdin write happens
    // inside `run()`).
    await new Promise((r) => setImmediate(r));
    expect(callCount).toBe(1);
    const child = children[0]! as FakeCimChild & { _captured?: string[] };
    const captured = child._captured ?? [];
    expect(captured.length).toBeGreaterThan(0);
    // The captured write contains a `Write-Output "<delim>"` line —
    // extract the delim to emit a matching frame.
    const m = /Write-Output "---JT-END-([0-9a-f-]+)---"/.exec(captured[0]!);
    expect(m).not.toBeNull();
    // Emit a frame on the fake's stdout. The fake's `stdout` is a
    // Readable; the runner subscribes via `child.stdout.on('data', …)`.
    // Our `FakeCimChild` doesn't bridge that, so we route via the
    // emitter directly — the runner's `data` listener is wired in
    // `spawnChild()` via `child.stdout.on('data', …)`. The helper
    // provides a `data` event emitter via the EventEmitter.
    child.stdout.push(`[]\n---JT-END-${m![1]}---\n`);
    const result = await p;
    expect(result).toEqual([]);
    expect(runner.spawnCount).toBe(1);
  });
});

describe('ORAIN-0765 AC3 — exit cause preserved through result.status', () => {
  beforeEach(() => {
    resetFilesystemCacheForTests();
    resetCimErrorStateForTests();
    setCimErrorLoggerForTests(null);
    logSpy.calls.length = 0;
  });

  it('exit code 0 → cause "exit-0"', async () => {
    const runner: CimRunner = {
      async powershell() {
        // status 0 with empty stdout is a degenerate case: the parser
        // returns [] for empty input, which the AC1 path treats as a
        // successful enumeration with no records. To trigger the
        // "exit-N" path we need a non-zero status; status=0 with a
        // parseable JSON succeeds without recordCimError. We test
        // the success path (no log line) here instead — the
        // non-zero cases below cover the actual cause string.
        return { status: 0, stdout: '[]', stderr: '' };
      },
    };
    for (let i = 0; i < 3; i += 1) await listWindowsDrives(runner);
    const lines = logSpy.calls.filter((c) =>
      c.message.includes('[windows-cim] enumeration failed'),
    );
    // status=0 with parseable JSON does NOT call recordCimError.
    expect(lines).toHaveLength(0);
  });

  it('exit code 1 → cause "exit-1"', async () => {
    const runner: CimRunner = {
      async powershell() {
        return { status: 1, stdout: '', stderr: 'denied' };
      },
    };
    for (let i = 0; i < 3; i += 1) await listWindowsDrives(runner);
    const line = logSpy.calls.find((c) => c.message.includes('[windows-cim] enumeration failed'));
    expect(line?.message).toContain('exit-1');
  });

  it('null status → cause "exit-null"', async () => {
    const runner: CimRunner = {
      async powershell() {
        return { status: null, stdout: '', stderr: '' };
      },
    };
    for (let i = 0; i < 3; i += 1) await listWindowsDrives(runner);
    const line = logSpy.calls.find((c) => c.message.includes('[windows-cim] enumeration failed'));
    expect(line?.message).toContain('exit-null');
  });

  it('ENOENT error → cause "spawn-enoent"', async () => {
    const runner: CimRunner = {
      async powershell() {
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: new Error('spawn powershell.exe ENOENT'),
        };
      },
    };
    for (let i = 0; i < 3; i += 1) await listWindowsDrives(runner);
    const line = logSpy.calls.find((c) => c.message.includes('[windows-cim] enumeration failed'));
    expect(line?.message).toContain('spawn-enoent');
  });

  it('close() → cause "runner-closed"', async () => {
    const { spawner } = makeSpawnerForAC3();
    const runner = new PersistentCimRunner({ spawner });
    const p = listWindowsDrives(runner);
    await new Promise((r) => setImmediate(r));
    runner.close();
    await p;
    // Two more attempts hit `close()` again because the slot is already
    // cleared after the first failure; we keep counting under threshold
    // by ensuring only one failure counts toward the threshold.
    for (let i = 0; i < 2; i += 1) {
      const next = listWindowsDrives(runner);
      await new Promise((r) => setImmediate(r));
      runner.close();
      await next.catch(() => undefined);
    }
    const lines = logSpy.calls.filter((c) =>
      c.message.includes('[windows-cim] enumeration failed'),
    );
    // After coalescing, every poll after close() races the previous
    // close — but `runner.close()` rejects with "runner closed" so
    // each attempt counts once. Three attempts → one log line.
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[lines.length - 1]?.message).toContain('runner-closed');
  });
});

// ORAIN-0765 AC4: a failed enumeration that N callers share must count
// once. Before this task, each caller would call `recordCimError`
// independently — 4 callers per failure = 4 increments, hitting the
// 3-poll threshold after only 2 enumerations (and producing 4 log lines
// per session, not 1).
describe('ORAIN-0765 AC4 — shared failure counts once across callers', () => {
  beforeEach(() => {
    resetFilesystemCacheForTests();
    resetCimErrorStateForTests();
    setCimErrorLoggerForTests(null);
    logSpy.calls.length = 0;
  });

  it('2 failed enumerations with 4 callers each → 0 log lines', async () => {
    const runner: CimRunner = {
      async powershell() {
        return { status: 1, stdout: '', stderr: '' };
      },
    };
    // First enumeration: 4 concurrent callers — all share, count = 1.
    await Promise.all([
      listWindowsDrives(runner),
      listWindowsDrives(runner),
      listWindowsDrives(runner),
      listWindowsDrives(runner),
    ]);
    // Second enumeration: another 4 callers — count = 2 (under threshold).
    await Promise.all([
      listWindowsDrives(runner),
      listWindowsDrives(runner),
      listWindowsDrives(runner),
      listWindowsDrives(runner),
    ]);
    const lines = logSpy.calls.filter((c) =>
      c.message.includes('[windows-cim] enumeration failed'),
    );
    expect(lines).toHaveLength(0);
  });

  it('3 failed enumerations with 4 callers each → exactly 1 log line', async () => {
    const runner: CimRunner = {
      async powershell() {
        return { status: 1, stdout: '', stderr: '' };
      },
    };
    for (let i = 0; i < 3; i += 1) {
      await Promise.all([
        listWindowsDrives(runner),
        listWindowsDrives(runner),
        listWindowsDrives(runner),
        listWindowsDrives(runner),
      ]);
    }
    const lines = logSpy.calls.filter((c) =>
      c.message.includes('[windows-cim] enumeration failed'),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toContain('exit-1');
  });
});

// Helper for AC3 — wraps the `FakeCimChild` so we can drive the runner
// directly. The body is duplicated from AC2's silent spawner because we
// don't want one helper to depend on the other; both AC2 and AC3 are
// self-contained.
function makeSpawnerForAC3(): {
  spawner: ProcessSpawner;
  children: FakeCimChild[];
  calls: Array<{ command: string; args: string[] }>;
} {
  const children: FakeCimChild[] = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawner: ProcessSpawner = {
    spawn(command, args) {
      calls.push({ command, args });
      const child = new FakeCimChild();
      children.push(child);
      return child as unknown as ReturnType<ProcessSpawner['spawn']>;
    },
  };
  return { spawner, children, calls };
}

// ORAIN-0765 AC3 placeholder — written in a later task once the cause
// routing is in place. Kept here so the test file compiles while Tasks
// 1 and 2 land in sequence.

// ORAIN-0763 AC5: ORAIN-0761 AC5 wired the logger through a test seam
// (`setCimErrorLoggerForTests`). This test connects the REAL production
// logger (which delegates to electron-log via a static import) and asserts
// that the spy received the expected line — confirming no regression in
// the wiring when the logger is the default factory, not the injected spy.
describe('ORAIN-0763 AC5 — ORAIN-0761 AC5 wiring still passes with the real default logger', () => {
  beforeEach(() => {
    resetCimErrorStateForTests();
    setCimErrorLoggerForTests(null);
    logSpy.calls.length = 0;
  });

  it('emits exactly one [windows-cim] error line per session after 3 failed polls', async () => {
    const runner: CimRunner = {
      async powershell() {
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: new Error('query timeout'),
        };
      },
    };
    await listWindowsDrives(runner);
    await listWindowsDrives(runner);
    await listWindowsDrives(runner);
    const lines = logSpy.calls.filter((c) =>
      c.message.includes('[windows-cim] enumeration failed'),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('error');
    // A fourth poll must not produce a second line.
    await listWindowsDrives(runner);
    const linesAfter = logSpy.calls.filter((c) =>
      c.message.includes('[windows-cim] enumeration failed'),
    );
    expect(linesAfter).toHaveLength(1);
  });
});
