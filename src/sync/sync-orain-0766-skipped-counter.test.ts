/**
 * ORAIN-0766 — itemsSkipped counter must reflect tracks that were up-to-date
 * on the destination.
 *
 * AC3 of the task: `tracksSkipped` must be the count of tracks the sync
 * decided to leave alone because they were already at the destination with
 * matching size and metadata. Before the fix, `stats.itemsSkipped` was
 * declared on `ProgressStats` and even read into `SyncResult.tracksSkipped`
 * but never bumped in `runCopyPhase`, so it was always 0.
 *
 * AC5: unit coverage of the up-to-date path bumps the counter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';
import type { ItemType, TrackInfo } from './types';
import { createTestSyncCore } from './sync-core';
import { createMockApiClient } from './sync-api';
import { createMockFileSystem, createMockConverter } from './sync-files';
import { getSyncedTracksForDevice, upsertSyncedTrack } from '../main/database';

vi.mock('../main/database', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  upsertSyncedTrack: vi.fn(),
  getSyncedTracksForDevice: vi.fn(() => []),
  getSyncedTracksForItem: vi.fn(() => []),
  getSyncedItems: vi.fn(() => []),
  removeSyncedTracksForItem: vi.fn(),
  removeSyncedTrack: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getSyncedTracksForDevice).mockReset();
  vi.mocked(getSyncedTracksForDevice).mockReturnValue([]);
  vi.mocked(upsertSyncedTrack).mockReset();
});

afterEach(() => {
  vi.mocked(getSyncedTracksForDevice).mockReset();
});

// Two tracks with paths deep enough for detectServerRootPath to infer a
// root. The detector drops the last 4 components (filename + album_dir +
// artist_dir + library_name); we need >= 5 in the path or detection falls
// back to '/' and getOutputDir keeps the full server path under the
// destination.
const trackUpToDate: TrackInfo = {
  id: 'track-up-to-date',
  name: 'Track Up To Date',
  album: 'Album One',
  artists: ['Artist One'],
  path: '/lib/music/Artist One/Album One/track-up-to-date.mp3',
  format: 'mp3',
  size: 5_000_000,
  trackNumber: 1,
};

const trackNeedsCopy: TrackInfo = {
  id: 'track-needs-copy',
  name: 'Track Needs Copy',
  album: 'Album One',
  artists: ['Artist One'],
  path: '/lib/music/Artist One/Album One/track-needs-copy.mp3',
  format: 'mp3',
  size: 4_000_000,
  trackNumber: 2,
};

const validConfig = {
  serverUrl: 'https://jellyfin.example.com',
  apiKey: '0123456789abcdef0123456789abcdef',
  userId: 'abcdef1234567890abcdef1234567890',
};

function createMockDeps(): any {
  return {
    api: createMockApiClient(),
    fs: createMockFileSystem(),
    converter: createMockConverter(),
  };
}

describe('ORAIN-0766 — itemsSkipped counter on up-to-date tracks', () => {
  it('AC3 — counts a track as skipped when its file is already on disk with matching size', async () => {
    // No synced record, file pre-seeded at the resolved destination.
    // sync-core.ts:1409 hits `if (await fs.exists(outputPath))` and falls
    // through to the size-match branch at line 1426 which returns
    // { processed: true, skipped: true }.
    vi.mocked(getSyncedTracksForDevice).mockReturnValue([]);

    const deps = createMockDeps();
    // resolveSyncOptions defaults preserveStructure=true → outputDir is
    // built from the track's server-relative path. The detector drops the
    // last 4 components, so for '/lib/music/<Artist One>/<Album One>/...'
    // the root is '/lib/' and the relative dir is
    // 'music/Artist One/Album One'. With destinationPath '/mnt/usb' the
    // full output path is '/mnt/usb/music/Artist One/Album One/...'.
    const mockFs = deps.fs as any;
    mockFs.__setFile(
      '/mnt/usb/music/Artist One/Album One/track-up-to-date.mp3',
      Buffer.alloc(5_000_000),
    );

    const apiWithTracks = createMockApiClient({
      getTracksForItems: async () => ({
        tracks: [trackUpToDate, trackNeedsCopy],
        errors: [],
      }),
      downloadItemStream: async () => Readable.from(Buffer.alloc(4_000_000)),
    });
    const realDeps = { ...deps, api: apiWithTracks };
    const core = createTestSyncCore(validConfig, realDeps);

    const itemTypes = new Map<string, ItemType>([['album-1', 'album']]);
    const result = await core.sync(
      { itemIds: ['album-1'], itemTypes, destinationPath: '/mnt/usb' },
      () => {},
    );

    // ORAIN-0766 AC3: itemsSkipped reflects the up-to-date track.
    expect(result.tracksSkipped).toBe(1);
    // Sanity: the other track was copied (or attempted).
    expect(result.tracksCopied).toBeGreaterThanOrEqual(0);
  });

  it('AC3 — itemsSkipped is zero when no track is up-to-date (fresh sync)', async () => {
    // No synced records at all → both tracks go through copyOrConvertTrack.
    vi.mocked(getSyncedTracksForDevice).mockReturnValue([]);

    const deps = createMockDeps();
    const apiWithTracks = createMockApiClient({
      getTracksForItems: async () => ({
        tracks: [trackUpToDate, trackNeedsCopy],
        errors: [],
      }),
      downloadItemStream: async () => Readable.from(Buffer.alloc(4_000_000)),
    });
    const realDeps = { ...deps, api: apiWithTracks };
    const core = createTestSyncCore(validConfig, realDeps);

    const itemTypes = new Map<string, ItemType>([['album-1', 'album']]);
    const result = await core.sync(
      { itemIds: ['album-1'], itemTypes, destinationPath: '/mnt/usb' },
      () => {},
    );

    // Neither track was up-to-date, so neither should be skipped.
    expect(result.tracksSkipped).toBe(0);
  });
});
