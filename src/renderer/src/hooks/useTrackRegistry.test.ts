// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTrackRegistry } from './useTrackRegistry';
import type { TrackInfo } from './useTrackRegistry';

const PATH = '/Volumes/USB';

const baseInfo = (id: string, size: number, parentItemId: string): TrackInfo => ({
  id,
  name: id,
  path: `/m/${id}.flac`,
  format: 'flac',
  size,
  bitrate: 900_000,
  parentItemId,
});

const mockApi = {
  getSyncedTracks: vi.fn().mockResolvedValue([]),
  getTracksForItems: vi.fn(),
  // Logger forwarding — defined to avoid "not a function" errors when the
  // registry logs a warning (e.g. when getTracksForItems returns errors).
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', { value: mockApi, writable: true });
});

describe('calculateSize deduplication by trackId', () => {
  // AC3: artist A (t1..t3) + album B that contains t1..t3 → total == bytes of t1..t3.
  it('counts each trackId once when artist + overlapping album are both selected', async () => {
    // The same three tracks claimed by two parents (artist-1 superset + album-1 subset).
    // Without dedup, each track is counted twice → 30_000_000.
    const artistTracks = [
      baseInfo('t1', 5_000_000, 'artist-1'),
      baseInfo('t2', 5_000_000, 'artist-1'),
      baseInfo('t3', 5_000_000, 'artist-1'),
    ];
    const albumTracks = [
      baseInfo('t1', 5_000_000, 'album-1'),
      baseInfo('t2', 5_000_000, 'album-1'),
      baseInfo('t3', 5_000_000, 'album-1'),
    ];
    mockApi.getTracksForItems.mockImplementation(async (opts: { itemIds: string[] }) => {
      const tracks = [
        ...(opts.itemIds.includes('artist-1') ? artistTracks : []),
        ...(opts.itemIds.includes('album-1') ? albumTracks : []),
      ];
      return { tracks, errors: [] };
    });

    const registry = createTrackRegistry();
    await registry.loadDeviceSyncedTracks(PATH);
    await registry.fetchTracksForItems(
      ['artist-1', 'album-1'],
      PATH,
      { serverUrl: 's', apiKey: 'k', userId: 'u' },
    );

    const size = registry.calculateSize(new Set(['artist-1', 'album-1']), PATH, false).total;
    expect(size).toBe(15_000_000);
  });

  // AC3: playlist with tracks already in artist + album → no extra count.
  it('does not change when a playlist adds tracks already present', async () => {
    // All three items share tracks t1 + t2. With dedup, total stays at t1+t2 = 10 MB
    // whether the playlist is added or not.
    const tracks = [
      baseInfo('t1', 5_000_000, 'artist-1'),
      baseInfo('t2', 5_000_000, 'artist-1'),
      baseInfo('t1', 5_000_000, 'album-1'),
      baseInfo('t2', 5_000_000, 'album-1'),
      baseInfo('t1', 5_000_000, 'playlist-1'),
      baseInfo('t2', 5_000_000, 'playlist-1'),
    ];
    mockApi.getTracksForItems.mockResolvedValue({ tracks, errors: [] });

    const registry = createTrackRegistry();
    await registry.loadDeviceSyncedTracks(PATH);
    await registry.fetchTracksForItems(
      ['artist-1', 'album-1', 'playlist-1'],
      PATH,
      { serverUrl: 's', apiKey: 'k', userId: 'u' },
    );

    const before = registry.calculateSize(new Set(['artist-1', 'album-1']), PATH, false).total;
    const after = registry.calculateSize(
      new Set(['artist-1', 'album-1', 'playlist-1']),
      PATH,
      false,
    ).total;
    expect(after).toBe(before);
  });

  // AC6 regression: no-overlap selection must equal the pre-fix sum.
  it('sums per-item sizes without dedup when tracks do not overlap', async () => {
    const artistTracks = [
      baseInfo('a1', 4_000_000, 'artist-1'),
      baseInfo('a2', 4_000_000, 'artist-1'),
    ];
    const albumTracks = [baseInfo('b1', 6_000_000, 'album-1')];

    mockApi.getTracksForItems.mockImplementation(async (opts: { itemIds: string[] }) => {
      const tracks = opts.itemIds.includes('artist-1')
        ? artistTracks
        : opts.itemIds.includes('album-1')
          ? albumTracks
          : [];
      return { tracks, errors: [] };
    });

    const registry = createTrackRegistry();
    await registry.loadDeviceSyncedTracks(PATH);
    await registry.fetchTracksForItems(
      ['artist-1'],
      PATH,
      { serverUrl: 's', apiKey: 'k', userId: 'u' },
    );
    await registry.fetchTracksForItems(
      ['album-1'],
      PATH,
      { serverUrl: 's', apiKey: 'k', userId: 'u' },
    );

    const size = registry.calculateSize(new Set(['artist-1', 'album-1']), PATH, false).total;
    expect(size).toBe(14_000_000);
  });

  // AC4: tick branch with artist + album overlap — must NOT double-count.
  it('does not double-count ticks when artist + overlapping album are selected (convertToMp3=true)', async () => {
    // No fetch → all items take the tick branch.
    mockApi.getTracksForItems.mockResolvedValue({ tracks: [], errors: [] });

    const registry = createTrackRegistry();
    await registry.loadDeviceSyncedTracks(PATH);

    // Set ticks directly. 1_000_000_000 ticks @ 0.0035 bytes/tick = 3_500_000 bytes each.
    registry.setItemTicks([
      { id: 'artist-1', ticks: 1_000_000_000, type: 'artist' },
      { id: 'album-1', ticks: 1_000_000_000, type: 'album' },
    ]);

    const ticksOnly = registry.calculateSize(
      new Set(['artist-1', 'album-1']),
      PATH,
      false,
      undefined,
      new Set(['album-1']),
    );
    // Without the fix: 7_000_000 bytes (1_000_000_000 × 0.0035 × 2).
    // With the fix:    3_500_000 bytes (the album is covered by the artist).
    expect(ticksOnly.total).toBe(3_500_000);
  });
});
