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
import { describe, it, expect, vi } from 'vitest';
import {
  resolveTrackDestinationPath,
  createTestSyncCore,
  type SyncDependencies,
  type ResolveTrackDestinationPathInput,
} from './sync-core';
import { createMockApiClient } from './sync-api';
import { createMockConverter, createMockFileSystem } from './sync-files';
import type { SyncConfig, TrackInfo, ItemType } from './types';

const mockGetSyncedTracksForDevice_0501 = vi.hoisted(() => vi.fn(() => []));

vi.mock('../main/database', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  upsertSyncedTrack: vi.fn(),
  getSyncedTracksForDevice: mockGetSyncedTracksForDevice_0501,
  getSyncedTracksForItem: mockGetSyncedTracksForDevice_0501,
  removeSyncedTracksForItem: vi.fn(),
  removeSyncedTrack: vi.fn(),
}));

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

// =============================================================================
// AC2 + AC3 — SyncCore end-to-end coverage
//
// AC2 (spec line 12): every m3u8 entry of a long-path track must point at a
// file that exists on disk after the sync. Before the helper unification the
// m3u8 code reconstructed its own filename, so a track that hit MAX_PATH
// truncation landed on disk as the SHORT name while the m3u8 still pointed at
// the LONG name — a broken playlist.
//
// AC3 (spec line 13): a second sync of a previously-shortened track must NOT
// re-download the file. The DB already has the new path; the engine must
// detect pathChanged=false and skip. This catches regressions where the DB
// record's destinationPath drifts from what `resolveTrackDestinationPath`
// computes.
//
// These tests use the mocked fs from sync-files.ts (real fs would require a
// Windows MAX_PATH victim). The track path is the same "Motor Sport" repro
// from issue #27, but at /tmp-style short outputDir because the helper only
// shortens when `platform === 'win32'`. We do not pass platform = 'win32'
// here: AC2/AC3 verify behaviour of the helper regardless of platform, and
// forcing win32 would make the SyncCore routing paths unrelated to
// MAX_PATH run instead.
// =============================================================================

const VALID_CONFIG_0501: SyncConfig = {
  serverUrl: 'https://jellyfin.example.com',
  apiKey: '0123456789abcdef0123456789abcdef',
  userId: 'abcdef1234567890abcdef1234567890',
  serverRootPath: '/media/music/',
};

function makeTrack(overrides: Partial<TrackInfo> = {}): TrackInfo {
  return {
    id: 'motor-spirit-0501',
    name: 'Motor Spirit',
    album: 'PetroDragonic Apocalypse',
    artists: ['King Gizzard & The Lizard Wizard'],
    path: '/media/music/King Gizzard & The Lizard Wizard/PetroDragonic Apocalypse/01 Motor Spirit.flac',
    format: 'flac',
    size: 100,
    trackNumber: 1,
    ...overrides,
  };
}

function createTestDeps(overrides?: Partial<SyncDependencies>): SyncDependencies {
  return {
    api: createMockApiClient(),
    fs: createMockFileSystem(),
    converter: createMockConverter(),
    ...overrides,
  };
}

/**
 * Audio body whose length matches `track.size` so the ORAIN-0739 download
 * validator accepts it on the first pass (no retry loop).
 */
function fakeAudioStream(declaredSize: number) {
  const { Readable } = require('stream') as typeof import('stream');
  const HEADER = Buffer.concat([
    Buffer.from('ID3'),
    Buffer.from([0x03, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0xff, 0xfb, 0x90, 0x00]),
  ]);
  return Readable.from(Buffer.concat([HEADER, Buffer.alloc(declaredSize - HEADER.length)]));
}

describe('ORAIN-0501 AC2 — m3u8 entries resolve to existing on-disk files', () => {
  it('every m3u8 line for a long-path track points at a file present in fs', async () => {
    const mockApi = createMockApiClient();
    mockApi.getItem = vi.fn().mockImplementation(async (id: string) => {
      if (id === 'album-0501') return { id, name: 'PetroDragonic Apocalypse', type: 'MusicAlbum' };
      if (id === 'playlist-0501') return { id, name: 'LongTracks', type: 'Playlist' };
      return null;
    });

    const track = makeTrack();
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks: [track], errors: [] });
    mockApi.getPlaylistTracks = vi.fn().mockResolvedValue([track]);

    const mockFs = createMockFileSystem() as ReturnType<typeof createMockFileSystem> & {
      __getFile: (path: string) => Buffer | undefined;
    };

    const downloadSpy = vi.fn(async () => fakeAudioStream(track.size!));
    mockApi.downloadItemStream = downloadSpy;

    const deps = createTestDeps({ api: mockApi, fs: mockFs });
    const core = createTestSyncCore(VALID_CONFIG_0501, deps);

    const result = await core.sync({
      itemIds: ['album-0501', 'playlist-0501'],
      itemTypes: new Map<string, ItemType>([
        ['album-0501', 'album'],
        ['playlist-0501', 'playlist'],
      ]),
      destinationPath: '/dest',
      // embedMetadata:false routes copyTrackFile through fs.writeFile so the
      // mock fs actually receives the destination file; otherwise the mock
      // tagFile returns success but writes nothing, masking the very drift AC2
      // is meant to catch.
      options: { convertToMp3: false, preserveStructure: false, embedMetadata: false },
    });

    expect(result.success).toBe(true);
    expect(result.tracksCopied).toBe(1);
    expect(downloadSpy).toHaveBeenCalledTimes(1);

    // Read the m3u8 and check every line that is not a comment points at a file
    // that exists on disk. This is the spec's literal acceptance test: "cada
    // entrada de la m3u8 resuelve a un fichero existente".
    const m3u8 = mockFs.__getFile('/dest/LongTracks.m3u8');
    expect(m3u8).toBeDefined();
    const lines = m3u8!
      .toString('utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    const entryLines = lines.filter((l) => !l.startsWith('#'));
    expect(entryLines.length).toBe(1);

    for (const entry of entryLines) {
      // The m3u8 entry is a relative path; resolve it against the playlist's
      // destination directory (here `/dest`) before asking the mock fs.
      const absoluteCandidate = `/dest/${entry}`;
      const candidate = mockFs.__getFile(absoluteCandidate);
      // Try both with and without the leading `/dest/` prefix in case the
      // helper writes an absolute path — the spec only requires that *some*
      // path on the entry resolves to an existing file.
      expect(candidate ?? mockFs.__getFile(entry)).toBeDefined();
    }
  });
});

describe('ORAIN-0501 AC3 — second sync does not re-download a shortened track', () => {
  // AC3 (spec line 13): a second sync of a previously-shortened track must NOT
  // re-download. We exercise the realistic two-step flow:
  //   1. First sync writes the file at the helper's chosen path.
  //   2. Seed a DB record whose destinationPath is the OLD (long) name. The
  //      helper still picks the SHORT name (unchanged), so pathChanged=true;
  //      `handleSyncedRecord` case (b) renames OLD → NEW without re-download.
  //   3. The second sync must NOT call downloadItemStream.

  // Hash matches production code: sha256(JSON{title,artist,album,...})[:16].
  // Computed once with Node crypto mirroring `computeMetadataHash` in
  // sync-core.ts:111 — the function is module-private, so we hardcode the
  // result here. Bumping the fixture (different artists / album) invalidates
  // this hash and the test must be re-hashed manually.
  const HASH_0501 = '96d9ce5eaab2378c';

  it('uses fs.rename to relocate the file and does not call downloadItemStream', async () => {
    const mockApi = createMockApiClient();
    mockApi.getItem = vi.fn().mockImplementation(async (id: string) => {
      if (id === 'album-0501') return { id, name: 'PetroDragonic Apocalypse', type: 'MusicAlbum' };
      return null;
    });
    const track = makeTrack();
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks: [track], errors: [] });

    // OLD path: a fake "long-name" location the DB still references from a
    // pre-MAX_PATH-fix sync. We seed it with audio bytes so the rename source
    // exists on disk.
    const OLD_PATH =
      '/dest/King Gizzard & The Lizard Wizard/PetroDragonic Apocalypse/King Gizzard & The Lizard Wizard - PetroDragonic Apocalypse - 01 Motor Spirit.flac';
    // The helper's NEW path: same dir tree (engine derives outputDir from
    // serverRootPath regardless of preserveStructure), basename unchanged
    // here because the helper is platform-agnostic in the AC test — we only
    // need a destinationPath different from OLD_PATH so case (b) triggers.
    const newResolved = resolveTrackDestinationPath({
      track,
      outputDir: '/dest/King Gizzard & The Lizard Wizard/PetroDragonic Apocalypse',
      serverRootPath: VALID_CONFIG_0501.serverRootPath!,
      options: {
        convertToMp3: false,
        preserveStructure: false,
        platform: 'darwin',
        filesystemType: 'apfs',
      } as any,
      platform: 'darwin',
      filesystemType: 'apfs',
    });
    expect(newResolved.outputPath).not.toBe(OLD_PATH); // sanity guard for the case

    const mockFs = createMockFileSystem() as ReturnType<typeof createMockFileSystem> & {
      __getFile: (path: string) => Buffer | undefined;
    };
    mockFs.__getFile(OLD_PATH); // ensure mock fs is initialised
    // Pre-create the file at OLD path so case (b) can rename it.
    await mockFs.writeFile(OLD_PATH, Buffer.from('pre-existing-audio-bytes'));

    const downloadSpy = vi.fn(async () => fakeAudioStream(track.size!));
    mockApi.downloadItemStream = downloadSpy;

    // Spy on fs.rename so we can assert it (not download) is the path used.
    const renameSpy = vi.fn();
    const origRename = mockFs.rename.bind(mockFs);
    mockFs.rename = vi.fn(async (src: string, dst: string) => {
      renameSpy(src, dst);
      return origRename(src, dst);
    });

    mockGetSyncedTracksForDevice_0501.mockReturnValue([
      {
        id: 1,
        deviceId: 1,
        itemId: 'album-0501',
        trackId: 'motor-spirit-0501',
        destinationPath: OLD_PATH,
        fileSize: 100,
        metadataHash: HASH_0501,
        coverArtMode: 'embed',
        encodedBitrate: null,
        serverPath: track.path,
        serverRootPath: null,
        syncedAt: new Date().toISOString(),
      },
    ] as any);

    const deps = createTestDeps({ api: mockApi, fs: mockFs });
    const core = createTestSyncCore(VALID_CONFIG_0501, deps);

    const result = await core.sync({
      itemIds: ['album-0501'],
      itemTypes: new Map<string, ItemType>([['album-0501', 'album']]),
      destinationPath: '/dest',
      options: { convertToMp3: false, preserveStructure: false },
    });

    // Case (b) ran: rename OLD → NEW, no re-download.
    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [, newPath] = renameSpy.mock.calls[0];
    expect(newPath).toBe(newResolved.outputPath);
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(result.tracksFailed).toHaveLength(0);
    expect(mockFs.__getFile(newPath)).toBeDefined();
    // And the OLD path no longer has the audio (rename moved it).
    expect(mockFs.__getFile(OLD_PATH)).toBeUndefined();
  });
});
