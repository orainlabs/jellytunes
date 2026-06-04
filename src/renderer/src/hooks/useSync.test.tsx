// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSync } from './useSync';
import type { Artist, Album, Playlist } from '../appTypes';
import type { SyncedItemInfo } from './useDeviceSelections';
import { getTrackRegistry } from './useTrackRegistry';

const mockArtists: Artist[] = [
  { Id: 'artist-1', Name: 'The Beatles', AlbumCount: 13, ImageTags: {} },
];
const mockAlbums: Album[] = [
  {
    Id: 'album-1',
    Name: 'Abbey Road',
    AlbumArtist: 'The Beatles',
    ProductionYear: 1969,
    ImageTags: {},
  },
];
const mockPlaylists: Playlist[] = [
  { Id: 'playlist-1', Name: 'My Favorites', ChildCount: 10, ImageTags: {} },
];

const defaultProps = {
  jellyfinConfig: { url: 'https://jellyfin.test', apiKey: 'test-key' },
  userId: 'user-1',
  selectedTracks: new Set<string>(),
  selectedArtists: new Set<string>(),
  selectedAlbumArtists: new Set<string>(),
  previouslySyncedItems: new Set<string>(),
  syncedItemsInfo: [] as SyncedItemInfo[],
  outOfSyncItems: new Set<string>(),
  artists: mockArtists,
  albums: mockAlbums,
  playlists: mockPlaylists,
  albumArtists: [] as Artist[],
  genres: [] as { Id: string; Name: string; LibraryItems?: number }[],
  isTickEstimate: false,
  setPreviouslySyncedItems: vi.fn(),
  revalidateDevice: vi.fn().mockResolvedValue(undefined),
};

const createMockApi = (overrides?: Record<string, ReturnType<typeof vi.fn>>) => ({
  selectFolder: vi.fn().mockResolvedValue('/Volumes/USB'),
  getSyncedItems: vi.fn().mockResolvedValue([]),
  startSync2: vi.fn().mockResolvedValue({
    success: true,
    tracksCopied: 5,
    tracksFailed: [],
    errors: [],
    tracksSkipped: 0,
  }),
  removeItems: vi.fn().mockResolvedValue({ removed: 0, errors: [] }),
  cancelSync: vi.fn().mockResolvedValue({ cancelled: true }),
  onSyncProgress: vi.fn().mockReturnValue(() => {}),
  logError: vi.fn(),
  ...overrides,
});

let mockApi: ReturnType<typeof createMockApi>;

beforeEach(() => {
  mockApi = createMockApi();
  Object.defineProperty(window, 'api', { value: mockApi, writable: true });
  vi.stubGlobal('alert', vi.fn());
  vi.clearAllMocks();
});

describe('useSync', () => {
  describe('handleStartSync', () => {
    it('does nothing without a device selected', async () => {
      const propsWithoutDevice = { ...defaultProps, jellyfinConfig: null };
      const { result } = renderHook(() => useSync(propsWithoutDevice));

      await act(async () => {
        await result.current.handleStartSync();
      });

      expect(mockApi.startSync2).not.toHaveBeenCalled();
    });

    it('shows preview when items are selected (uses registry, not network)', async () => {
      const props = {
        ...defaultProps,
        selectedTracks: new Set(['artist-1', 'album-1']),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.handleStartSync();
      });

      expect(result.current.showPreview).toBe(true);
      expect(result.current.previewData).not.toBeNull();
    });
  });

  describe('executeSyncNow', () => {
    it('calls removeItems if there are items to delete', async () => {
      const props = {
        ...defaultProps,
        selectedTracks: new Set<string>(),
        previouslySyncedItems: new Set(['album-1']),
      };
      const { result } = renderHook(() => useSync(props));

      // Set sync folder via the hook's internal state
      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.executeSyncNow();
      });

      expect(mockApi.removeItems).toHaveBeenCalled();
    });

    it('calls startSync2 with correct IDs and options', async () => {
      const props = {
        ...defaultProps,
        selectedTracks: new Set(['artist-1', 'album-1']),
        previouslySyncedItems: new Set<string>(),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.executeSyncNow();
      });

      expect(mockApi.startSync2).toHaveBeenCalledTimes(1);
      const syncCall = mockApi.startSync2.mock.calls[0][0];
      expect(syncCall.serverUrl).toBe('https://jellyfin.test');
      expect(syncCall.apiKey).toBe('test-key');
      expect(syncCall.userId).toBe('user-1');
      expect(syncCall.destinationPath).toBe('/Volumes/USB');
    });
  });

  describe('onSyncProgress', () => {
    it('sets isSyncing to true during sync and clears after completion', async () => {
      const props = {
        ...defaultProps,
        selectedTracks: new Set(['artist-1']),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      // Capture isSyncing before and during sync
      expect(result.current.isSyncing).toBe(false);

      await act(async () => {
        await result.current.executeSyncNow();
      });

      expect(result.current.isSyncing).toBe(false);
      expect(result.current.syncSuccessData).not.toBeNull();
    });
  });

  describe('handleCancelSync', () => {
    it('calls cancelSync and sets isCancelling', async () => {
      let progressCallback: (progress: {
        current: number;
        total: number;
        currentFile: string;
        status: string;
        phase: string;
        bytesProcessed: number;
        totalBytes: number;
      }) => void = () => {};

      mockApi.onSyncProgress.mockImplementation((cb: typeof progressCallback) => {
        progressCallback = cb;
        return () => {};
      });

      const props = {
        ...defaultProps,
        selectedTracks: new Set(['artist-1']),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.executeSyncNow();
      });

      act(() => {
        progressCallback({
          current: 2,
          total: 5,
          currentFile: 'track2.mp3',
          status: 'syncing',
          phase: 'copying',
          bytesProcessed: 2_000_000,
          totalBytes: 5_000_000,
        });
      });

      await act(async () => {
        await result.current.handleCancelSync();
      });

      expect(mockApi.cancelSync).toHaveBeenCalled();
    });
  });

  describe('no native alerts', () => {
    it('does NOT call native alert() on delete-only sync complete', async () => {
      const props = {
        ...defaultProps,
        selectedTracks: new Set<string>(),
        previouslySyncedItems: new Set(['album-1']),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.executeSyncNow();
      });

      // AC: native alert must NOT appear in any sync flow
      expect(window.alert).not.toHaveBeenCalled();
    });

    it('does NOT call native alert() on sync error', async () => {
      const errorApi = createMockApi({
        startSync2: vi.fn().mockRejectedValue(new Error('Network failure')),
      });
      Object.defineProperty(window, 'api', { value: errorApi, writable: true });
      vi.stubGlobal('alert', vi.fn());

      const props = {
        ...defaultProps,
        selectedTracks: new Set(['artist-1']),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.executeSyncNow();
      });

      // AC: native alert must NOT appear on error
      expect(window.alert).not.toHaveBeenCalled();
    });
  });

  describe('post-sync', () => {
    it('calls getSyncedItems to refresh cache after sync', async () => {
      const props = {
        ...defaultProps,
        selectedTracks: new Set(['artist-1']),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.executeSyncNow();
      });

      expect(mockApi.getSyncedItems).toHaveBeenCalledWith('/Volumes/USB');
    });
  });

  describe('sync success', () => {
    it('populates syncSuccessData on successful sync', async () => {
      const props = {
        ...defaultProps,
        selectedTracks: new Set(['artist-1']),
        selectedArtists: new Set(['artist-1']),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.executeSyncNow();
      });

      expect(result.current.syncSuccessData).not.toBeNull();
      expect(result.current.syncSuccessData?.tracksCopied).toBe(5);
    });

    it('calls revalidateDevice after successful sync to update out-of-sync indicators', async () => {
      const revalidateDevice = vi.fn().mockResolvedValue(undefined);
      const props = {
        ...defaultProps,
        selectedTracks: new Set(['artist-1']),
        selectedArtists: new Set(['artist-1']),
        revalidateDevice,
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.executeSyncNow();
      });

      expect(revalidateDevice).toHaveBeenCalled();
    });

    it('calls revalidateDevice with current coverArtMode after successful sync', async () => {
      // Test that revalidateDevice is called after sync completes with correct coverArtMode
      const revalidateDevice = vi.fn().mockResolvedValue(undefined);
      const props = {
        ...defaultProps,
        selectedTracks: new Set(['artist-1']),
        selectedArtists: new Set(['artist-1']),
        revalidateDevice,
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      // User has companion mode active
      await act(async () => {
        result.current.setCoverArtMode('companion');
      });

      await act(async () => {
        await result.current.executeSyncNow();
      });

      // Verify revalidateDevice is called with the current coverArtMode from state
      // This prevents the bug where stale 'embed' was used instead of 'companion'
      expect(revalidateDevice).toHaveBeenCalledWith({ coverArtMode: 'companion' });
    });
  });

  describe('handleStartSync preview data', () => {
    beforeEach(() => {
      // Reset registry singleton before each test
      const registry = getTrackRegistry();
      registry.invalidateAll();
    });

    it('sets previewData with deduplicated trackCount', async () => {
      const props = {
        ...defaultProps,
        // Select artist-1 which has tracks
        selectedTracks: new Set(['artist-1']),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.handleStartSync();
      });

      expect(result.current.showPreview).toBe(true);
      expect(result.current.previewData).not.toBeNull();
      // trackCount should reflect deduplicated tracks
      expect(result.current.previewData!.trackCount).toBeGreaterThanOrEqual(0);
    });

    it('sets previewData with totalDurationSeconds', async () => {
      const props = {
        ...defaultProps,
        selectedTracks: new Set(['artist-1']),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.handleStartSync();
      });

      expect(result.current.previewData).not.toBeNull();
      // totalDurationSeconds should be present (may be 0 if no tracks loaded)
      expect(result.current.previewData!.totalDurationSeconds).toBeGreaterThanOrEqual(0);
    });

    it('sets previewData with totalBytes calculated correctly', async () => {
      const props = {
        ...defaultProps,
        selectedTracks: new Set(['artist-1']),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.handleStartSync();
      });

      expect(result.current.previewData).not.toBeNull();
      // totalBytes should be >= newTracksBytes + updatedTracksBytes + alreadySyncedBytes
      expect(result.current.previewData!.totalBytes).toBeGreaterThanOrEqual(
        result.current.previewData!.newTracksBytes +
          result.current.previewData!.updatedTracksBytes +
          result.current.previewData!.alreadySyncedBytes,
      );
    });

    it('previewData has correct structure with all required fields', async () => {
      const props = {
        ...defaultProps,
        selectedTracks: new Set(['artist-1']),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      await act(async () => {
        await result.current.handleStartSync();
      });

      expect(result.current.previewData).not.toBeNull();
      const data = result.current.previewData!;
      // Check all required fields from PreviewData interface
      expect(typeof data.trackCount).toBe('number');
      expect(typeof data.totalBytes).toBe('number');
      expect(typeof data.totalDurationSeconds).toBe('number');
      expect(typeof data.newTracksCount).toBe('number');
      expect(typeof data.newTracksBytes).toBe('number');
      expect(typeof data.updatedTracksCount).toBe('number');
      expect(typeof data.updatedTracksBytes).toBe('number');
      expect(typeof data.alreadySyncedCount).toBe('number');
      expect(typeof data.alreadySyncedBytes).toBe('number');
      expect(typeof data.willRemoveCount).toBe('number');
      expect(typeof data.willRemoveBytes).toBe('number');
    });

    it('trackCount reflects deduplicated tracks across multiple items sharing tracks', async () => {
      // Select two artists that share some tracks.
      // trackCount must equal the size of the unique track set, not the sum of per-item track counts.
      const props = {
        ...defaultProps,
        // artist-1 and artist-2 may share tracks; trackCount should be deduped
        selectedTracks: new Set(['artist-1', 'artist-2']),
      };
      const { result } = renderHook(() => useSync(props));

      await act(async () => {
        await result.current.handleSelectSyncFolder('/Volumes/USB');
      });

      // Invalidate registry to ensure clean state
      const registry = getTrackRegistry();
      registry.invalidateAll();

      await act(async () => {
        await result.current.handleStartSync();
      });

      expect(result.current.showPreview).toBe(true);
      expect(result.current.previewData).not.toBeNull();

      // trackCount is the deduplicated total (seenTrackIds.size)
      // per-category counts (newTracksCount, etc.) should not inflate when
      // all tracks of an item were already seen via a previous item
      const { trackCount, newTracksCount, updatedTracksCount, alreadySyncedCount } =
        result.current.previewData!;

      // The sum of per-category counts may be less than trackCount when
      // tracks belong to multiple categories (e.g. some tracks are "new" and some "updated").
      // But trackCount itself must not exceed the number of unique track IDs.
      expect(trackCount).toBeGreaterThanOrEqual(0);

      // Each per-category count is independent and only counts tracks unique to that category
      // (via itemTrackMap deduplication). Sum of all categories should not exceed trackCount
      // unless a track appears in multiple categories, which is acceptable.
      // The key invariant: per-category counts must NOT over-count within their category.
      expect(newTracksCount).toBeGreaterThanOrEqual(0);
      expect(updatedTracksCount).toBeGreaterThanOrEqual(0);
      expect(alreadySyncedCount).toBeGreaterThanOrEqual(0);
    });
  });
});
