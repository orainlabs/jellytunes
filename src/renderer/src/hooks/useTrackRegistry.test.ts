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

const baseInfoWithDuration = (
  id: string,
  size: number,
  parentItemId: string,
  durationSeconds: number,
): TrackInfo => ({
  ...baseInfo(id, size, parentItemId),
  durationSeconds,
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
    await registry.fetchTracksForItems(['artist-1', 'album-1'], PATH, {
      serverUrl: 's',
      apiKey: 'k',
      userId: 'u',
    });

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
    await registry.fetchTracksForItems(['artist-1', 'album-1', 'playlist-1'], PATH, {
      serverUrl: 's',
      apiKey: 'k',
      userId: 'u',
    });

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
    await registry.fetchTracksForItems(['artist-1'], PATH, {
      serverUrl: 's',
      apiKey: 'k',
      userId: 'u',
    });
    await registry.fetchTracksForItems(['album-1'], PATH, {
      serverUrl: 's',
      apiKey: 'k',
      userId: 'u',
    });

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

describe('calculateDuration deduplication by trackId', () => {
  // ORAIN-0755 AC2 + AC6: PoC case from the review — artist + overlapping
  // album share a trackId. Without dedup, shared t1 (200s) would be
  // double-counted → 800s. With dedup → 600s (200+100+300).
  it('counts each trackId once when artist + overlapping album are both selected', async () => {
    const artistTracks = [
      baseInfoWithDuration('t1', 5_000_000, 'artist-1', 200),
      baseInfoWithDuration('t2', 5_000_000, 'artist-1', 100),
    ];
    const albumTracks = [
      baseInfoWithDuration('t1', 5_000_000, 'album-1', 200),
      baseInfoWithDuration('t3', 5_000_000, 'album-1', 300),
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
    await registry.fetchTracksForItems(['artist-1', 'album-1'], PATH, {
      serverUrl: 's',
      apiKey: 'k',
      userId: 'u',
    });

    expect(registry.calculateDuration(new Set(['artist-1', 'album-1']))).toBe(600);
  });

  // Adding a third overlapping item (playlist) must not change the total.
  it('does not change when a playlist adds tracks already present', async () => {
    const tracks = [
      baseInfoWithDuration('t1', 5_000_000, 'artist-1', 200),
      baseInfoWithDuration('t2', 5_000_000, 'artist-1', 100),
      baseInfoWithDuration('t1', 5_000_000, 'album-1', 200),
      baseInfoWithDuration('t3', 5_000_000, 'album-1', 300),
      baseInfoWithDuration('t1', 5_000_000, 'playlist-1', 200),
    ];
    mockApi.getTracksForItems.mockResolvedValue({ tracks, errors: [] });

    const registry = createTrackRegistry();
    await registry.loadDeviceSyncedTracks(PATH);
    await registry.fetchTracksForItems(['artist-1', 'album-1', 'playlist-1'], PATH, {
      serverUrl: 's',
      apiKey: 'k',
      userId: 'u',
    });

    const before = registry.calculateDuration(new Set(['artist-1', 'album-1']));
    const after = registry.calculateDuration(new Set(['artist-1', 'album-1', 'playlist-1']));
    expect(after).toBe(before);
    expect(after).toBe(600);
  });

  // No-overlap baseline: durations are item-scoped, no cross-item dedup needed.
  it('sums per-item durations when tracks do not overlap', async () => {
    const artistTracks = [
      baseInfoWithDuration('a1', 4_000_000, 'artist-1', 50),
      baseInfoWithDuration('a2', 4_000_000, 'artist-1', 75),
    ];
    const albumTracks = [baseInfoWithDuration('b1', 6_000_000, 'album-1', 180)];

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
    await registry.fetchTracksForItems(['artist-1'], PATH, {
      serverUrl: 's',
      apiKey: 'k',
      userId: 'u',
    });
    await registry.fetchTracksForItems(['album-1'], PATH, {
      serverUrl: 's',
      apiKey: 'k',
      userId: 'u',
    });

    expect(registry.calculateDuration(new Set(['artist-1', 'album-1']))).toBe(305);
  });

  // Fallback: item has cached tracks but none carry durationSeconds — must
  // fall back to item-level RunTimeTicks (the pre-fix behaviour that
  // supported the device-DB-only case).
  it('falls back to item ticks when cached tracks lack durationSeconds', async () => {
    // t1 has no durationSeconds on either parent.
    const tracks = [
      { ...baseInfo('t1', 5_000_000, 'artist-1') }, // no durationSeconds
      { ...baseInfo('t2', 5_000_000, 'artist-1') }, // no durationSeconds
    ];
    mockApi.getTracksForItems.mockResolvedValue({ tracks, errors: [] });

    const registry = createTrackRegistry();
    await registry.loadDeviceSyncedTracks(PATH);
    await registry.fetchTracksForItems(['artist-1'], PATH, {
      serverUrl: 's',
      apiKey: 'k',
      userId: 'u',
    });
    // 1_000_000_000 ticks / 10_000_000 = 100 seconds.
    registry.setItemTicks([{ id: 'artist-1', ticks: 1_000_000_000, type: 'album' }]);

    expect(registry.calculateDuration(new Set(['artist-1']))).toBe(100);
  });

  // Mixed: one item contributes via cached durations, another falls back to
  // ticks. Both must be summed without double-counting the shared trackId.
  it('mixes cached durations with item ticks when selections overlap', async () => {
    const artistTracks = [
      baseInfoWithDuration('t1', 5_000_000, 'artist-1', 200),
      baseInfoWithDuration('t2', 5_000_000, 'artist-1', 100),
    ];
    // album-1 has cached tracks but none carry durationSeconds → ticks fallback.
    const albumTracks = [
      { ...baseInfo('t3', 5_000_000, 'album-1') }, // no durationSeconds
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
    await registry.fetchTracksForItems(['artist-1', 'album-1'], PATH, {
      serverUrl: 's',
      apiKey: 'k',
      userId: 'u',
    });
    // album-1 ticks: 200s.
    registry.setItemTicks([{ id: 'album-1', ticks: 2_000_000_000, type: 'album' }]);

    // Expected: artist 200+100=300 (cached) + album 200 (ticks) = 500.
    expect(registry.calculateDuration(new Set(['artist-1', 'album-1']))).toBe(500);
  });
});
