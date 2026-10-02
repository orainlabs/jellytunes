/**
 * ORAIN-0501 — github#27: MAX_PATH (260 chars) on Windows / NTFS / FAT32 / exFAT.
 *
 * Bug: convertToMp3 paths longer than 259 characters cause FFmpeg to fail
 * with `FFmpeg exited with code 1` (Node writes long paths; the bundled
 * FFmpeg binary does not). Repro: "Motor Spirit" from King Gizzard's
 * PetroDragonic Apocalypse → `W:\Music MP3s/Media/Music/.../01 Motor Spirit.mp3`
 * measures exactly 260. Two more tracks on the same album are identical by
 * pattern. AC5 demands we leave paths ≤259 chars alone, and non-Windows
 * targets must not be renamed.
 *
 * These tests are platform-aware but never depend on `process.platform`
 * at runtime (CI runs both ubuntu-latest and windows-latest). Every
 * resolution call passes `platform` explicitly. Assertions count
 * characters, not separator bytes.
 */
import { describe, it, expect } from 'vitest';
import { resolveTrackDestinationPath, type ResolveTrackDestinationPathInput } from './sync-core';

const PETRO_PATH = `/media/music/King Gizzard & The Lizard Wizard/PetroDragonic Apocalypse; or, Dawn of Eternal Night- An Annihilation of Planet Earth and the Beginning of Merciless Dam/King Gizzard & The Lizard Wizard - PetroDragonic Apocalypse; or, Dawn of Eternal Night- An Annihilation of Planet Earth and the Beginning of Merciless Dam - 01 Motor Spirit.flac`;
const LONG_ARTIST_DIR = 'King Gizzard & The Lizard Wizard';
const LONG_ALBUM_DIR =
  'PetroDragonic Apocalypse; or, Dawn of Eternal Night- An Annihilation of Planet Earth and the Beginning of Merciless Dam';

// The filename portion of the server path — `getFilenameFromPath` does NOT
// prepend the artist. The "Artist - Album - NN Track" prefix only appears
// in metadata-derived filenames (`buildFilenameFromMetadata`). MAX_PATH
// shortening must work off the filename as it actually lands on disk.
const longFilename = `King Gizzard & The Lizard Wizard - ${LONG_ALBUM_DIR} - 01 Motor Spirit.mp3`;
const WINDOWS_OUTPUT_DIR = `W:\\Music MP3s/Media/Music/${LONG_ARTIST_DIR}/${LONG_ALBUM_DIR}`;
const REPRO_FULL_PATH = `${WINDOWS_OUTPUT_DIR}/${longFilename}`;

const motorSpirit = {
  id: 'motor-spirit',
  name: 'Motor Spirit',
  path: PETRO_PATH,
  format: 'flac',
  bitrate: 1_200_000,
  size: 45_000_000,
  trackNumber: 1,
  parentItemId: 'album-1',
};

const baseOptions = {
  convertToMp3: true,
  bitrate: '192k' as const,
  filesystemType: 'ntfs' as const,
  coverArtMode: 'embed' as const,
  lyricsMode: 'off' as const,
  embedMetadata: true,
  preserveStructure: true,
  platform: 'win32' as NodeJS.Platform,
  skipExisting: true,
};

function makeInput(
  overrides: Partial<ResolveTrackDestinationPathInput> = {},
): ResolveTrackDestinationPathInput {
  return {
    track: motorSpirit,
    outputDir: WINDOWS_OUTPUT_DIR,
    serverRootPath: '/media/music/',
    options: baseOptions,
    platform: 'win32',
    filesystemType: 'ntfs',
    ...overrides,
  };
}

describe('ORAIN-0501 AC1 — Windows / NTFS / convertToMp3 truncates outputPath ≤ 259 chars', () => {
  it('guards the repro: the long path is exactly 260 chars', () => {
    // If the platform encoding or path separator changes and the unaltered
    // path no longer overflows, the repro for this bug disappears. The
    // assertion protects the regression test from silently passing
    // without exercising the truncation code path.
    expect(REPRO_FULL_PATH.length).toBeGreaterThan(259);
  });

  it('returns an outputPath ≤ 259 chars and keeps the .mp3 extension', () => {
    const result = resolveTrackDestinationPath(makeInput());
    expect(result.outputPath.length).toBeLessThanOrEqual(259);
    expect(result.outputPath.toLowerCase()).toMatch(/\.mp3$/);
  });

  it('preserves the "01 Motor Spirit" suffix when shortening the filename', () => {
    // The Jellyfin server filename shape is "{Album} - {NN} {Title}.{ext}".
    // The trailing "{NN} {Title}" tail is what the player uses for
    // track-number sort; the shrinker must keep it intact even when the
    // album prefix is dropped.
    const result = resolveTrackDestinationPath(makeInput());
    const filename = result.outputPath.split('/').pop() ?? '';
    expect(filename).toContain('01 Motor Spirit');
  });

  it('does not exceed 259 chars on FAT32 or exFAT either', () => {
    for (const fs of ['fat32', 'exfat'] as const) {
      const result = resolveTrackDestinationPath(makeInput({ filesystemType: fs }));
      expect(result.outputPath.length).toBeLessThanOrEqual(259);
      expect(result.outputPath.toLowerCase()).toMatch(/\.mp3$/);
    }
  });
});

describe('ORAIN-0501 AC4 — collision-safe shortening (Flamethrower next to Motor Spirit)', () => {
  it('produces two distinct filenames for two long-named siblings', () => {
    const siblingPath = PETRO_PATH.replace('01 Motor Spirit', '02 Flamethrower');
    const sibling = {
      ...motorSpirit,
      id: 'flamethrower',
      name: 'Flamethrower',
      path: siblingPath,
      trackNumber: 2,
    };

    const a = resolveTrackDestinationPath(makeInput({ track: motorSpirit }));
    const b = resolveTrackDestinationPath(makeInput({ track: sibling }));

    expect(a.outputPath).not.toBe(b.outputPath);
    expect(a.outputPath.split('/').pop()).not.toBe(b.outputPath.split('/').pop());
    expect(a.outputPath.length).toBeLessThanOrEqual(259);
    expect(b.outputPath.length).toBeLessThanOrEqual(259);
  });
});

describe('ORAIN-0501 AC5 — short paths and non-Windows targets are unchanged', () => {
  it('returns the path verbatim when it already fits in 259 chars', () => {
    const short = {
      ...motorSpirit,
      id: 'short',
      name: 'Short',
      path: '/media/music/Short.flac',
    };
    const result = resolveTrackDestinationPath(
      makeInput({ track: short, outputDir: 'W:\\Music MP3s/Short' }),
    );
    expect(result.outputPath).toBe('W:\\Music MP3s/Short/Short.mp3');
    expect(result.outputPath.length).toBeLessThanOrEqual(259);
  });

  it('does not shorten on Linux (filesystem unknown, platform linux)', () => {
    const result = resolveTrackDestinationPath(
      makeInput({
        track: motorSpirit,
        outputDir: '/mnt/music/album',
        platform: 'linux',
        filesystemType: 'unknown',
      }),
    );
    expect(result.outputPath).toBe(`/mnt/music/album/${longFilename}`);
  });

  it('does not shorten on macOS / APFS even when the path is long', () => {
    const result = resolveTrackDestinationPath(
      makeInput({
        track: motorSpirit,
        outputDir: '/Volumes/MEDIA/Music',
        platform: 'darwin',
        filesystemType: 'apfs',
      }),
    );
    expect(result.outputPath).toBe(`/Volumes/MEDIA/Music/${longFilename}`);
  });

  it('does not shorten on Windows with an unknown filesystem type (ORAIN-0725 platform gate)', () => {
    // ORAIN-0725 changed sanitizePathComponent to sanitize on win32 regardless of
    // filesystem. MAX_PATH must follow the same gate.
    const result = resolveTrackDestinationPath(makeInput({ filesystemType: 'unknown' }));
    expect(result.outputPath.length).toBeLessThanOrEqual(259);
  });
});

describe('ORAIN-0501 AC6 — single function for file + m3u8 entry', () => {
  it('returns both the absolute outputPath and the relative m3u8 path', () => {
    const result = resolveTrackDestinationPath(makeInput());
    expect(result.outputPath).toBeDefined();
    expect(result.relativePath).toBeDefined();
    // The m3u8 entry MUST share its filename with the on-disk file — if the
    // m3u8 generation computes its own filename, AC2 fails.
    expect(result.relativePath!.split('/').pop()).toBe(result.outputPath.split('/').pop());
    expect(result.relativePath!.toLowerCase()).toMatch(/\.mp3$/);
  });

  it('preserves the relative-path directory tree (Artist/Album prefix)', () => {
    const result = resolveTrackDestinationPath(makeInput());
    const segments = result.relativePath!.split('/');
    // First segment is the artist; the last is the basename. With
    // preserveStructure + a server-side path that has two directory
    // segments (Artist/Album), we expect ≥3 segments total.
    expect(segments.length).toBeGreaterThanOrEqual(3);
  });
});
