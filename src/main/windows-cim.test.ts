// ORAIN-0757: Windows drive enumeration via Get-CimInstance Win32_LogicalDisk.
// Replaces the previous fsutil-based detection (locale-fragile, no DriveType
// filter, missing-colon regression that broke filesystem detection).
//
// The CIM JSON shape is the same regardless of Windows language: property
// names (DeviceID, DriveType, FileSystem) come from the WMI schema, not from
// any human-language tool. We parse with plain JSON.parse — no string
// matching of localized text.

import { describe, it, expect } from 'vitest';
import {
  parseCimLogicalDisks,
  detectWindowsFilesystem,
  listWindowsDrives,
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
