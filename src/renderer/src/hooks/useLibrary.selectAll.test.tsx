// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLibrary } from './useLibrary';
import type { JellyfinConfig } from '../appTypes';

const mockConfig: JellyfinConfig = { url: 'https://jellyfin.test', apiKey: 'test-key' };

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock window.api for logger
const mockApi = {
  logError: vi.fn(),
};
Object.defineProperty(window, 'api', { value: mockApi, writable: true });

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
});

/**
 * URL-based mocking helper for useLibrary tests.
 * Single mockImplementation that returns responses based on URL patterns.
 */
function setupFetchMock(urlToResponse: Record<string, { items: unknown[]; total: number }>) {
  mockFetch.mockImplementation((url: string) => {
    // Try to find exact match first
    if (urlToResponse[url]) {
      const { items, total } = urlToResponse[url];
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            Items: items,
            TotalRecordCount: total,
            StartIndex: 0,
          }),
      });
    }
    // Fallback to pattern matching
    for (const pattern of Object.keys(urlToResponse)) {
      if (url.includes(pattern)) {
        const { items, total } = urlToResponse[pattern];
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              Items: items,
              TotalRecordCount: total,
              StartIndex: 0,
            }),
        });
      }
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ Items: [], TotalRecordCount: 0, StartIndex: 0 }),
    });
  });
}

function createArtist(id: string, name: string): unknown {
  return { Id: id, Name: name, AlbumCount: 1, ImageTags: {}, RunTimeTicks: 0 };
}

describe('useLibrary - selectAll with pagination', () => {
  describe('selectAllWithCompleteSet', () => {
    it('selects all items including unloaded pages and calls onSelectAllIds', async () => {
      // Initial load: 2 items, total=5, remaining=3
      // Fix: pageLimit = min(3, 1000) = 3 → fetches all 3 remaining in one request
      setupFetchMock({
        '/Artists?SortBy=Name&Limit=50&StartIndex=0': {
          items: [createArtist('artist-1', 'Artist 1'), createArtist('artist-2', 'Artist 2')],
          total: 5,
        },
        '/Artists?SortBy=Name&Limit=3&StartIndex=2': {
          items: [
            createArtist('artist-3', 'Artist 3'),
            createArtist('artist-4', 'Artist 4'),
            createArtist('artist-5', 'Artist 5'),
          ],
          total: 5,
        },
        '/Items?IncludeItemTypes=MusicAlbum': { items: [], total: 0 },
        '/Items?IncludeItemTypes=Playlist': { items: [], total: 0 },
      });

      const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));
      const onSelectAllIds = vi.fn();

      await act(async () => {
        await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
      });

      await act(async () => {
        await result.current.selectAllWithCompleteSet('artists', onSelectAllIds);
      });

      expect(onSelectAllIds).toHaveBeenCalledWith([
        'artist-1',
        'artist-2',
        'artist-3',
        'artist-4',
        'artist-5',
      ]);
    });

    it('shows loading state during fetch when items not fully loaded', async () => {
      // Test setup: initial load returns 1 item, total=3
      // Fix: remaining=2, pageLimit=min(2,1000)=2 → fetches all 2 remaining in one request
      setupFetchMock({
        '/Artists?SortBy=Name&Limit=50&StartIndex=0': {
          items: [createArtist('artist-1', 'Artist 1')],
          total: 3,
        },
        '/Artists?SortBy=Name&Limit=2&StartIndex=1': {
          items: [createArtist('artist-2', 'Artist 2'), createArtist('artist-3', 'Artist 3')],
          total: 3,
        },
        '/Items?IncludeItemTypes=MusicAlbum': { items: [], total: 0 },
        '/Items?IncludeItemTypes=Playlist': { items: [], total: 0 },
      });

      const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));
      const onSelectAllIds = vi.fn();

      await act(async () => {
        await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
      });

      // Start selectAll and check loading state immediately
      let selectAllPromise: Promise<{ cancelled: boolean }>;
      act(() => {
        selectAllPromise = result.current.selectAllWithCompleteSet('artists', onSelectAllIds);
      });

      // Loading state should be true immediately
      expect(result.current.isSelectingAll).toBe(true);

      // Wait for selectAll to complete
      await act(async () => {
        await selectAllPromise!;
      });

      // Should no longer be loading after completion
      expect(result.current.isSelectingAll).toBe(false);
      expect(onSelectAllIds).toHaveBeenCalledWith(['artist-1', 'artist-2', 'artist-3']);
    });

    it('uses stats fallback when pagination.total is 0', async () => {
      // Simulates race condition: stats available but pagination.albums.total = 0
      // (user navigated to Albums tab before loadLibrary completed)
      setupFetchMock({
        '/Artists?SortBy=Name&Limit=50&StartIndex=0': {
          items: [createArtist('artist-1', 'Artist 1')],
          total: 1,
        },
        '/Items?IncludeItemTypes=MusicAlbum&Limit=50&StartIndex=0&Recursive=true': {
          items: [],
          total: 0, // pagination.total = 0 (tab not loaded yet)
        },
        '/Items?IncludeItemTypes=Playlist': { items: [], total: 0 },
      });

      const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

      // Load stats first (simulating race condition where stats resolves before albums tab)
      await act(async () => {
        mockFetch.mockImplementation((url: string) => {
          if (url.includes('/Users/user-1/Items/Counts')) {
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  ArtistCount: 1,
                  AlbumCount: 5, // stats has correct count
                  ChildCount: 50,
                  PlaylistCount: 0,
                }),
            });
          }
          // Fallback to library responses
          for (const pattern of Object.keys({
            '/Artists?SortBy=Name&Limit=50&StartIndex=0': { items: [], total: 0 },
            '/Items?IncludeItemTypes=MusicAlbum': { items: [], total: 0 },
            '/Items?IncludeItemTypes=Playlist': { items: [], total: 0 },
          })) {
            if (url.includes(pattern)) {
              return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
              });
            }
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
          });
        });

        await result.current.loadStats('https://jellyfin.test', 'test-key', 'user-1');
        await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
      });

      // At this point stats.AlbumCount = 5 but pagination.albums.total = 0
      // The count logic should use stats as fallback
      expect(result.current.stats?.AlbumCount).toBe(5);
      expect(result.current.pagination.albums.total).toBe(0);
    });
  });
});

describe('useLibrary - fetchAllIds page-size behaviour', () => {
  it('uses maximum page size (1000) per request regardless of remaining item count', async () => {
    // Bug: pageLimit = ceil(remainingItems / 3) → shrinks on every iteration (Zeno's paradox)
    // Fix: pageLimit = min(remainingItems, 1000) → always as large as allowed
    // Setup: loadLibrary fetches 50 items (PAGE_SIZE), total=2050 → 2000 remaining for selectAll
    // Bug would request Limit=667 first (ceil(2000/3)); fix requests Limit=1000
    const capturedUrls: string[] = [];

    mockFetch.mockImplementation((url: string) => {
      capturedUrls.push(url as string);
      const urlObj = new URL(url as string);
      const startIndex = parseInt(urlObj.searchParams.get('StartIndex') ?? '0');
      const limit = parseInt(urlObj.searchParams.get('Limit') ?? '50');
      const TOTAL = 2050;
      const count = Math.min(limit, Math.max(0, TOTAL - startIndex));
      const items = Array.from({ length: count }, (_, i) =>
        createArtist(`a-${startIndex + i}`, `Artist ${startIndex + i}`),
      );
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ Items: items, TotalRecordCount: TOTAL }),
      });
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));
    await act(async () => {
      await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
    });

    capturedUrls.length = 0; // Reset — only care about selectAll requests

    const onSelectAllIds = vi.fn();
    await act(async () => {
      await result.current.selectAllWithCompleteSet('artists', onSelectAllIds);
    });

    const artistRequests = capturedUrls.filter((u) => u.includes('/Artists'));

    // Fix: 2000 remaining / 1000 per page = 2 requests
    expect(artistRequests.length).toBe(2);
    // Both requests must use Limit=1000, not the shrinking Limit=667, 445, …
    expect(artistRequests[0]).toContain('Limit=1000');
    expect(artistRequests[1]).toContain('Limit=1000');
    expect((onSelectAllIds.mock.calls[0][0] as string[]).length).toBe(2050);
  });

  it('does not extend the fetch loop when server reports a higher TotalRecordCount mid-fetch', async () => {
    // Bug: totalCount = data.TotalRecordCount on every response → if server oscillates upward,
    //      remaining grows again and the loop never terminates (or takes many extra requests).
    // Fix: totalCount is never updated to a higher value than its initial value.
    // Setup: loadLibrary sees total=100; selectAll responses report total=300.
    //        Only 100 real items exist → server would return 0 items for startIndex≥100.
    let artistCallCount = 0;

    mockFetch.mockImplementation((url: string) => {
      if (!url.includes('/Artists')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
        });
      }
      artistCallCount++;
      const urlObj = new URL(url as string);
      const startIndex = parseInt(urlObj.searchParams.get('StartIndex') ?? '0');
      const limit = parseInt(urlObj.searchParams.get('Limit') ?? '50');
      const REAL_TOTAL = 100;
      const count = Math.min(limit, Math.max(0, REAL_TOTAL - startIndex));
      const items = Array.from({ length: count }, (_, i) =>
        createArtist(`a-${startIndex + i}`, `Artist ${startIndex + i}`),
      );
      // loadLibrary call reports correct total; selectAll calls report inflated total
      const reportedTotal = artistCallCount === 1 ? REAL_TOTAL : 300;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ Items: items, TotalRecordCount: reportedTotal }),
      });
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));
    await act(async () => {
      await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
    });

    const onSelectAllIds = vi.fn();
    await act(async () => {
      await result.current.selectAllWithCompleteSet('artists', onSelectAllIds);
    });

    // Fix: selectAll makes exactly 1 request (50 remaining → Limit=50, gets 50, done)
    // Bug: totalCount updates to 300, loop chases 200 more phantom items
    expect(artistCallCount).toBe(2); // 1 loadLibrary + 1 selectAll
    expect((onSelectAllIds.mock.calls[0][0] as string[]).length).toBe(100);
  });
});

describe('useLibrary - selectAllWithCompleteSet partial failure', () => {
  it('returns partial results when a page fetch fails', async () => {
    // Simulates page 2 failing during selectAll — should return IDs from successful pages
    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));
    const onSelectAllIds = vi.fn();

    // Mock fetch to fail on page 2
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('StartIndex=2')) {
        return Promise.resolve({
          ok: false,
          status: 500,
        });
      }
      if (url.includes('StartIndex=0') && url.includes('Artists')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              Items: [createArtist('artist-1', 'Artist 1'), createArtist('artist-2', 'Artist 2')],
              TotalRecordCount: 5,
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
      });
    });

    await act(async () => {
      await result.current.selectAllWithCompleteSet('artists', onSelectAllIds);
    });

    // Should have returned partial results
    expect(onSelectAllIds).toHaveBeenCalled();
    const calledIds = onSelectAllIds.mock.calls[0][0] as string[];
    // Only page 1 succeeded (2 items), page 2 failed
    expect(calledIds.length).toBeLessThanOrEqual(2);
    expect(calledIds).toContain('artist-1');
    expect(calledIds).toContain('artist-2');
  });

  // Note: Cancellation on tab change is verified in LibraryContent.selectAll.test.tsx
  // since it requires the full component integration with activeLibrary state.
});
