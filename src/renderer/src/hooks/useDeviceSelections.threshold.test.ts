import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Mock logger to test warning emission
vi.mock('@/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
 error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { MAX_UNCACHED_FETCH_COUNT, shouldSkipUncachedFetch } from './useDeviceSelections';
import { logger } from '@/utils/logger';

describe('MAX_UNCACHED_FETCH_COUNT threshold guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('threshold constant', () => {
    it('exports MAX_UNCACHED_FETCH_COUNT = 50', () => {
      expect(MAX_UNCACHED_FETCH_COUNT).toBe(50);
    });
  });

  describe('shouldSkipUncachedFetch helper', () => {
    it('(a) selecting 51 items skips fetch and emits warning', () => {
      // Simulate 51 uncached item IDs (above threshold of 50)
      const uncachedIds = Array.from({ length: 51 }, (_, i) => `item-${i}`);

      const shouldSkip = shouldSkipUncachedFetch(uncachedIds);

      // Should skip fetch
      expect(shouldSkip).toBe(true);

      // Should emit warning
      expect(logger.warn).toHaveBeenCalledWith(
        '[useDeviceSelections] Skipping fetch: 51 uncached items exceed threshold of 50',
      );
    });

    it('(b) selecting 49 items allows fetch to proceed', () => {
      // Simulate 49 uncached item IDs (below threshold of 50)
      const uncachedIds = Array.from({ length: 49 }, (_, i) => `item-${i}`);

      const shouldSkip = shouldSkipUncachedFetch(uncachedIds);

      // Should NOT skip fetch
      expect(shouldSkip).toBe(false);

      // No warning should be emitted
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('(c) selecting 51 then deselecting to 45 allows fetch on second call', () => {
      // First selection: 51 items (above threshold)
      let shouldSkip = shouldSkipUncachedFetch(Array.from({ length: 51 }, (_, i) => `item-${i}`));

      expect(shouldSkip).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        '[useDeviceSelections] Skipping fetch: 51 uncached items exceed threshold of 50',
      );

      // Reset warning spy
      vi.clearAllMocks();

      // Deselect 6 items → 45 items (below threshold)
      shouldSkip = shouldSkipUncachedFetch(Array.from({ length: 45 }, (_, i) => `item-${i}`));

      // Should now allow fetch
      expect(shouldSkip).toBe(false);

      // No warning about exceeding threshold
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('exactly 50 items allows fetch (threshold is exclusive)', () => {
      const uncachedIds = Array.from({ length: 50 }, (_, i) => `item-${i}`);
      const shouldSkip = shouldSkipUncachedFetch(uncachedIds);

      expect(shouldSkip).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('empty array returns true without warning', () => {
      const shouldSkip = shouldSkipUncachedFetch([]);

      expect(shouldSkip).toBe(true);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
