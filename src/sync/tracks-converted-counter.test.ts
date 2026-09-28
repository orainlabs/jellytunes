/**
 * ORAIN-0740 cycle 2 (AC2) — `tracksConverted` is a real counter, not a
 * parity copy of `tracksCopied`. Drives SyncCore through the public
 * `sync()` path with mocked api/fs so each track reaches a deterministic
 * outcome; asserts the SyncResult field reflects the number of tracks
 * that went through the FFmpeg conversion pipeline.
 *
 * Cycle 1 (commit ab09c3e) wired `[sync-end]` but fed it
 * `result.tracksCopied` for the `converted=` field. That made every
 * sync-with-conversion look like it converted everything. The fix
 * adds `tracksConverted` to SyncResult and bumps it in `runCopyPhase`
 * only when FFmpeg completes successfully (willConvert && !error).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { createTestSyncCore, type SyncDependencies } from './sync-core';
import type { SyncLogger, TrackInfo, ItemType } from './types';
import type { AudioConverter } from './sync-files';
import { createMockApiClient } from './sync-api';
import { createMockFileSystem, createMockConverter } from './sync-files';

const mockGetSyncedTracksForItem = vi.hoisted(() => vi.fn(() => []));
const mockGetSyncedItems = vi.hoisted(() =>
  vi.fn<() => Array<{ id: string; name: string; type: string }>>(() => []),
);

vi.mock('../main/database', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  upsertSyncedTrack: vi.fn(),
  getSyncedTracksForDevice: vi.fn(() => []),
  getSyncedTracksForItem: mockGetSyncedTracksForItem,
  getSyncedItems: mockGetSyncedItems,
  removeSyncedTracksForItem: vi.fn(),
  removeSyncedTrack: vi.fn(),
}));

beforeEach(() => {
  mockGetSyncedTracksForItem.mockReset();
  mockGetSyncedTracksForItem.mockReturnValue([]);
  mockGetSyncedItems.mockReset();
  mockGetSyncedItems.mockReturnValue([]);
});

function makeCapturingLogger(): { logger: SyncLogger; info: string[] } {
  const info: string[] = [];
  const logger: SyncLogger = {
    info: (m) => info.push(m),
    warn: () => {},
    error: () => {},
    debug: () => {},
    trackFailed: () => {},
  };
  return { logger, info };
}

const validConfig = {
  serverUrl: 'https://jellyfin.example.com',
  apiKey: '0123456789abcdef0123456789abcdef',
  userId: 'abcdef1234567890abcdef1234567890',
};

// Fake MP3 header that passes SyncCore's download validation (ID3v2 + MPEG sync).
const FAKE_MP3 = Buffer.concat([
  Buffer.from('ID3'),
  Buffer.from([0x03, 0x00]),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0xff, 0xfb, 0x90, 0x00]),
  Buffer.alloc(1024),
]);

function makeFlacTracks(n: number): TrackInfo[] {
  // FLAC, bitrate above target (320k) — so convertToMp3=true triggers
  // the FFmpeg path for every track.
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    name: `Track ${i + 1}`,
    path: `/lib/album/${i + 1}.flac`,
    format: 'flac',
    bitrate: 1_200_000,
    size: 45_000_000,
    albumId: 'album-1',
  }));
}

function makeMp3Tracks(n: number): TrackInfo[] {
  // MP3 at 320k — convertToMp3=true with target 192k needs re-encoding.
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`,
    name: `MP3 ${i + 1}`,
    path: `/lib/album/${i + 1}.mp3`,
    format: 'mp3',
    bitrate: 320_000,
    size: 8_000_000,
    albumId: 'album-1',
  }));
}

function makeDeps(
  tracks: TrackInfo[],
  options: { convertToMp3: boolean; failConvertIds?: Set<string> },
): SyncDependencies {
  const api = createMockApiClient();
  api.getTracksForItems = vi.fn(async () => ({
    tracks: tracks.map((t) => ({ ...t })),
    errors: [],
  }));
  api.getCoverArt = vi.fn(async () => Buffer.alloc(0));
  api.downloadItemStream = vi.fn(async () => Readable.from(Buffer.from(FAKE_MP3)));
  api.fetchLyrics = vi.fn(async () => null);
  api.fetchReplayGain = vi.fn(async () => null);

  const baseConverter = createMockConverter() as AudioConverter;
  // Override convertStreamToMp3WithMeta so we can inject a per-track
  // failure when needed; defaults to success otherwise. The counter must
  // NOT increment on a FFmpeg failure (the cycle 1 fix).
  baseConverter.convertStreamToMp3WithMeta = vi.fn(async (_in, _out, _br, _meta, _cover) => {
    const lastCallId = (
      baseConverter.convertStreamToMp3WithMeta as unknown as {
        mock: { calls: unknown[][] };
      }
    ).mock.calls.at(-1)?.[0] as string | undefined;
    if (lastCallId && options.failConvertIds?.has(lastCallId)) {
      return { success: false, error: 'simulated ffmpeg failure' };
    }
    return { success: true };
  });

  return { api, fs: createMockFileSystem(), converter: baseConverter };
}

describe('ORAIN-0740 cycle 2 AC2 — tracksConverted is a real counter', () => {
  it('convertToMp3=false: tracksConverted is 0 even when all 5 FLAC tracks are copied', async () => {
    const tracks = makeFlacTracks(5);
    const { logger } = makeCapturingLogger();
    const deps = makeDeps(tracks, { convertToMp3: false });
    const core = createTestSyncCore(
      {
        serverUrl: validConfig.serverUrl,
        apiKey: validConfig.apiKey,
        userId: validConfig.userId,
      },
      deps,
    );
    (core as unknown as { log: SyncLogger }).log = logger;

    const result = await core.sync(
      {
        itemIds: ['album-1'],
        itemTypes: new Map<string, ItemType>([['album-1', 'album']]),
        destinationPath: '/tmp/dest',
        syncId: 'no-conv',
        options: {
          convertToMp3: false,
          coverArtMode: 'off',
          lyricsMode: 'off',
          embedMetadata: true,
        },
      },
      () => {},
    );

    expect(result.tracksCopied).toBe(5);
    // Pure copy path: zero conversions, even though 5 files ended up on disk.
    expect(result.tracksConverted).toBe(0);
  }, 30_000);

  it('convertToMp3=true with 5 FLAC tracks: tracksConverted === 5', async () => {
    const tracks = makeFlacTracks(5);
    const { logger } = makeCapturingLogger();
    const deps = makeDeps(tracks, { convertToMp3: true });
    const core = createTestSyncCore(
      {
        serverUrl: validConfig.serverUrl,
        apiKey: validConfig.apiKey,
        userId: validConfig.userId,
      },
      deps,
    );
    (core as unknown as { log: SyncLogger }).log = logger;

    const result = await core.sync(
      {
        itemIds: ['album-1'],
        itemTypes: new Map<string, ItemType>([['album-1', 'album']]),
        destinationPath: '/tmp/dest',
        syncId: 'flac-5',
        options: {
          convertToMp3: true,
          bitrate: '192k',
          coverArtMode: 'off',
          lyricsMode: 'off',
          embedMetadata: true,
        },
      },
      () => {},
    );

    expect(result.tracksCopied).toBe(5);
    // Every FLAC track passes through FFmpeg → 5 conversions.
    expect(result.tracksConverted).toBe(5);
  }, 30_000);

  it('convertToMp3=true with 5 MP3 tracks already at target: tracksConverted === 0', async () => {
    // 192k target, source 192k → needsConversion returns false (track.bitrate <= target*1000).
    const tracks = makeMp3Tracks(5).map((t) => ({ ...t, bitrate: 192_000 }));
    const { logger } = makeCapturingLogger();
    const deps = makeDeps(tracks, { convertToMp3: true });
    const core = createTestSyncCore(
      {
        serverUrl: validConfig.serverUrl,
        apiKey: validConfig.apiKey,
        userId: validConfig.userId,
      },
      deps,
    );
    (core as unknown as { log: SyncLogger }).log = logger;

    const result = await core.sync(
      {
        itemIds: ['album-1'],
        itemTypes: new Map<string, ItemType>([['album-1', 'album']]),
        destinationPath: '/tmp/dest',
        syncId: 'mp3-skip',
        options: {
          convertToMp3: true,
          bitrate: '192k',
          coverArtMode: 'off',
          lyricsMode: 'off',
          embedMetadata: true,
        },
      },
      () => {},
    );

    expect(result.tracksCopied).toBe(5);
    // needsConversion=false → FFmpeg is never invoked → 0 conversions.
    expect(result.tracksConverted).toBe(0);
  }, 30_000);

  it('mixed batch (3 FLAC + 2 MP3 at 320k with 192k target): tracksConverted === 5', async () => {
    // All five tracks need conversion:
    //   - 3 FLAC: needsConversion returns true for any non-MP3 format.
    //   - 2 MP3 at 320k: needsConversion checks bitrate > target*1000 (192000) → true.
    const tracks = [...makeFlacTracks(3), ...makeMp3Tracks(2)];
    const { logger } = makeCapturingLogger();
    const deps = makeDeps(tracks, { convertToMp3: true });
    const core = createTestSyncCore(
      {
        serverUrl: validConfig.serverUrl,
        apiKey: validConfig.apiKey,
        userId: validConfig.userId,
      },
      deps,
    );
    (core as unknown as { log: SyncLogger }).log = logger;

    const result = await core.sync(
      {
        itemIds: ['album-1'],
        itemTypes: new Map<string, ItemType>([['album-1', 'album']]),
        destinationPath: '/tmp/dest',
        syncId: 'mixed-5',
        options: {
          convertToMp3: true,
          bitrate: '192k',
          coverArtMode: 'off',
          lyricsMode: 'off',
          embedMetadata: true,
        },
      },
      () => {},
    );

    expect(result.tracksCopied).toBe(5);
    expect(result.tracksConverted).toBe(5);
  }, 30_000);
});
