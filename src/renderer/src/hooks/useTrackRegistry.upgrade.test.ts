// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTrackRegistry } from './useTrackRegistry';

const PATH = '/Volumes/USB';
const X = 'aitana-id';

// Solo albums (albumArtist query) vs superset incl. collaborations (artist query)
const soloTracks = [
  { id: 't1', name: 'Solo 1', path: '/a/1.flac', size: 1000, format: 'flac', parentItemId: X },
  { id: 't2', name: 'Solo 2', path: '/a/2.flac', size: 1000, format: 'flac', parentItemId: X },
];
const artistTracks = [
  ...soloTracks,
  { id: 't3', name: 'Collab 1', path: '/b/1.flac', size: 1000, format: 'flac', parentItemId: X },
  { id: 't4', name: 'Collab 2', path: '/c/2.flac', size: 1000, format: 'flac', parentItemId: X },
];

const mockApi = {
  getSyncedTracks: vi.fn().mockResolvedValue([]),
  getTracksForItems: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', { value: mockApi, writable: true });
});

describe('registry: albumArtist→artist upgrade refetch', () => {
  it('replaces the narrower albumArtist track set with the artist superset', async () => {
    const registry = createTrackRegistry();
    await registry.loadDeviceSyncedTracks(PATH);

    // Selected as albumArtist first.
    registry.setItemTypes([{ id: X, type: 'albumArtist' }]);
    mockApi.getTracksForItems.mockResolvedValueOnce({ tracks: soloTracks, errors: [] });
    await registry.fetchTracksForItems([X], PATH, {
      serverUrl: 's',
      apiKey: 'k',
      userId: 'u',
    });
    expect(registry.getItemTrackIds(X)).toHaveLength(2);

    // Upgrade to artist: invalidate + refetch.
    registry.invalidateItem(X);
    registry.setItemTypes([{ id: X, type: 'artist' }]);
    mockApi.getTracksForItems.mockResolvedValueOnce({ tracks: artistTracks, errors: [] });
    await registry.fetchTracksForItems([X], PATH, {
      serverUrl: 's',
      apiKey: 'k',
      userId: 'u',
    });

    expect(registry.getItemTrackIds(X)).toHaveLength(4);
    const size = registry.calculateSize(new Set([X]), PATH, false).total;
    expect(size).toBe(4000);
  });
});
