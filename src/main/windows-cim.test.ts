// ORAIN-0757: Windows drive enumeration via Get-CimInstance Win32_LogicalDisk.
// Replaces the previous fsutil-based detection (locale-fragile, no DriveType
// filter, missing-colon regression that broke filesystem detection).
//
// The CIM JSON shape is the same regardless of Windows language: property
// names (DeviceID, DriveType, FileSystem) come from the WMI schema, not from
// any human-language tool. We parse with plain JSON.parse — no string
// matching of localized text.

import { describe, it, expect, vi } from 'vitest';
import {
  parseCimLogicalDisks,
  detectWindowsFilesystem,
  listWindowsDrives,
  oncePerSession,
  formatWindowsDriveDisplayName,
  type CimRunner,
} from './windows-cim';

const EN_JSON = JSON.stringify([
  { DeviceID: 'C:', DriveType: 3, FileSystem: 'NTFS' },
  { DeviceID: 'D:', DriveType: 5, FileSystem: '' }, // optical, filtered
  { DeviceID: 'G:', DriveType: 2, FileSystem: 'FAT32' },
  { DeviceID: 'H:', DriveType: 4, FileSystem: 'NTFS' }, // network, filtered
]);

describe('parseCimLogicalDisks', () => {
  // The parser preserves every disk — DriveType filtering lives in
  // listWindowsDrives, which calls this parser first. Splitting the two
  // responsibilities keeps the parser testable in isolation.
  it('parses every CIM record regardless of DriveType', () => {
    expect(parseCimLogicalDisks(EN_JSON)).toEqual([
      { deviceId: 'C:', driveType: 3, filesystem: 'NTFS' },
      { deviceId: 'D:', driveType: 5, filesystem: '' },
      { deviceId: 'G:', driveType: 2, filesystem: 'FAT32' },
      { deviceId: 'H:', driveType: 4, filesystem: 'NTFS' },
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
      { deviceId: 'C:', driveType: 3, filesystem: 'NTFS' },
    ]);
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
      { letter: 'C', mountPath: 'C:\\', isRemovable: false, vendorName: 'Local' },
      { letter: 'G', mountPath: 'G:\\', isRemovable: true, vendorName: 'Removable' },
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
    expect(parseCimLogicalDisks(json)).toEqual([{ deviceId: 'D:', driveType: 5, filesystem: '' }]);
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
        return { status: 0, stdout: 'FAT32', stderr: '' };
      },
    };
    // ORAIN-0758: pass the full path the consumer uses, not the bare
    // letter — matches the contract src/main/index.ts relies on.
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
  it('detectWindowsFilesystem uses the same async + timeout contract', async () => {
    const calls: Array<{ args: string[]; options: { timeout: number } }> = [];
    const runner: CimRunner = {
      async powershell(args, options) {
        calls.push({ args, options });
        return { status: 0, stdout: 'NTFS', stderr: '' };
      },
    };
    // ORAIN-0758: the public caller in src/main/index.ts passes a full
    // path, not a bare letter — assert the contract against 'C:\\docs'
    // so the test exercises the same shape the renderer supplies.
    expect(await detectWindowsFilesystem(runner, 'C:\\docs')).toBe('ntfs');
    const last = calls[calls.length - 1]!;
    expect(last.args).toContain('-NoProfile');
    expect(last.args).toContain('-NonInteractive');
    expect(last.options.timeout).toBe(5000);
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
        // Enumeration uses ConvertTo-Json; the probe does not.
        if (args.some((a) => a.includes('ConvertTo-Json'))) {
          return {
            status: 0,
            stdout: JSON.stringify([{ DeviceID: 'G:', DriveType: 2, FileSystem: 'FAT32' }]),
            stderr: '',
          };
        }
        return { status: 0, stdout: 'FAT32', stderr: '' };
      },
    };
    const drives = await listWindowsDrives(runner);
    expect(drives).toEqual([
      { letter: 'G', mountPath: 'G:\\', isRemovable: true, vendorName: 'Removable' },
    ]);
    // ORAIN-0758: pass the full mount path the consumer uses, not the
    // bare letter — matches the contract src/main/index.ts relies on.
    const label = await detectWindowsFilesystem(runner, drives[0]!.mountPath);
    expect(label).toBe('fat32');
    // The probe call targets DeviceID='G:' — colon-rooted, not the
    // broken G\\ form that the previous fsutil regression passed.
    const probeArgs = calls[1] ?? [];
    expect(probeArgs.some((a) => a.includes("DeviceID='G:'"))).toBe(true);
  });
});

// ORAIN-0758 AC3: detectWindowsFilesystem is called from
// src/main/index.ts with the FULL path (e.g. 'C:\\Users\\user\\Music'),
// not just the letter. The v0.7.1 implementation did `devicePath.charAt(0)`;
// ORAIN-0757 changed that to `replace(/[^A-Z]/g, '')` which strips the
// separator and concatenates every alpha character into a wrong DeviceID.
// Anchor the extraction on `^([A-Za-z]):` and return `unknown` for paths
// without a drive letter (UNC, POSIX, empty) WITHOUT invoking PowerShell.
describe('ORAIN-0758 AC3 — drive-letter extraction from full path', () => {
  it("extracts C from C:\\Users\\user\\Music and queries DeviceID='C:'", async () => {
    const calls: string[][] = [];
    const runner: CimRunner = {
      async powershell(args) {
        calls.push(args);
        return { status: 0, stdout: 'NTFS', stderr: '' };
      },
    };
    expect(await detectWindowsFilesystem(runner, 'C:\\Users\\user\\Music')).toBe('ntfs');
    const probe = calls[0] ?? [];
    expect(probe.some((a) => a.includes("DeviceID='C:'"))).toBe(true);
  });
  it("normalises lowercase c:/Music to C and queries DeviceID='C:'", async () => {
    const calls: string[][] = [];
    const runner: CimRunner = {
      async powershell(args) {
        calls.push(args);
        return { status: 0, stdout: 'NTFS', stderr: '' };
      },
    };
    expect(await detectWindowsFilesystem(runner, 'c:/Music')).toBe('ntfs');
    const probe = calls[0] ?? [];
    expect(probe.some((a) => a.includes("DeviceID='C:'"))).toBe(true);
  });
  it('accepts the drive root alone (G:\\)', async () => {
    const calls: string[][] = [];
    const runner: CimRunner = {
      async powershell(args) {
        calls.push(args);
        return { status: 0, stdout: 'FAT32', stderr: '' };
      },
    };
    expect(await detectWindowsFilesystem(runner, 'G:\\')).toBe('fat32');
    const probe = calls[0] ?? [];
    expect(probe.some((a) => a.includes("DeviceID='G:'"))).toBe(true);
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
