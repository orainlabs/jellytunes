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
      setupFetchMock({
        '/Artists?SortBy=Name&Limit=50&StartIndex=0': {
          items: [createArtist('artist-1', 'Artist 1'), createArtist('artist-2', 'Artist 2')],
          total: 5,
        },
        '/Artists?SortBy=Name&Limit=50&StartIndex=2': {
          items: [createArtist('artist-3', 'Artist 3')],
          total: 5,
        },
        '/Artists?SortBy=Name&Limit=50&StartIndex=3': {
          items: [createArtist('artist-4', 'Artist 4')],
          total: 5,
        },
        '/Artists?SortBy=Name&Limit=50&StartIndex=4': {
          items: [createArtist('artist-5', 'Artist 5')],
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
      setupFetchMock({
        '/Artists?SortBy=Name&Limit=50&StartIndex=0': {
          items: [createArtist('artist-1', 'Artist 1')],
          total: 3,
        },
        '/Artists?SortBy=Name&Limit=50&StartIndex=1': {
          items: [createArtist('artist-2', 'Artist 2')],
          total: 3,
        },
        '/Artists?SortBy=Name&Limit=50&StartIndex=2': {
          items: [createArtist('artist-3', 'Artist 3')],
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
      let selectAllPromise: Promise<void>;
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
