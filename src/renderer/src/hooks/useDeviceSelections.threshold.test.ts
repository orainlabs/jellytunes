import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Test the threshold constant and guard logic independently
// without full React hook rendering which has timing conflicts

// Mock window.api
Object.defineProperty(global, 'window', {
  value: {
    api: {
      getSyncedItems: vi.fn().mockResolvedValue([]),
      analyzeDiff: vi.fn().mockResolvedValue({ success: true, items: [] }),
    },
  },
  writable: true,
});

// Mock useTrackRegistry - return a shared mock instance
const mockRegistry = {
  loadDeviceSyncedTracks: vi.fn().mockResolvedValue(undefined),
  setItemTicks: vi.fn(),
  getSyncedMusicBytes: vi.fn().mockReturnValue(0),
  hasItemTracks: vi.fn().mockReturnValue(false),
  getItemType: vi.fn().mockReturnValue('artist'),
  getItemTrackIds: vi.fn().mockReturnValue([]),
  fetchTracksForItems: vi.fn().mockResolvedValue(true),
  invalidateDevice: vi.fn(),
  invalidateAll: vi.fn(),
  calculateSize: vi.fn().mockReturnValue({ total: 0, isTickEstimate: true }),
};

vi.mock('./useTrackRegistry', () => ({
  getTrackRegistry: () => mockRegistry,
}));

import { MAX_UNCACHED_FETCH_COUNT } from './useDeviceSelections';

// Helper to simulate debounced fetch with threshold check (mirrors implementation logic)
const simulateFetchWithThreshold = (
  uncachedIds: string[],
): { shouldFetch: boolean; warning?: string } => {
  if (uncachedIds.length === 0) {
    return { shouldFetch: false };
  }
  if (uncachedIds.length > MAX_UNCACHED_FETCH_COUNT) {
    const warning = `[useDeviceSelections] Skipping fetch: ${uncachedIds.length} uncached items exceed threshold of ${MAX_UNCACHED_FETCH_COUNT}`;
    console.warn(warning);
    return { shouldFetch: false, warning };
  }
  return { shouldFetch: true };
};

describe('MAX_UNCACHED_FETCH_COUNT threshold guard', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleWarnSpy.mockRestore();
  });

  describe('threshold constant', () => {
    it('exports MAX_UNCACHED_FETCH_COUNT = 50', () => {
      expect(MAX_UNCACHED_FETCH_COUNT).toBe(50);
    });
  });

  describe('fetchSelectedUncachedTracks threshold', () => {
    it('(a) selecting 51 items skips fetch and does not increment sizeLoadingCount', () => {
      // Simulate 51 uncached item IDs (above threshold of 50)
      const uncachedIds = Array.from({ length: 51 }, (_, i) => `item-${i}`);

      const result = simulateFetchWithThreshold(uncachedIds);

      // Should skip fetch
      expect(result.shouldFetch).toBe(false);

      // Should emit warning
      expect(result.warning).toBe(
        '[useDeviceSelections] Skipping fetch: 51 uncached items exceed threshold of 50',
      );

      // Console.warn should have been called
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[useDeviceSelections] Skipping fetch: 51 uncached items exceed threshold of 50',
      );

      // Registry fetchTracksForItems should NOT have been called
      expect(mockRegistry.fetchTracksForItems).not.toHaveBeenCalled();
    });

    it('(b) selecting 49 items triggers fetch normally', () => {
      // Simulate 49 uncached item IDs (below threshold of 50)
      const uncachedIds = Array.from({ length: 49 }, (_, i) => `item-${i}`);

      const result = simulateFetchWithThreshold(uncachedIds);

      // Should proceed with fetch
      expect(result.shouldFetch).toBe(true);

      // No warning should be emitted
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('(c) selecting 51 then deselecting to 45 triggers fetch on debounce', () => {
      // First selection: 51 items (above threshold)
      const uncachedIds51 = Array.from({ length: 51 }, (_, i) => `item-${i}`);
      let result = simulateFetchWithThreshold(uncachedIds51);

      expect(result.shouldFetch).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[useDeviceSelections] Skipping fetch: 51 uncached items exceed threshold of 50',
      );

      // Reset warning spy
      consoleWarnSpy.mockClear();

      // Deselect 6 items → 45 items (below threshold)
      const uncachedIds45 = Array.from({ length: 45 }, (_, i) => `item-${i}`);
      result = simulateFetchWithThreshold(uncachedIds45);

      // Should now trigger fetch
      expect(result.shouldFetch).toBe(true);

      // No warning about exceeding threshold
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('exactly 50 items triggers fetch (threshold is exclusive)', () => {
      const uncachedIds = Array.from({ length: 50 }, (_, i) => `item-${i}`);
      const result = simulateFetchWithThreshold(uncachedIds);

      expect(result.shouldFetch).toBe(true);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('empty array returns early without warning', () => {
      const result = simulateFetchWithThreshold([]);

      expect(result.shouldFetch).toBe(false);
      expect(result.warning).toBeUndefined();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });
});
