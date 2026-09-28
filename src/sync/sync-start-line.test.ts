/**
 * ORAIN-0740 — AC1: SyncCore emits `[sync-start]` with the real post-fetch
 * track count. Before Task 5, `[sync-start]` lived in index.ts with a
 * placeholder `trackCount=itemIds.length`, so the line reported
 * `tracks=N albums` even when the album had M tracks. The fix moves the
 * emission into sync-core.ts after the fetch phase so the line carries
 * `tracks=<real post-fetch total>`.
 *
 * Drives SyncCore through the public `sync()` path with a mocked api/fs,
 * captures the SyncLogger info channel, and asserts the `[sync-start]`
 * line carries the resolved track count and the caller-supplied
 * appVersion + destinationFilesystem.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { createTestSyncCore, type SyncDependencies } from './sync-core';
import type { SyncLogger, TrackInfo, ItemType } from './types';
import { createMockApiClient } from './sync-api';
import { createMockFileSystem, createMockConverter } from './sync-files';

const mockGetSyncedTracksForItem = vi.hoisted(() => vi.fn(() => []));
const mockGetSyncedItems = vi.hoisted(() => vi.fn(() => []));

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

const FAKE_MP3 = Buffer.concat([
  Buffer.from('ID3'),
  Buffer.from([0x03, 0x00]),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0xff, 0xfb, 0x90, 0x00]),
  Buffer.alloc(1024),
]);

function makeTracks(n: number): TrackInfo[] {
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

function makeDeps(tracks: TrackInfo[]): SyncDependencies {
  const api = createMockApiClient();
  api.getTracksForItems = vi.fn(async () => ({
    tracks: tracks.map((t) => ({ ...t })),
    errors: [],
  }));
  api.getCoverArt = vi.fn(async () => Buffer.alloc(0));
  api.downloadItemStream = vi.fn(async () => Readable.from(Buffer.from(FAKE_MP3)));
  api.fetchLyrics = vi.fn(async () => null);
  api.fetchReplayGain = vi.fn(async () => null);

  return { api, fs: createMockFileSystem(), converter: createMockConverter() };
}

describe('ORAIN-0740 AC1 — [sync-start] carries the resolved track count', () => {
  it('5-track sync emits [sync-start] with tracks=5 (not tracks=1 from itemIds)', async () => {
    const tracks = makeTracks(5);
    const { logger, info } = makeCapturingLogger();
    const deps = makeDeps(tracks);
    const core = createTestSyncCore(
      {
        serverUrl: validConfig.serverUrl,
        apiKey: validConfig.apiKey,
        userId: validConfig.userId,
      },
      deps,
    );
    (core as unknown as { log: SyncLogger }).log = logger;

    await core.sync(
      {
        itemIds: ['album-1'],
        itemTypes: new Map<string, ItemType>([['album-1', 'album']]),
        destinationPath: '/tmp/dest',
        syncId: 'ac1-5',
        appVersion: '1.2.3',
        destinationFilesystem: 'exfat',
        options: {
          convertToMp3: false,
          coverArtMode: 'off',
          lyricsMode: 'off',
          embedMetadata: true,
        },
      },
      () => {},
    );

    const startLines = info.filter((l) => l.includes('[sync-start]'));
    expect(startLines).toHaveLength(1);
    expect(startLines[0]).toContain('syncId=ac1-5');
    expect(startLines[0]).toContain('tracks=5');
    expect(startLines[0]).toContain('items=1');
    expect(startLines[0]).toContain('appVersion=1.2.3');
    expect(startLines[0]).toContain('destFs=exfat');
  }, 30_000);

  it('emitted exactly once per sync (no duplicate from index.ts and SyncCore)', async () => {
    const tracks = makeTracks(3);
    const { logger, info } = makeCapturingLogger();
    const deps = makeDeps(tracks);
    const core = createTestSyncCore(
      {
        serverUrl: validConfig.serverUrl,
        apiKey: validConfig.apiKey,
        userId: validConfig.userId,
      },
      deps,
    );
    (core as unknown as { log: SyncLogger }).log = logger;

    await core.sync(
      {
        itemIds: ['album-1'],
        itemTypes: new Map<string, ItemType>([['album-1', 'album']]),
        destinationPath: '/tmp/dest',
        syncId: 'ac1-once',
        options: {
          convertToMp3: false,
          coverArtMode: 'off',
          lyricsMode: 'off',
          embedMetadata: true,
        },
      },
      () => {},
    );

    const startLines = info.filter((l) => l.includes('[sync-start]'));
    expect(startLines).toHaveLength(1);
  }, 30_000);
});
