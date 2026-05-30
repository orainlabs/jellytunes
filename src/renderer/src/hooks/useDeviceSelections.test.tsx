// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the track registry before importing useDeviceSelections
const mockRegistry = {
  loadDeviceSyncedTracks: vi.fn().mockResolvedValue(undefined),
  ensureItemTracks: vi.fn().mockResolvedValue(undefined),
  setItemTicks: vi.fn(),
  setItemTypes: vi.fn(),
  fetchTracksForItems: vi.fn().mockResolvedValue(true),
  calculateSize: vi.fn().mockReturnValue({ total: null, isTickEstimate: false }),
  countNewTracks: vi.fn().mockReturnValue(0),
  getSyncedMusicBytes: vi.fn().mockReturnValue(0),
  invalidateAll: vi.fn(),
  invalidateItem: vi.fn(),
  invalidateDevice: vi.fn(),
  isDeviceLoading: vi.fn().mockReturnValue(false),
  getItemTrackIds: vi.fn().mockReturnValue([]),
  getItemType: vi.fn().mockReturnValue('artist'),
  isBackgroundFetchingDevice: vi.fn().mockReturnValue(false),
  setTickEstimate: vi.fn(),
  isTickEstimateActive: vi.fn().mockReturnValue(false),
  hasItemTracks: vi.fn().mockReturnValue(false),
  countRemoveTracks: vi.fn().mockReturnValue(0),
};

vi.mock('./useTrackRegistry', () => ({
  getTrackRegistry: () => mockRegistry,
  createTrackRegistry: () => mockRegistry,
}));

const defaultOptions = {
  serverUrl: 'https://jellyfin.test',
  apiKey: 'test-key',
  userId: 'user-1',
  itemIds: ['artist-1', 'album-1', 'playlist-1'],
  itemTypes: {
    'artist-1': 'artist' as const,
    'album-1': 'album' as const,
    'playlist-1': 'playlist' as const,
  },
  convertToMp3: false,
  bitrate: '192k' as const,
  coverArtMode: 'embed' as const,
};

const mockApi = {
  getSyncedItems: vi.fn().mockResolvedValue([]),
  getSyncedTracks: vi.fn().mockResolvedValue([]),
  getTracksForItem: vi.fn().mockResolvedValue({ tracks: [], errors: [] }),
  getTracksForItems: vi.fn().mockResolvedValue({ tracks: [], errors: [] }),
  analyzeDiff: vi.fn().mockResolvedValue({
    success: true,
    items: [],
    totals: { newTracks: 0, metadataChanged: 0, removed: 0, pathChanged: 0, unchanged: 0 },
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', { value: mockApi, writable: true });
  // Reset mock registry state
  mockRegistry.loadDeviceSyncedTracks.mockResolvedValue(undefined);
  mockRegistry.ensureItemTracks.mockResolvedValue(undefined);
  mockRegistry.setItemTicks.mockClear();
  mockRegistry.setItemTypes.mockClear();
  mockRegistry.fetchTracksForItems.mockResolvedValue(true);
  mockRegistry.calculateSize.mockReturnValue({ total: null, isTickEstimate: false });
  mockRegistry.countNewTracks.mockReturnValue(0);
  mockRegistry.getSyncedMusicBytes.mockReturnValue(0);
  mockRegistry.getItemTrackIds.mockReturnValue([]);
  mockRegistry.getItemType.mockReturnValue('artist');
  mockRegistry.isBackgroundFetchingDevice.mockReturnValue(false);
  mockRegistry.setTickEstimate.mockClear();
  mockRegistry.isTickEstimateActive.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

// Dynamic import to ensure mocks are set up before module loads
import { useDeviceSelections } from './useDeviceSelections';

describe('useDeviceSelections', () => {
  describe('activateDevice', () => {
    it('fresh install: getSyncedItems called, analyzeDiff NOT called (idsToAnalyze is empty)', async () => {
      mockApi.getSyncedItems.mockResolvedValue([]);

      const { result } = renderHook(() => useDeviceSelections());

      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      expect(mockApi.getSyncedItems).toHaveBeenCalledWith('/Volumes/USB');
      expect(mockApi.analyzeDiff).not.toHaveBeenCalled();
    });

    it('with items synced: analyzeDiff called only with idsToAnalyze (not all IDs)', async () => {
      mockApi.getSyncedItems.mockResolvedValue([
        { id: 'artist-1', name: 'The Beatles', type: 'artist' as const },
      ]);
      mockApi.analyzeDiff.mockResolvedValue({
        success: true,
        items: [],
        totals: { newTracks: 0, metadataChanged: 0, removed: 0, pathChanged: 0, unchanged: 0 },
      });

      const { result } = renderHook(() => useDeviceSelections());

      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      expect(mockApi.analyzeDiff).toHaveBeenCalledTimes(1);
      const analyzeDiffCall = mockApi.analyzeDiff.mock.calls[0][0];
      expect(analyzeDiffCall.itemIds).toEqual(['artist-1']);
      expect(analyzeDiffCall.itemIds).not.toEqual(defaultOptions.itemIds);
    });

    it('calls loadDeviceSyncedTracks for device size calculation', async () => {
      mockApi.getSyncedItems.mockResolvedValue([]);
      mockRegistry.loadDeviceSyncedTracks.mockResolvedValue(undefined);

      const { result } = renderHook(() => useDeviceSelections());

      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      expect(mockRegistry.loadDeviceSyncedTracks).toHaveBeenCalledWith('/Volumes/USB');
    });
  });

  describe('toggleItem', () => {
    it('selects an item correctly', async () => {
      mockApi.getSyncedItems.mockResolvedValue([]);

      const { result } = renderHook(() => useDeviceSelections());

      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      await act(async () => {
        result.current.toggleItem('album-1');
      });

      expect(result.current.selectedTracks.has('album-1')).toBe(true);
    });

    it('deselects an already-selected item correctly', async () => {
      mockApi.getSyncedItems.mockResolvedValue([]);

      const { result } = renderHook(() => useDeviceSelections());

      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      await act(async () => {
        result.current.toggleItem('album-1');
      });
      expect(result.current.selectedTracks.has('album-1')).toBe(true);

      await act(async () => {
        result.current.toggleItem('album-1');
      });
      expect(result.current.selectedTracks.has('album-1')).toBe(false);
    });

    it('fetches real track data for a newly selected uncached item (convertToMp3=false)', async () => {
      vi.useFakeTimers();
      mockApi.getSyncedItems.mockResolvedValue([]);
      mockRegistry.getItemTrackIds.mockReturnValue([]); // uncached

      const { result } = renderHook(() => useDeviceSelections());
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });
      mockRegistry.fetchTracksForItems.mockClear();

      await act(async () => {
        result.current.toggleItem('album-1');
        vi.advanceTimersByTime(500);
      });

      vi.useRealTimers();
      expect(mockRegistry.fetchTracksForItems).toHaveBeenCalledWith(
        ['album-1'],
        '/Volumes/USB',
        expect.objectContaining({
          serverUrl: defaultOptions.serverUrl,
          apiKey: defaultOptions.apiKey,
          userId: defaultOptions.userId,
        }),
      );
    });

    it('does NOT fetch when deselecting an item', async () => {
      mockApi.getSyncedItems.mockResolvedValue([]);

      const { result } = renderHook(() => useDeviceSelections());
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      await act(async () => {
        result.current.toggleItem('album-1'); // select
      });
      mockRegistry.fetchTracksForItems.mockClear();

      await act(async () => {
        result.current.toggleItem('album-1'); // deselect
      });

      expect(mockRegistry.fetchTracksForItems).not.toHaveBeenCalled();
    });

    it('does NOT fetch when convertToMp3=true (tick estimation only)', async () => {
      mockApi.getSyncedItems.mockResolvedValue([]);

      const { result } = renderHook(() => useDeviceSelections());
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', {
          ...defaultOptions,
          convertToMp3: true,
        });
      });
      mockRegistry.fetchTracksForItems.mockClear();

      await act(async () => {
        result.current.toggleItem('album-1');
      });

      expect(mockRegistry.fetchTracksForItems).not.toHaveBeenCalled();
    });

    it('does NOT fetch for an already-cached item', async () => {
      mockApi.getSyncedItems.mockResolvedValue([]);
      mockRegistry.getItemTrackIds.mockReturnValue(['track-1']); // already cached

      const { result } = renderHook(() => useDeviceSelections());
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });
      mockRegistry.fetchTracksForItems.mockClear();

      await act(async () => {
        result.current.toggleItem('album-1');
      });

      expect(mockRegistry.fetchTracksForItems).not.toHaveBeenCalled();
    });
  });

  describe('selectItems', () => {
    it('adds multiple items to selectedItems', async () => {
      mockApi.getSyncedItems.mockResolvedValue([]);

      const { result } = renderHook(() => useDeviceSelections());

      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      await act(async () => {
        result.current.selectItems([{ Id: 'artist-1' }, { Id: 'album-2' }, { Id: 'playlist-1' }]);
      });

      expect(result.current.selectedTracks.has('artist-1')).toBe(true);
      expect(result.current.selectedTracks.has('album-2')).toBe(true);
      expect(result.current.selectedTracks.has('playlist-1')).toBe(true);
    });

    it('fetches real track data for newly added uncached items', async () => {
      vi.useFakeTimers();
      mockApi.getSyncedItems.mockResolvedValue([]);
      mockRegistry.getItemTrackIds.mockReturnValue([]); // uncached

      const { result } = renderHook(() => useDeviceSelections());
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });
      mockRegistry.fetchTracksForItems.mockClear();

      await act(async () => {
        result.current.selectItems([{ Id: 'artist-1' }, { Id: 'album-1' }]);
        vi.advanceTimersByTime(500);
      });

      vi.useRealTimers();
      expect(mockRegistry.fetchTracksForItems).toHaveBeenCalledTimes(1);
      const [ids, path] = mockRegistry.fetchTracksForItems.mock.calls[0];
      expect(new Set(ids)).toEqual(new Set(['artist-1', 'album-1']));
      expect(path).toBe('/Volumes/USB');
    });
  });

  describe('clearSelection', () => {
    it('empties selectedItems', async () => {
      mockApi.getSyncedItems.mockResolvedValue([]);

      const { result } = renderHook(() => useDeviceSelections());

      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      await act(async () => {
        result.current.selectItems([{ Id: 'artist-1' }, { Id: 'album-1' }]);
      });
      expect(result.current.selectedTracks.size).toBeGreaterThan(0);

      await act(async () => {
        result.current.clearSelection();
      });

      expect(result.current.selectedTracks.size).toBe(0);
    });
  });

  describe('removeDevice', () => {
    it('clears state and activeDevicePath', async () => {
      mockApi.getSyncedItems.mockResolvedValue([]);

      const { result } = renderHook(() => useDeviceSelections());

      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      expect(result.current.activeDevicePath).toBe('/Volumes/USB');

      act(() => {
        result.current.removeDevice('/Volumes/USB');
      });

      expect(result.current.activeDevicePath).toBe(null);
      expect(result.current.selectedTracks.size).toBe(0);
    });
  });

  describe('rapid device switching', () => {
    it('maintains correct state for the last activated device', async () => {
      mockApi.getSyncedItems.mockResolvedValue([]);

      const { result } = renderHook(() => useDeviceSelections());

      await act(async () => {
        await result.current.activateDevice('/Volumes/USB1', defaultOptions);
      });

      await act(async () => {
        result.current.selectItems([{ Id: 'artist-1' }]);
      });

      mockApi.getSyncedItems.mockResolvedValue([
        { id: 'album-1', name: 'Album One', type: 'album' as const },
      ]);

      await act(async () => {
        await result.current.activateDevice('/Volumes/USB2', {
          ...defaultOptions,
          itemIds: ['album-1'],
          itemTypes: { 'album-1': 'album' as const },
        });
      });

      expect(result.current.activeDevicePath).toBe('/Volumes/USB2');
      expect(result.current.selectedTracks.has('artist-1')).toBe(false);
    });
  });

  describe('outOfSyncItems', () => {
    it('populated when analyzeDiff returns items with changes', async () => {
      mockApi.getSyncedItems.mockResolvedValue([
        { id: 'artist-1', name: 'The Beatles', type: 'artist' as const },
      ]);
      mockApi.analyzeDiff.mockResolvedValue({
        success: true,
        items: [
          {
            itemId: 'artist-1',
            itemName: 'The Beatles',
            itemType: 'artist',
            changes: [],
            summary: { new: 0, metadataChanged: 1, removed: 0, pathChanged: 0, unchanged: 0 },
          },
        ],
        totals: { newTracks: 0, metadataChanged: 1, removed: 0, pathChanged: 0, unchanged: 0 },
      });

      const { result } = renderHook(() => useDeviceSelections());

      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      expect(result.current.outOfSyncItems.has('artist-1')).toBe(true);
    });

    it('second activateDevice with SAME path+options skips analyzeDiff (no unnecessary recalculation)', async () => {
      mockApi.getSyncedItems.mockResolvedValue([
        { id: 'artist-1', name: 'The Beatles', type: 'artist' as const },
      ]);
      mockApi.analyzeDiff.mockResolvedValue({
        success: true,
        items: [],
        totals: { newTracks: 0, metadataChanged: 0, removed: 0, pathChanged: 0, unchanged: 0 },
      });

      const { result } = renderHook(() => useDeviceSelections());

      // First activation
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      // Second activation — same path AND same options → must NOT trigger analyzeDiff
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      // analyzeDiff should be called exactly once (first activation), not twice
      expect(mockApi.analyzeDiff).toHaveBeenCalledTimes(1);
      // getSyncedItems also skipped when cache key unchanged and path already active
      expect(mockApi.getSyncedItems).toHaveBeenCalledTimes(1);
    });

    it('second activateDevice with DIFFERENT itemIds retriggers analyzeDiff', async () => {
      mockApi.getSyncedItems.mockResolvedValue([
        { id: 'artist-1', name: 'The Beatles', type: 'artist' as const },
      ]);

      const { result } = renderHook(() => useDeviceSelections());

      // First activation
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      // Second activation with different selection
      const differentOptions = {
        ...defaultOptions,
        itemIds: ['artist-1', 'album-1'],
        itemTypes: { 'artist-1': 'artist' as const, 'album-1': 'album' as const },
      };
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', differentOptions);
      });

      // analyzeDiff should be called again for the new itemIds
      expect(mockApi.analyzeDiff).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateCache', () => {
    it('after invalidation, activateDevice re-runs analyzeDiff even with same params', async () => {
      mockApi.getSyncedItems.mockResolvedValue([
        { id: 'artist-1', name: 'The Beatles', type: 'artist' as const },
      ]);

      const { result } = renderHook(() => useDeviceSelections());

      // First activation
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });
      expect(mockApi.analyzeDiff).toHaveBeenCalledTimes(1);

      // Invalidate cache (simulates library refresh detecting server changes)
      await act(async () => {
        result.current.invalidateCache();
      });

      // Second activation with SAME params → should re-run because cache was invalidated
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      expect(mockApi.analyzeDiff).toHaveBeenCalledTimes(2);
    });
  });

  describe('revalidateDevice', () => {
    it('re-runs analyzeDiff with the same params as last activation', async () => {
      mockApi.getSyncedItems.mockResolvedValue([
        { id: 'artist-1', name: 'The Beatles', type: 'artist' as const },
      ]);

      const { result } = renderHook(() => useDeviceSelections());

      // First activation with specific options
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });
      expect(mockApi.analyzeDiff).toHaveBeenCalledTimes(1);

      // revalidateDevice should call activateDevice again with same params
      await act(async () => {
        await result.current.revalidateDevice();
      });

      expect(mockApi.analyzeDiff).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateConvertOptions', () => {
    it('smoke test: calls without throwing', async () => {
      mockApi.getSyncedItems.mockResolvedValue([]);

      const { result } = renderHook(() => useDeviceSelections());

      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });

      await act(async () => {
        result.current.updateConvertOptions(true, '320k', 'companion');
      });
    });

    it('skips fetch when uncached items exceed MAX_UNCACHED_FETCH_COUNT', async () => {
      vi.useFakeTimers();
      mockApi.getSyncedItems.mockResolvedValue([]);
      // Create 60 items (exceeds threshold of 50)
      const largeItemIds = Array.from({ length: 60 }, (_, i) => `album-${i}`);
      const largeItemTypes = Object.fromEntries(largeItemIds.map((id) => [id, 'album' as const]));
      // Mock registry.getItemTrackIds to return empty (uncached)
      mockRegistry.getItemTrackIds.mockReturnValue([]);
      mockRegistry.fetchTracksForItems.mockClear();

      const { result } = renderHook(() => useDeviceSelections());

      // Activate with convertToMp3=true first
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', {
          ...defaultOptions,
          itemIds: largeItemIds,
          itemTypes: largeItemTypes,
          convertToMp3: true,
        });
      });
      mockRegistry.fetchTracksForItems.mockClear();

      // Switch to convertToMp3=false - should skip fetch due to threshold
      await act(async () => {
        result.current.updateConvertOptions(false, '320k');
        vi.advanceTimersByTime(0); // flush microtasks
      });

      vi.useRealTimers();

      // Verify fetch was NOT called (skipped due to threshold)
      expect(mockRegistry.fetchTracksForItems).not.toHaveBeenCalled();
    });

    it('persists coverArtMode change across revalidation', async () => {
      mockApi.getSyncedItems.mockResolvedValue([
        { id: 'artist-1', name: 'The Beatles', type: 'artist' as const },
      ]);
      mockApi.analyzeDiff.mockResolvedValue({
        success: true,
        items: [],
        totals: { newTracks: 0, metadataChanged: 0, removed: 0, pathChanged: 0, unchanged: 0 },
      });

      const { result } = renderHook(() => useDeviceSelections());

      // First activation with embed mode
      await act(async () => {
        await result.current.activateDevice('/Volumes/USB', defaultOptions);
      });
      expect(mockApi.analyzeDiff).toHaveBeenCalledTimes(1);
      expect(mockApi.analyzeDiff.mock.calls[0][0].options.coverArtMode).toBe('embed');

      // Change coverArtMode to companion
      await act(async () => {
        result.current.updateConvertOptions(false, '192k', 'companion');
      });

      // Revalidate should use companion mode in the next analyzeDiff call
      await act(async () => {
        await result.current.revalidateDevice();
      });

      expect(mockApi.analyzeDiff).toHaveBeenCalledTimes(2);
      expect(mockApi.analyzeDiff.mock.calls[1][0].options.coverArtMode).toBe('companion');
    });
  });
});
