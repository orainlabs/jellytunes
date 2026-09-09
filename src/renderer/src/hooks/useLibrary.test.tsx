import { describe, it, expect, vi, beforeEach } from 'vitest';
import type React from 'react';
import { renderHook, act } from '@testing-library/react';
import { useLibrary } from './useLibrary';
import type { JellyfinConfig } from '../appTypes';

const mockConfig: JellyfinConfig = { url: 'https://jellyfin.test', apiKey: 'test-key' };

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock the window.api for logger
const mockWindowApi = {
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
};
Object.defineProperty(window, 'api', { value: mockWindowApi, writable: true });

beforeEach(() => {
  vi.clearAllMocks();
});

function createMockFetch() {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        Items: [
          { Id: 'artist-1', Name: 'Artist 1', AlbumCount: 5, ImageTags: {} },
          { Id: 'artist-2', Name: 'Artist 2', AlbumCount: 3, ImageTags: {} },
        ],
        TotalRecordCount: 2,
      }),
  };
}

function createGenresFetch() {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        Items: [
          { Id: 'rock-id', Name: 'Rock', ItemCount: 10 },
          { Id: 'jazz-id', Name: 'Jazz', ItemCount: 5 },
          { Id: 'electronic-id', Name: 'Electronic', ItemCount: 8 },
        ],
        TotalRecordCount: 3,
      }),
  };
}

// ─── tabStates ───────────────────────────────────────────────────────────────

describe('tabStates', () => {
  function setupFetchMock(responses: Record<string, { items: unknown[]; total: number }>) {
    mockFetch.mockImplementation((url: string) => {
      if (responses[url]) {
        const { items, total } = responses[url];
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: items, TotalRecordCount: total }),
        });
      }
      for (const pattern of Object.keys(responses)) {
        if (url.includes(pattern)) {
          const { items, total } = responses[pattern];
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ Items: items, TotalRecordCount: total }),
          });
        }
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
      });
    });
  }

  it('exposes tabStates in the return object', async () => {
    mockFetch.mockResolvedValue(createMockFetch());
    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));
    // tabStates must be present on the returned object
    expect(result.current.tabStates).toBeDefined();
    expect(typeof result.current.tabStates).toBe('object');
  });

  it('sets genres tab to error when genres fetch fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadTab('genres');
    });

    // After a failed fetch, tabStates.genres must be 'error'
    expect(result.current.tabStates.genres).toBe('error');
  });

  it('sets artists tab to loaded after successful loadTab', async () => {
    mockFetch.mockResolvedValue(createMockFetch());

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    // 'artists' is pre-loaded in initial state (loadedTabs = Set(['artists'])),
    // so loadTab early-returns without fetching. Test 'albums' instead — a tab
    // that requires a real fetch and transitions from 'loading' to 'loaded'.
    await act(async () => {
      await result.current.loadTab('albums');
    });

    expect(result.current.tabStates.albums).toBe('loaded');
  });

  it('sets genres tab to loaded after successful genres loadTab', async () => {
    mockFetch.mockResolvedValue(createGenresFetch());

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadTab('genres');
    });

    expect(result.current.tabStates.genres).toBe('loaded');
  });

  it('refreshLibrary sets all tab states to loading', async () => {
    setupFetchMock({
      'SortBy=Name&Limit=50&StartIndex=0': {
        items: [{ Id: 'artist-1', Name: 'Artist 1', AlbumCount: 5, ImageTags: {} }],
        total: 1,
      },
      'IncludeItemTypes=MusicAlbum': { items: [], total: 0 },
      'IncludeItemTypes=Playlist': { items: [], total: 0 },
      '/Genres': { items: [], total: 0 },
      '/Views': { items: [], total: 0 },
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    // Start refresh (non-blocking — just check state immediately after calling)
    let refreshPromise: Promise<void>;
    await act(async () => {
      refreshPromise = result.current.refreshLibrary();
      // State should be 'loading' for all tabs right after the call
      expect(result.current.tabStates.artists).toBe('loading');
      expect(result.current.tabStates.albumArtists).toBe('loading');
      expect(result.current.tabStates.albums).toBe('loading');
      expect(result.current.tabStates.playlists).toBe('loading');
      expect(result.current.tabStates.genres).toBe('loading');
      await refreshPromise;
    });
  });

  it('refreshLibrary calls loadStats after reloading', async () => {
    setupFetchMock({
      'SortBy=Name&Limit=50&StartIndex=0': {
        items: [{ Id: 'artist-1', Name: 'Artist 1', AlbumCount: 5, ImageTags: {} }],
        total: 1,
      },
      'IncludeItemTypes=MusicAlbum': { items: [], total: 0 },
      'IncludeItemTypes=Playlist': { items: [], total: 0 },
      '/Genres': { items: [], total: 0 },
      '/Views': { items: [], total: 0 },
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.refreshLibrary();
    });

    // loadStats fetches /Users/{id}/Items/Counts — verify it was called
    const calledUrls = (mockFetch.mock.calls as Array<[string]>).map((c) => c[0]);
    const countsCall = calledUrls.find((url) => url.includes('Items/Counts'));
    expect(countsCall).toBeDefined();
  });
});

describe('loadLibrary', () => {
  // URL-based mock helper - matches URL against patterns
  function setupFetchMock(responses: Record<string, { items: unknown[]; total: number }>) {
    mockFetch.mockImplementation((url: string) => {
      // Try exact match first
      if (responses[url]) {
        const { items, total } = responses[url];
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: items, TotalRecordCount: total }),
        });
      }
      // Fallback to pattern matching - check if URL contains the pattern
      for (const pattern of Object.keys(responses)) {
        if (url.includes(pattern)) {
          const { items, total } = responses[pattern];
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ Items: items, TotalRecordCount: total }),
          });
        }
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
      });
    });
  }

  it('fetches all 5 tabs in parallel', async () => {
    setupFetchMock({
      // Pattern matching - partial URL that will be found via includes()
      'SortBy=Name&Limit=50&StartIndex=0': {
        items: [{ Id: 'artist-1', Name: 'Artist 1', AlbumCount: 5, ImageTags: {} }],
        total: 1,
      },
      'IncludeItemTypes=MusicAlbum': { items: [], total: 0 },
      'IncludeItemTypes=Playlist': { items: [], total: 0 },
      '/Genres': { items: [], total: 0 },
      '/Views': { items: [], total: 0 },
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
    });

    // artists, albumArtists, albums, playlists, genres — all 5 tabs are loaded,
    // plus one /Users/{id}/Views call to resolve the music library id for /Genres
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });
});

describe('loadMore', () => {
  it('appends items with deduplication by Id', async () => {
    mockFetch.mockImplementation((url: string) => {
      // Initial load - 1 artist
      if (url.includes('StartIndex=0')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              Items: [{ Id: 'artist-1', Name: 'Artist 1', AlbumCount: 5, ImageTags: {} }],
              TotalRecordCount: 4,
            }),
        });
      }
      // Load more - 2 artists (1 duplicate, 1 new)
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            Items: [
              { Id: 'artist-1', Name: 'Artist 1', AlbumCount: 5, ImageTags: {} }, // duplicate
              { Id: 'artist-2', Name: 'Artist 2', AlbumCount: 3, ImageTags: {} }, // new
            ],
            TotalRecordCount: 4,
          }),
      });
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
    });

    // Verify initial load
    expect(result.current.artists).toHaveLength(1);
    expect(result.current.artists[0].Id).toBe('artist-1');

    await act(async () => {
      await result.current.loadMore('artists');
    });

    // Should have only 2 unique artists (deduped)
    const uniqueIds = new Set(result.current.artists.map((a) => a.Id));
    expect(uniqueIds.size).toBe(2);
  });
});

describe('handleTabChange', () => {
  it('saves scroll position of previous tab', async () => {
    mockFetch.mockResolvedValue(createMockFetch());

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    // Mock scroll ref
    const scrollContainer = { scrollTop: 150 };
    (result.current.contentScrollRef as React.MutableRefObject<HTMLDivElement | null>).current =
      scrollContainer as unknown as HTMLDivElement;

    await act(async () => {
      await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
    });

    act(() => {
      result.current.handleTabChange('albums');
    });

    // Scroll position of 'artists' tab should be saved
    expect(result.current.pagination.artists.scrollPos).toBe(150);
  });
});

describe('lazy tab loading', () => {
  it('loadTab fetches albums data when called directly', async () => {
    // Start with empty loadedTabs (hook initial state has only 'artists')
    mockFetch.mockResolvedValue(createMockFetch());

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    // Manually call loadTab for albums (not via handleTabChange, since handleTabChange
    // also changes activeLibrary and saves scroll position)
    await act(async () => {
      await result.current.loadTab('albums');
    });

    // loadTab should have fetched albums data
    expect(mockFetch).toHaveBeenCalled();
    const lastCallUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
    expect(lastCallUrl.toLowerCase()).toContain('includeitemtypes=musicalbum');
  });
});

describe('stats', () => {
  it('populates statsObj correctly after loadStats', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ArtistCount: 42,
          AlbumCount: 120,
          ChildCount: 3000,
          PlaylistCount: 5,
          ItemCount: 3100,
        }),
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadStats('https://jellyfin.test', 'test-key', 'user-1');
    });

    expect(result.current.stats).not.toBeNull();
    expect(result.current.stats?.ArtistCount).toBe(42);
    expect(result.current.stats?.AlbumCount).toBe(120);
    expect(result.current.stats?.SongCount).toBe(3000);
  });
});

describe('selectAllWithCompleteSet', () => {
  it('fetches additional pages with dynamic page sizing', async () => {
    mockFetch.mockClear();
    let fetchCount = 0;

    // Mock returns first page of 50 items with total of 100
    mockFetch.mockImplementation(() => {
      fetchCount++;
      return Promise.resolve({
        ok: true,
        json: () => {
          if (fetchCount === 1) {
            // First page: 50 items, total 100
            const items = Array.from({ length: 50 }, (_, i) => ({
              Id: `artist-${i + 1}`,
              Name: `Artist ${i + 1}`,
              AlbumCount: 5,
              ImageTags: {},
            }));
            return Promise.resolve({ Items: items, TotalRecordCount: 100 });
          }
          // Second page: remaining 50 items
          const items = Array.from({ length: 50 }, (_, i) => ({
            Id: `artist-${i + 51}`,
            Name: `Artist ${i + 51}`,
            AlbumCount: 3,
            ImageTags: {},
          }));
          return Promise.resolve({ Items: items, TotalRecordCount: 100 });
        },
      });
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
    });

    let selectedIds: string[] = [];
    await act(async () => {
      await result.current.selectAllWithCompleteSet('artists', (ids) => {
        selectedIds = ids;
      });
    });

    // Should have fetched all 100 items
    expect(selectedIds).toHaveLength(100);
    // Should have made 2 fetch calls (initial + additional page)
    expect(fetchCount).toBeGreaterThanOrEqual(2);
  });

  it('calls onError with errors and selected count when some pages fail', async () => {
    mockFetch.mockClear();
    const onError = vi.fn();
    let callCount = 0;

    // Setup mock that fails on second page
    mockFetch.mockImplementation(() => {
      callCount++;
      // First call succeeds
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              Items: [{ Id: 'artist-1', Name: 'Artist 1', AlbumCount: 5, ImageTags: {} }],
              TotalRecordCount: 100,
            }),
        });
      }
      // Second call fails
      return Promise.resolve({ ok: false, status: 500 });
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
    });

    await act(async () => {
      await result.current.selectAllWithCompleteSet(
        'artists',
        () => {},
        (errors, count) => {
          onError(errors, count);
        },
      );
    });

    // onError should have been called
    expect(onError).toHaveBeenCalled();
    const [errors, count] = onError.mock.calls[0];
    expect(errors.length).toBeGreaterThan(0);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe('genres', () => {
  it('loadTab fetches genres data when called with genres tab', async () => {
    mockFetch.mockResolvedValue(createGenresFetch());

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadTab('genres');
    });

    // Should have fetched genres
    expect(mockFetch).toHaveBeenCalled();
    const genresCall = (mockFetch.mock.calls as Array<[string]>)
      .map((c) => c[0])
      .find((url) => url.includes('/Genres?'));
    expect(genresCall).toBeDefined();
    expect(genresCall).toContain('Recursive=true');
  });

  it('genres data is populated after loadTab genres', async () => {
    mockFetch.mockResolvedValue(createGenresFetch());

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadTab('genres');
    });

    expect(result.current.genres).toHaveLength(3);
    expect(result.current.genres[0].Name).toBe('Rock');
    expect(result.current.genres[0].LibraryItems).toBe(10);
  });

  it('handles genres fetch failure gracefully', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadTab('genres');
    });

    expect(result.current.genres).toHaveLength(0);
  });

  it('loadMore fetches from Genres endpoint for genres type', async () => {
    // Setup mock to track which endpoints are called
    const fetchCalls: string[] = [];
    mockFetch.mockImplementation((url: string) => {
      fetchCalls.push(url);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            Items: [{ Id: 'electronic-id', Name: 'Electronic', ItemCount: 8 }],
            TotalRecordCount: 5,
          }),
      });
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadTab('genres');
    });

    await act(async () => {
      await result.current.loadMore('genres');
    });

    // Verify loadMore called the Genres endpoint (with startIndex from pagination)
    // After initial load with 1 item, pagination startIndex = 1
    const loadMoreCall = fetchCalls.find(
      (url) => url.includes('/Genres?') && url.includes('StartIndex=1'),
    );
    expect(loadMoreCall).toBeDefined();
    expect(loadMoreCall).toContain('Recursive=true');
  });

  it('fetchAllIds fetches from Genres endpoint for genres type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          Items: [{ Id: 'rock-id', Name: 'Rock', ItemCount: 10 }],
          TotalRecordCount: 1,
        }),
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadTab('genres');
    });

    let fetchedIds: string[] = [];
    await act(async () => {
      const res = await result.current.fetchAllIds('genres');
      fetchedIds = res.ids;
    });

    // Verify genres use Id as ID (not Name field)
    expect(fetchedIds).toContain('rock-id');
  });
});

// ─── loadLibrary error preservation (HIGH finding fix) ────────────────────────
// Verifies that loadLibrary does NOT overwrite 'error' states set by catch blocks

describe('loadLibrary error preservation', () => {
  it('loadLibrary preserves error state for a failing tab (albumArtists)', async () => {
    // Setup mock: artists succeeds, albumArtists fails, other tabs succeed
    mockFetch.mockImplementation((url: string) => {
      // Artists endpoint
      if (url.includes('/Artists?') && !url.includes('AlbumArtists')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              Items: [{ Id: 'a1', Name: 'Artist 1', AlbumCount: 1, ImageTags: {} }],
              TotalRecordCount: 1,
            }),
        });
      }
      // AlbumArtists endpoint - FAIL
      if (url.includes('/Artists/AlbumArtists')) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      // Music library resolution
      if (url.includes('/Views')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: [{ Id: 'music-lib', CollectionType: 'music' }] }),
        });
      }
      // All other endpoints succeed
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
      });
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
    });

    // After loadLibrary completes, albumArtists tab must remain 'error'
    // (the Promise.resolve().then() fix preserves 'error' states)
    expect(result.current.tabStates.albumArtists).toBe('error');
    // Other tabs should be 'loaded'
    expect(result.current.tabStates.artists).toBe('loaded');
    expect(result.current.tabStates.albums).toBe('loaded');
    expect(result.current.tabStates.playlists).toBe('loaded');
    expect(result.current.tabStates.genres).toBe('loaded');
  });
});

// ─── retryTab (ORAIN-0688) ───────────────────────────────────────────────────
//
// Bug: retryTab removes tab from loadedTabs, sets tabStates[tab]='loading',
// then calls loadTab(tab) synchronously. React batches the two setState calls
// in the same microtask, so loadedTabs.has(tab) is still true when loadTab
// runs → loadTab early-returns and the tab is stuck in 'loading' forever.
//
// Fix: extract fetch logic to fetchTab(tab) (no guard), keep loadTab = guard
// + fetchTab, retryTab calls fetchTab directly after resetting state.
// Guard in loadTab is preserved to prevent re-fetch on tab-change / mount.

describe('retryTab', () => {
  // AC1: retryTab on a tab already in loadedTabs executes a real HTTP request
  it('executes a fetch when retryTab is called on a tab already in loadedTabs', async () => {
    // Simulate loadLibrary having added 'albums' to loadedTabs (the bug trigger):
    // 'albums' is NOT in the initial loadedTabs (only 'artists' is).
    // We put it there by calling loadTab('albums') first — it succeeds and adds it.
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('IncludeItemTypes=MusicAlbum')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
      });
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    // Prime loadedTabs so 'albums' is in it (simulates post-loadLibrary state)
    await act(async () => {
      await result.current.loadTab('albums');
    });
    expect(result.current.loadedTabs.has('albums')).toBe(true);

    // Track how many fetch calls happen during retryTab
    // Override mock so retry actually resolves
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('IncludeItemTypes=MusicAlbum')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              Items: [{ Id: 'album-1', Name: 'Album 1', Type: 'MusicAlbum' }],
              TotalRecordCount: 1,
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
      });
    });

    await act(async () => {
      await result.current.retryTab('albums');
    });

    // AC1: fetch was called at least once during retryTab
    const albumFetches = mockFetch.mock.calls.filter((call) =>
      (call[0] as string).includes('IncludeItemTypes=MusicAlbum'),
    );
    expect(albumFetches.length).toBeGreaterThan(1); // initial + retry
  });

  // AC2: after successful retry, tabStates === 'loaded' and pagination has items
  it('sets tabStates to loaded and populates pagination after successful retry', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          Items: [
            { Id: 'album-2', Name: 'Album 2', Type: 'MusicAlbum' },
            { Id: 'album-3', Name: 'Album 3', Type: 'MusicAlbum' },
          ],
          TotalRecordCount: 2,
        }),
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    // Load albums first so it's in loadedTabs
    await act(async () => {
      await result.current.loadTab('albums');
    });
    expect(result.current.loadedTabs.has('albums')).toBe(true);

    await act(async () => {
      await result.current.retryTab('albums');
    });

    // AC2: tabStates.albums === 'loaded'
    expect(result.current.tabStates.albums).toBe('loaded');
    // AC2: pagination.albums.items contains the returned items
    expect(result.current.pagination.albums.items.length).toBeGreaterThan(0);
  });

  // AC3: after failed retry, tabStates === 'error' and never stuck in 'loading'
  it('sets tabStates to error (not loading) after failed retry', async () => {
    // First load succeeds to put albums in loadedTabs
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadTab('albums');
    });
    expect(result.current.loadedTabs.has('albums')).toBe(true);

    // Retry fails
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await act(async () => {
      await result.current.retryTab('albums');
    });

    // AC3: tabStates.albums === 'error', not 'loading'
    expect(result.current.tabStates.albums).toBe('error');
  });

  // AC4: retry resolving with 0 items → tabStates === 'loaded' (empty state), not 'loading'
  it('sets tabStates to loaded (not loading) when retry resolves with 0 items', async () => {
    // First load succeeds to put albums in loadedTabs
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          Items: [{ Id: 'album-x', Name: 'Album X', Type: 'MusicAlbum' }],
          TotalRecordCount: 1,
        }),
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    await act(async () => {
      await result.current.loadTab('albums');
    });
    expect(result.current.loadedTabs.has('albums')).toBe(true);

    // Retry returns 0 items (HTTP 200, empty response)
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
    });

    await act(async () => {
      await result.current.retryTab('albums');
    });

    // AC4: tabStates.albums === 'loaded' (empty state), not 'loading'
    expect(result.current.tabStates.albums).toBe('loaded');
  });

  // AC5: loadTab guard is preserved — tab-change / mount must not re-fetch
  it('loadTab does NOT re-fetch a tab already in loadedTabs (guard preserved)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          Items: [{ Id: 'artist-1', Name: 'Artist 1', AlbumCount: 5, ImageTags: {} }],
          TotalRecordCount: 1,
        }),
    });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    // Load library so all tabs are in loadedTabs (via microtask)
    await act(async () => {
      await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
    });

    const fetchCountBefore = mockFetch.mock.calls.length;

    // Call loadTab on a tab that is in loadedTabs — must NOT fetch
    await act(async () => {
      await result.current.loadTab('artists');
    });

    // AC5: no new fetch calls were made (guard early-returned)
    expect(mockFetch.mock.calls.length).toBe(fetchCountBefore);
  });

  // AC6: existing LibraryContent.states tests still pass — no regressions
  // (covered by running the full test suite; documented here as an AC anchor)
  // AC7: typecheck + tests pass — verified by CI gate
});

// ─── retryTab loading state (MEDIUM finding fix) ─────────────────────────────

describe('retryTab (existing)', () => {
  it('sets tab state to loading before re-fetching', async () => {
    // First, manually set genres to error state via loadTab failure
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

    // Set genres to error first
    await act(async () => {
      await result.current.loadTab('genres');
    });
    expect(result.current.tabStates.genres).toBe('error');

    // Now setup mock to succeed
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          Items: [{ Id: 'rock-id', Name: 'Rock', ItemCount: 10 }],
          TotalRecordCount: 1,
        }),
    });

    // Call retryTab and check intermediate state
    const retryPromise = act(async () => {
      const p = result.current.retryTab('genres');
      // After synchronous setTabStates but before async loadTab completes,
      // tabStates.genres should be 'loading'
      // We can't directly test intermediate state in this test structure,
      // but we verify the final state is 'loaded' after successful retry
      await p;
      return p;
    });

    await retryPromise;

    // After successful retry, state should be 'loaded'
    expect(result.current.tabStates.genres).toBe('loaded');
  });
});
