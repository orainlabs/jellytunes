/**
 * Tests for temp file path construction (issue #3)
 *
 * Hardcoded /tmp/ paths fail on Windows — the OS interprets them as C:\tmp\
 * which doesn't exist, causing ENOENT on every FLAC→MP3 conversion attempt.
 * Paths must be built with os.tmpdir() so they resolve correctly on all platforms.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildTempPaths, buildConvertTempPath, buildCopyTrackTempPath } from './temp-path';
import { tmpdir } from 'os';
import { join } from 'path';

describe('buildTempPaths', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses os.tmpdir() as the base directory', () => {
    const { sourcePath, tempPath } = buildTempPaths('Track One', 123456789);
    expect(sourcePath.startsWith(tmpdir())).toBe(true);
    expect(tempPath.startsWith(tmpdir())).toBe(true);
  });

  it('uses os.tmpdir() as base — not a hardcoded string', () => {
    // The real bug was /tmp/ hardcoded as a string literal.
    // We verify the path starts with whatever tmpdir() returns on this OS
    // (e.g. /tmp on Linux, C:\Users\...\Temp on Windows).
    const { sourcePath, tempPath } = buildTempPaths('Track One', 123456789);
    expect(sourcePath.startsWith(tmpdir())).toBe(true);
    expect(tempPath.startsWith(tmpdir())).toBe(true);
  });

  it('includes the timestamp in both paths for uniqueness', () => {
    const ts = 1711620000000;
    const { sourcePath, tempPath } = buildTempPaths('Song', ts);
    expect(sourcePath).toContain(String(ts));
    expect(tempPath).toContain(String(ts));
  });

  it('sanitizes special characters from the track name', () => {
    const { tempPath } = buildTempPaths('AC/DC: Back in Black!', 1);
    // No slashes, colons or exclamation marks in the filename
    const filename = tempPath.split(/[\\/]/).pop()!;
    expect(filename).not.toMatch(/[/:!]/);
  });

  it('returns distinct paths for source and converted output', () => {
    const { sourcePath, tempPath } = buildTempPaths('Track', 1);
    expect(sourcePath).not.toBe(tempPath);
  });

  it('produced paths are joinable with path.join without double separators', () => {
    const { sourcePath, tempPath } = buildTempPaths('Track', 1);
    // Reconstructing via join should yield the same path
    const dir = tmpdir();
    const srcFile = sourcePath.replace(dir, '').replace(/^[\\/]/, '');
    const tmpFile = tempPath.replace(dir, '').replace(/^[\\/]/, '');
    expect(join(dir, srcFile)).toBe(sourcePath);
    expect(join(dir, tmpFile)).toBe(tempPath);
  });
});

describe('buildConvertTempPath', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ORAIN-0732 AC3: the temp file used for conversion MUST live under
  // os.tmpdir(), never next to the destination (USB drive). This protects
  // against (1) FAT32/exFAT wear, (2) crash leftovers visible to music
  // players, (3) Windows MAX_PATH on FAT32, (4) Snap confinement blocks.
  it('AC3: returns a path under os.tmpdir() (not next to the destination)', () => {
    const dest = '/Volumes/USB/Music/Artist/Album/01 - Track.mp3';
    const path = buildConvertTempPath('flac', 1700000000000);
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(path.startsWith(dest)).toBe(false);
  });

  // ORAIN-0732 AC4: only emit a recognised audio extension. Unknown formats,
  // empty values, or values not in ALL_AUDIO_EXTENSIONS must yield a bare
  // temp path (no extension) so FFmpeg falls back to content-sniffing.
  it('AC4: appends .flac when track.format is a known audio extension', () => {
    expect(buildConvertTempPath('flac', 1)).toMatch(/\.flac$/);
    expect(buildConvertTempPath('M4A', 1)).toMatch(/\.m4a$/);
    expect(buildConvertTempPath('.mp3', 1)).toMatch(/\.mp3$/);
  });

  it('AC4: returns no extension for unknown / unsafe formats', () => {
    // 'xyz' is well-formed but not in ALL_AUDIO_EXTENSIONS — must drop it.
    const p1 = buildConvertTempPath('xyz', 1);
    expect(p1).not.toMatch(/\.xyz$/);
    // Empty / whitespace — must drop.
    const p2 = buildConvertTempPath('', 1);
    expect(p2).not.toMatch(/\.[a-z0-9]+$/);
    const p3 = buildConvertTempPath('   ', 1);
    expect(p3).not.toMatch(/\.[a-z0-9]+$/);
    // Comma list — spec says take the first value.
    expect(buildConvertTempPath('mp3,mp4', 1)).not.toMatch(/\.mp4$/);
    // Path-traversal shaped strings must never become extensions.
    expect(buildConvertTempPath('../etc/passwd', 1)).not.toMatch(/\.\.\/etc\/passwd$/);
  });

  it('AC4: comma list keeps the first known extension', () => {
    // 'flac,mp3' — first value is flac (known) → .flac
    expect(buildConvertTempPath('flac,mp3', 1)).toMatch(/\.flac$/);
    // 'unknown,flac' — first value is unknown → no extension
    expect(buildConvertTempPath('unknown,flac', 1)).not.toMatch(/\.flac$/);
  });

  it('produces distinct paths across calls (timestamp + random suffix)', () => {
    const a = buildConvertTempPath('flac', 1700000000000);
    const b = buildConvertTempPath('flac', 1700000000001);
    expect(a).not.toBe(b);
  });
});

// ORAIN-0737 AC2: copy-track temp path must live under os.tmpdir() (never
// next to the destination USB) and follow the same extension rule as
// buildConvertTempPath. The filename prefix differs (`jt-copy_` vs
// `jellytunes_conv_`) so debugging can tell the two paths apart in
// `os.tmpdir()` listings.
describe('buildCopyTrackTempPath', () => {
  it('lives under os.tmpdir() and never next to the destination', () => {
    const dest = '/Volumes/USB/Music/Artist/Album/01 - Track.mp3';
    const p = buildCopyTrackTempPath('mp3', 1700000000000);
    expect(p.startsWith(tmpdir())).toBe(true);
    expect(p.startsWith(dest)).toBe(false);
  });

  it('appends .mp3 when track.format is a known audio extension', () => {
    expect(buildCopyTrackTempPath('mp3', 1)).toMatch(/\.mp3$/);
    expect(buildCopyTrackTempPath('FLAC', 1)).toMatch(/\.flac$/);
    expect(buildCopyTrackTempPath('.ogg', 1)).toMatch(/\.ogg$/);
  });

  it('returns no extension for unknown / unsafe formats', () => {
    expect(buildCopyTrackTempPath('xyz', 1)).not.toMatch(/\.xyz$/);
    expect(buildCopyTrackTempPath('', 1)).not.toMatch(/\.[a-z0-9]+$/);
    expect(buildCopyTrackTempPath('   ', 1)).not.toMatch(/\.[a-z0-9]+$/);
    expect(buildCopyTrackTempPath('mp3,mp4', 1)).not.toMatch(/\.mp4$/);
    expect(buildCopyTrackTempPath('../etc/passwd', 1)).not.toMatch(/\.\.\/etc\/passwd$/);
  });

  it('comma list keeps the first known extension', () => {
    expect(buildCopyTrackTempPath('flac,mp3', 1)).toMatch(/\.flac$/);
    expect(buildCopyTrackTempPath('unknown,flac', 1)).not.toMatch(/\.flac$/);
  });

  it('produces distinct paths across calls (timestamp + random suffix)', () => {
    const a = buildCopyTrackTempPath('mp3', 1700000000000);
    const b = buildCopyTrackTempPath('mp3', 1700000000001);
    expect(a).not.toBe(b);
  });
});
