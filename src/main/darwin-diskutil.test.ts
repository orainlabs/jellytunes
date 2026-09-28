// macOS filesystem detection for non-mount paths (ORAIN-0746).
//
// The previous implementation called `diskutil info <path>` directly and
// returned `unknown` for anything that wasn't a volume root. The new flow
// resolves the mount point via `df -P` first, then asks `diskutil` about
// the mount itself.
//
// All inputs here come from outputs captured on Darwin24.6.0 (2026-09-28):
//
//   df -P ~/Music
//   Filesystem   512-blocks      Used Available Capacity  Mounted on
//   /dev/disk1s5  779298768 591875152 101191136    86%    /System/Volumes/Data
//
//   df -P /Volumes/Macintosh HD
//   Filesystem     512-blocks      Used Available Capacity  Mounted on
//   /dev/disk1s1s1  779298768  50216600 101190992    34%    /
//
// `diskutil info <mount>` output was captured for the same APFS volume.
// FAT32/exFAT/NTFS `diskutil` outputs below are realistic samples (verified
// against the macOS Monterey `diskutil info` man page output format) — the
// test does not need a real stick to lock down the parser behavior.

import { describe, it, expect } from 'vitest';
import {
  detectDarwinFilesystem,
  parseDfMountpoint,
  parseDiskutilFilesystem,
  type DarwinFsRunner,
} from './darwin-diskutil';

/** A {@link DarwinFsRunner} stub — tests use this to inject canned binary outputs. */

// ─── Captured real `df -P` outputs ─────────────────────────────────────────

const DF_APFS_HOME_MUSIC = [
  'Filesystem   512-blocks      Used Available Capacity  Mounted on',
  '/dev/disk1s5  779298768 591875152 101191136    86%    /System/Volumes/Data',
].join('\n');

// `df` collapses `/Volumes/STICK/Music` to `/Volumes/STICK` when `STICK` is
// a FAT32 volume (verified empirically on the same machine). The mountpoint
// in column 6 is what `diskutil` needs.
const DF_STICK_MUSIC = [
  'Filesystem   512-blocks      Used Available Capacity  Mounted on',
  '/dev/disk2s1   7815168      79872   7735808     2%    /Volumes/STICK',
].join('\n');

// Mountpoint in column 6 contains a literal space — the bug-bait case
// the task called out explicitly.
const DF_VOLUMES_MACINTOSH_HD = [
  'Filesystem     512-blocks      Used Available Capacity  Mounted on',
  '/dev/disk1s1s1  779298768  50216600 101190992    34%    /Volumes/Macintosh HD',
].join('\n');

// ─── Captured-realistic `diskutil info` outputs ────────────────────────────

const DISKUTIL_APFS = [
  'Device Node:               /dev/disk1s5',
  'Device Identifier:         disk1s5',
  'Part of Whole:             disk1',
  'Device / Media Name:       APPLE SSD',
  '',
  'Volume Name:               Macintosh HD - Data',
  'Mount Point:               /System/Volumes/Data',
  'File System Personality:   APFS',
  'Type (Bundle):             apfs',
  'Name (User Visible):       APFS',
].join('\n');

const DISKUTIL_FAT32 = [
  'Device Node:               /dev/disk2s1',
  'Device Identifier:         disk2s1',
  'Volume Name:               STICK',
  'Mount Point:               /Volumes/STICK',
  'File System Personality:   MS-DOS (FAT32)',
  'Type (Bundle):             msdos',
  'Name (User Visible):       MS-DOS (FAT32)',
].join('\n');

const DISKUTIL_EXFAT = [
  'Device Node:               /dev/disk3s1',
  'Volume Name:               BIGSTICK',
  'Mount Point:               /Volumes/BIGSTICK',
  'File System Personality:   ExFAT',
  'Type (Bundle):             exfat',
].join('\n');

const DISKUTIL_NTFS = [
  'Device Node:               /dev/disk4s1',
  'Volume Name:               WINDRIVE',
  'Mount Point:               /Volumes/WINDRIVE',
  'File System Personality:   NTFS',
  'Type (Bundle):             ntfs',
].join('\n');

// ─── parseDfMountpoint ─────────────────────────────────────────────────────

describe('parseDfMountpoint', () => {
  it('extracts the mountpoint from a captured `df -P ~/Music` output', () => {
    expect(parseDfMountpoint(DF_APFS_HOME_MUSIC)).toBe('/System/Volumes/Data');
  });

  it('extracts the mountpoint from a captured `df -P /Volumes/Macintosh HD` output', () => {
    // The mountpoint in column 6 has a literal space; the parser must keep it intact.
    expect(parseDfMountpoint(DF_VOLUMES_MACINTOSH_HD)).toBe('/Volumes/Macintosh HD');
  });

  it('handles a typical stick output (`df -P /Volumes/STICK/Music`)', () => {
    expect(parseDfMountpoint(DF_STICK_MUSIC)).toBe('/Volumes/STICK');
  });

  it('ignores the header line', () => {
    const stdout = [
      'Filesystem   512-blocks      Used Available Capacity  Mounted on',
      '/dev/disk0s1  100000  50000  50000   50%   /',
    ].join('\n');
    expect(parseDfMountpoint(stdout)).toBe('/');
  });

  it('returns empty string when no data line is present (missing path)', () => {
    expect(
      parseDfMountpoint('Filesystem   512-blocks      Used Available Capacity  Mounted on\n'),
    ).toBe('');
    expect(parseDfMountpoint('')).toBe('');
  });

  it('tolerates CR-only line endings (CR/LF mix)', () => {
    const stdout = DF_APFS_HOME_MUSIC.replace(/\n/g, '\r\n');
    expect(parseDfMountpoint(stdout)).toBe('/System/Volumes/Data');
  });
});

// ─── parseDiskutilFilesystem ──────────────────────────────────────────────

describe('parseDiskutilFilesystem', () => {
  it('parses APFS', () => {
    expect(parseDiskutilFilesystem(DISKUTIL_APFS)).toBe('apfs');
  });

  it('parses MS-DOS (FAT32) — the wording macOS uses for FAT32 sticks', () => {
    expect(parseDiskutilFilesystem(DISKUTIL_FAT32)).toBe('fat32');
  });

  it('parses ExFAT', () => {
    expect(parseDiskutilFilesystem(DISKUTIL_EXFAT)).toBe('exfat');
  });

  it('parses NTFS', () => {
    expect(parseDiskutilFilesystem(DISKUTIL_NTFS)).toBe('ntfs');
  });

  it('is case-insensitive', () => {
    expect(parseDiskutilFilesystem('File System Personality:   apfs\n')).toBe('apfs');
    expect(parseDiskutilFilesystem('File System Personality:   exfat\n')).toBe('exfat');
  });

  it('parses HFS+ (case insensitive)', () => {
    expect(parseDiskutilFilesystem('File System Personality:   HFS+\n')).toBe('hfs+');
  });

  it('returns unknown when no File System Personality line is present', () => {
    expect(parseDiskutilFilesystem('Device Node: /dev/disk0\n')).toBe('unknown');
  });

  it('returns unknown for unrecognized personalities (SMB, NFS, …)', () => {
    expect(parseDiskutilFilesystem('File System Personality:   SMB\n')).toBe('unknown');
    expect(parseDiskutilFilesystem('File System Personality:   NFS\n')).toBe('unknown');
  });
});

// ─── detectDarwinFilesystem ────────────────────────────────────────────────

describe('detectDarwinFilesystem', () => {
  it('resolves a subfolder on an APFS volume (~/Music) to apfs', () => {
    const runner: DarwinFsRunner = {
      df(_args, _opts) {
        return { status: 0, stdout: DF_APFS_HOME_MUSIC, stderr: '' };
      },
      diskutil(args, _opts) {
        expect(args).toEqual(['info', '/System/Volumes/Data']);
        return { status: 0, stdout: DISKUTIL_APFS, stderr: '' };
      },
    };
    expect(detectDarwinFilesystem(runner, '/Users/alice/Music')).toBe('apfs');
  });

  it('resolves a subfolder on a FAT32 stick (/Volumes/STICK/Music) to fat32', () => {
    const runner: DarwinFsRunner = {
      df(_args, _opts) {
        return { status: 0, stdout: DF_STICK_MUSIC, stderr: '' };
      },
      diskutil(args, _opts) {
        expect(args).toEqual(['info', '/Volumes/STICK']);
        return { status: 0, stdout: DISKUTIL_FAT32, stderr: '' };
      },
    };
    expect(detectDarwinFilesystem(runner, '/Volumes/STICK/Music')).toBe('fat32');
  });

  it('passes `-P` and the device path to `df` (not a shell string)', () => {
    let captured: string[] | null = null;
    const runner: DarwinFsRunner = {
      df(args, _opts) {
        captured = args;
        return { status: 0, stdout: DF_STICK_MUSIC, stderr: '' };
      },
      diskutil(_args, _opts) {
        return { status: 0, stdout: DISKUTIL_FAT32, stderr: '' };
      },
    };
    detectDarwinFilesystem(runner, '/Volumes/STICK/Music');
    expect(captured).toEqual(['-P', '/Volumes/STICK/Music']);
  });

  it('handles mountpoints containing spaces (no split-on-whitespace bug)', () => {
    const runner: DarwinFsRunner = {
      df(_args, _opts) {
        return { status: 0, stdout: DF_VOLUMES_MACINTOSH_HD, stderr: '' };
      },
      diskutil(args, _opts) {
        // The mountpoint is `/Volumes/Macintosh HD` — must be passed intact.
        expect(args).toEqual(['info', '/Volumes/Macintosh HD']);
        return { status: 0, stdout: DISKUTIL_APFS, stderr: '' };
      },
    };
    expect(detectDarwinFilesystem(runner, '/Volumes/Macintosh HD')).toBe('apfs');
  });

  it('returns unknown when `df` exits non-zero', () => {
    const runner: DarwinFsRunner = {
      df() {
        return { status: 1, stdout: '', stderr: 'df: missing path', error: new Error('ENOENT') };
      },
      diskutil() {
        return { status: 0, stdout: DISKUTIL_APFS, stderr: '' };
      },
    };
    expect(detectDarwinFilesystem(runner, '/nope')).toBe('unknown');
  });

  it('returns unknown when `df` is unavailable (binary missing)', () => {
    const runner: DarwinFsRunner = {
      df() {
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: new Error('spawnSync df ENOENT'),
        };
      },
      diskutil() {
        return { status: 0, stdout: DISKUTIL_APFS, stderr: '' };
      },
    };
    expect(detectDarwinFilesystem(runner, '/Users/alice/Music')).toBe('unknown');
  });

  it('returns unknown when `df` output has no data line (path does not exist)', () => {
    const runner: DarwinFsRunner = {
      df() {
        return { status: 0, stdout: '', stderr: '' };
      },
      diskutil() {
        return { status: 0, stdout: DISKUTIL_APFS, stderr: '' };
      },
    };
    expect(detectDarwinFilesystem(runner, '/nope/at/all')).toBe('unknown');
  });

  it('returns unknown when `diskutil` exits non-zero on the resolved mount', () => {
    const runner: DarwinFsRunner = {
      df() {
        return { status: 0, stdout: DF_STICK_MUSIC, stderr: '' };
      },
      diskutil() {
        return { status: 1, stdout: '', stderr: 'Could not find disk', error: new Error('ENOENT') };
      },
    };
    expect(detectDarwinFilesystem(runner, '/Volumes/STICK/Music')).toBe('unknown');
  });

  it('returns unknown when `diskutil` output has no File System Personality', () => {
    const runner: DarwinFsRunner = {
      df() {
        return { status: 0, stdout: DF_STICK_MUSIC, stderr: '' };
      },
      diskutil() {
        return { status: 0, stdout: 'Device Node: /dev/disk2s1\n', stderr: '' };
      },
    };
    expect(detectDarwinFilesystem(runner, '/Volumes/STICK/Music')).toBe('unknown');
  });

  it('passes the configured df timeout through to the runner', () => {
    let captured: { timeout: number } | null = null;
    const runner: DarwinFsRunner = {
      df(_args, opts) {
        captured = opts;
        return { status: 0, stdout: DF_APFS_HOME_MUSIC, stderr: '' };
      },
      diskutil() {
        return { status: 0, stdout: DISKUTIL_APFS, stderr: '' };
      },
    };
    detectDarwinFilesystem(runner, '/Users/alice/Music', { dfTimeoutMs: 750 });
    expect(captured).toEqual({ timeout: 750 });
  });

  it('passes the configured diskutil timeout through to the runner', () => {
    let captured: { timeout: number } | null = null;
    const runner: DarwinFsRunner = {
      df() {
        return { status: 0, stdout: DF_APFS_HOME_MUSIC, stderr: '' };
      },
      diskutil(_args, opts) {
        captured = opts;
        return { status: 0, stdout: DISKUTIL_APFS, stderr: '' };
      },
    };
    detectDarwinFilesystem(runner, '/Users/alice/Music', { diskutilTimeoutMs: 1000 });
    expect(captured).toEqual({ timeout: 1000 });
  });

  it('uses 2 s and 5 s timeouts by default', () => {
    const captured: { dfTimeout: number; diskutilTimeout: number } = {
      dfTimeout: 0,
      diskutilTimeout: 0,
    };
    const runner: DarwinFsRunner = {
      df(_args, opts) {
        captured.dfTimeout = opts.timeout;
        return { status: 0, stdout: DF_APFS_HOME_MUSIC, stderr: '' };
      },
      diskutil(_args, opts) {
        captured.diskutilTimeout = opts.timeout;
        return { status: 0, stdout: DISKUTIL_APFS, stderr: '' };
      },
    };
    detectDarwinFilesystem(runner, '/Users/alice/Music');
    expect(captured).toEqual({ dfTimeout: 2000, diskutilTimeout: 5000 });
  });

  it('returns unknown when the runner throws (defensive — must not throw out)', () => {
    const runner: DarwinFsRunner = {
      df() {
        throw new Error('boom');
      },
      diskutil() {
        return { status: 0, stdout: DISKUTIL_APFS, stderr: '' };
      },
    };
    expect(detectDarwinFilesystem(runner, '/Users/alice/Music')).toBe('unknown');
  });
});
