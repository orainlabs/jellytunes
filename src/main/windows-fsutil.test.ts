// Windows volume detection without the pre-24H2 binary (ORAIN-0725 / GitHub issue #23).
//
// Replaces the previous `logicaldisk ...` spawn with `fsutil fsinfo volumeinfo <drive>:`,
// which ships in `C:\Windows\System32` on every Windows install — Windows 11
// 24H2+ removed that binary. The fsutil output format and the parser's tolerance
// for unexpected whitespace / line ordering are tested here against synthetic
// outputs so the test does not need a real Windows install.

import { describe, it, expect, vi } from 'vitest';
import {
  detectWindowsFilesystem,
  parseWindowsVolumeInfo,
  extractDriveLetter,
  parseWindowsDrives,
  listWindowsDriveLetters,
  statfsFreeBytes,
  oncePerSession,
  type FsutilRunner,
} from './windows-fsutil';

/** A {@link FsutilRunner} that returns canned output for a given drive letter. */
function fakeRunner(
  byDrive: Readonly<Record<string, { status: number; stdout: string }>>,
): FsutilRunner {
  return {
    fsutil(args, _options) {
      const drive = args[args.length - 1];
      const found = byDrive[drive];
      if (!found) {
        return {
          status: null,
          stdout: '',
          stderr: 'fake: drive not found',
          error: new Error('ENOENT'),
        };
      }
      return { status: found.status, stdout: found.stdout, stderr: '' };
    },
  };
}

const FAT32_OUTPUT = [
  'Volume Name : MUSIC',
  'Volume Serial Number : 0xABCD1234',
  'Max Component Length : 255',
  'File System Name : FAT32',
  'Supports Case-sensitive Names : false',
  'Preserves Case of Names : false',
].join('\r\n');

const EXFAT_OUTPUT = [
  'Volume Name : USB',
  'Volume Serial Number : 0x1234ABCD',
  'File System Name : EXFAT',
].join('\r\n');

const NTFS_OUTPUT = [
  'Volume Name : System',
  'Volume Serial Number : 0xDEADBEEF',
  'File System Name : NTFS',
].join('\r\n');

describe('parseWindowsVolumeInfo', () => {
  it('parses FAT32 from fsutil output', () => {
    expect(parseWindowsVolumeInfo(FAT32_OUTPUT)).toBe('fat32');
  });

  it('parses exFAT (case-insensitive)', () => {
    expect(parseWindowsVolumeInfo(EXFAT_OUTPUT)).toBe('exfat');
  });

  it('parses NTFS', () => {
    expect(parseWindowsVolumeInfo(NTFS_OUTPUT)).toBe('ntfs');
  });

  it('returns unknown when no File System Name line is present', () => {
    expect(parseWindowsVolumeInfo('Volume Name : foo\n')).toBe('unknown');
  });

  it('returns unknown for unrecognized filesystem labels (ReFS, CDFS, etc.)', () => {
    expect(parseWindowsVolumeInfo('File System Name : ReFS\n')).toBe('unknown');
    expect(parseWindowsVolumeInfo('File System Name : CDFS\n')).toBe('unknown');
  });

  it('tolerates extra spaces between the label and the colon', () => {
    expect(parseWindowsVolumeInfo('File System Name    :    FAT32\n')).toBe('fat32');
  });

  it('tolerates LF-only line endings (no CR)', () => {
    expect(parseWindowsVolumeInfo('File System Name : NTFS\nrest of stuff')).toBe('ntfs');
  });
});

describe('extractDriveLetter', () => {
  it.each([
    ['E:\\', 'E'],
    ['E:/', 'E'],
    ['E:', 'E'],
    ['e:\\Music', 'E'],
    ['e:/Music', 'E'],
    ['C:\\Users\\me\\Music', 'C'],
  ])('%s → %s', (input, expected) => {
    expect(extractDriveLetter(input)).toBe(expected);
  });

  it('returns empty string for paths without a drive letter', () => {
    expect(extractDriveLetter('')).toBe('');
    expect(extractDriveLetter('/mnt/usb')).toBe('');
    expect(extractDriveLetter('\\\\server\\share')).toBe('');
  });
});

describe('detectWindowsFilesystem', () => {
  it('detects FAT32 for a removable stick', () => {
    const runner = fakeRunner({ 'E:': { status: 0, stdout: FAT32_OUTPUT } });
    expect(detectWindowsFilesystem(runner, 'E:\\MUSIC')).toBe('fat32');
  });

  it('detects exFAT', () => {
    const runner = fakeRunner({ 'D:': { status: 0, stdout: EXFAT_OUTPUT } });
    expect(detectWindowsFilesystem(runner, 'D:\\USB')).toBe('exfat');
  });

  it('detects NTFS', () => {
    const runner = fakeRunner({ 'C:': { status: 0, stdout: NTFS_OUTPUT } });
    expect(detectWindowsFilesystem(runner, 'C:\\Windows')).toBe('ntfs');
  });

  it('returns unknown when the drive letter is missing', () => {
    const runner = fakeRunner({});
    expect(detectWindowsFilesystem(runner, '/Volumes/MUSIC')).toBe('unknown');
  });

  it('returns unknown when fsutil exits non-zero (the pre-24H2 binary ENOENT would behave the same)', () => {
    const runner: FsutilRunner = {
      fsutil() {
        return { status: 1, stdout: '', stderr: 'error', error: new Error('ENOENT') };
      },
    };
    expect(detectWindowsFilesystem(runner, 'E:\\')).toBe('unknown');
  });

  it('returns unknown when fsutil is not available (error reported)', () => {
    const runner: FsutilRunner = {
      fsutil() {
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: new Error('spawnSync fsutil ENOENT'),
        };
      },
    };
    expect(detectWindowsFilesystem(runner, 'E:\\')).toBe('unknown');
  });

  it('returns unknown when the output is unparseable', () => {
    const runner = fakeRunner({ 'E:': { status: 0, stdout: 'garbage\n' } });
    expect(detectWindowsFilesystem(runner, 'E:\\')).toBe('unknown');
  });

  it('passes a 2 s timeout to fsutil by default', () => {
    let captured: { timeout: number } | null = null;
    const runner: FsutilRunner = {
      fsutil(_args, options) {
        captured = options;
        return { status: 0, stdout: FAT32_OUTPUT, stderr: '' };
      },
    };
    detectWindowsFilesystem(runner, 'E:\\');
    expect(captured).toEqual({ timeout: 2000 });
  });

  it('respects a custom timeout override', () => {
    let captured: { timeout: number } | null = null;
    const runner: FsutilRunner = {
      fsutil(_args, options) {
        captured = options;
        return { status: 0, stdout: FAT32_OUTPUT, stderr: '' };
      },
    };
    detectWindowsFilesystem(runner, 'E:\\', { timeoutMs: 500 });
    expect(captured).toEqual({ timeout: 500 });
  });
});

describe('parseWindowsDrives', () => {
  it('parses the standard fsutil output', () => {
    expect(parseWindowsDrives('Drives: C:\\ D:\\ E:\\\n')).toEqual(['C', 'D', 'E']);
  });

  it('returns an empty array when the output is empty', () => {
    expect(parseWindowsDrives('')).toEqual([]);
    expect(parseWindowsDrives('Drives:\n')).toEqual([]);
  });

  it('is case-insensitive on the prefix', () => {
    expect(parseWindowsDrives('DRIVES: C:\\ D:\\\n')).toEqual(['C', 'D']);
  });

  it('uppercases drive letters', () => {
    expect(parseWindowsDrives('Drives: c:\\ d:\\\n')).toEqual(['C', 'D']);
  });
});

describe('listWindowsDriveLetters', () => {
  it('returns drive letters from the fsutil fsinfo drives output', () => {
    const runner = fakeRunner({ _: { status: 0, stdout: 'Drives: C:\\ D:\\ E:\\\n' } });
    // The fake key lookup happens on args[last], which is 'drives' here, not '_'.
    // Use a custom runner instead so we can stub on the literal "drives" key.
    const runner2: FsutilRunner = {
      fsutil(args, _options) {
        if (args[args.length - 1] === 'drives') {
          return { status: 0, stdout: 'Drives: C:\\ D:\\ E:\\\n', stderr: '' };
        }
        return { status: null, stdout: '', stderr: 'unexpected args' };
      },
    };
    expect(listWindowsDriveLetters(runner2)).toEqual(['C', 'D', 'E']);
    // Use runner to keep the variable referenced (no lint warning).
    expect(runner).toBeDefined();
  });

  it('returns an empty array when fsutil exits non-zero', () => {
    const runner: FsutilRunner = {
      fsutil() {
        return { status: 1, stdout: '', stderr: 'access denied' };
      },
    };
    expect(listWindowsDriveLetters(runner)).toEqual([]);
  });

  it('returns an empty array when fsutil is missing (ENOENT)', () => {
    const runner: FsutilRunner = {
      fsutil() {
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: new Error('spawnSync fsutil ENOENT'),
        };
      },
    };
    expect(listWindowsDriveLetters(runner)).toEqual([]);
  });
});

describe('statfsFreeBytes', () => {
  it('computes bavail * bsize', () => {
    const fs = { statfsSync: () => ({ bsize: 4096, bavail: 100, blocks: 1000, bfree: 200 }) };
    expect(statfsFreeBytes(fs, 'E:\\')).toBe(409600);
  });

  it('returns null when statfs throws', () => {
    const fs = {
      statfsSync: () => {
        throw new Error('ENOENT');
      },
    };
    expect(statfsFreeBytes(fs, 'X:\\')).toBeNull();
  });

  it('returns 0 when bavail is 0 (full disk)', () => {
    const fs = { statfsSync: () => ({ bsize: 4096, bavail: 0, blocks: 1000, bfree: 0 }) };
    expect(statfsFreeBytes(fs, 'E:\\')).toBe(0);
  });
});

describe('oncePerSession (AC4)', () => {
  it('runs the side effect on the first call', () => {
    const state = { logged: false };
    const fn = vi.fn();
    oncePerSession(state, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not run the side effect on subsequent calls', () => {
    const state = { logged: false };
    const fn = vi.fn();
    oncePerSession(state, fn);
    oncePerSession(state, fn);
    oncePerSession(state, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flips the flag even when the side effect itself throws', () => {
    // AC4: the device-watcher polls every 15 s. If the first failure was
    // allowed to keep retrying because the helper swallowed the throw, the
    // next poll would also try to log — defeating the dedup.
    const state = { logged: false };
    expect(() =>
      oncePerSession(state, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(state.logged).toBe(true);
    // Subsequent calls must not invoke fn again.
    const fn = vi.fn();
    oncePerSession(state, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('three failed polls in a row produce exactly one log.error (AC4)', () => {
    // AC4 explicit: 3 sondeos fallidos seguidos → exactamente 1 log.error.
    const logError = vi.fn();
    const state = { logged: false };
    for (let i = 0; i < 3; i++) {
      oncePerSession(state, () => logError(`poll ${i + 1} failed`));
    }
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith('poll 1 failed');
  });
});
