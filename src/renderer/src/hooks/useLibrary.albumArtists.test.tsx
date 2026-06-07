import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('useLibrary albumArtists tab', () => {
  function setupFetchMock(responses: Record<string, { items: unknown[]; total: number }>) {
    mockFetch.mockImplementation((url: string) => {
      // Exact match first
      if (responses[url]) {
        const { items, total } = responses[url];
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: items, TotalRecordCount: total }),
        });
      }
      // Pattern matching
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

  describe('loadLibrary loads albumArtists', () => {
    it('fetches all 5 tabs in parallel including albumArtists', async () => {
      setupFetchMock({
        // Artists (track-level)
        'SortBy=Name&Limit=50&StartIndex=0': {
          items: [{ Id: 'artist-1', Name: 'Artist 1', AlbumCount: 5, ImageTags: {} }],
          total: 1,
        },
        // Album Artists (via AlbumArtists endpoint)
        '/Artists/AlbumArtists': {
          items: [
            { Id: 'aa-1', Name: 'Various Artists', AlbumCount: 10, ImageTags: {} },
            { Id: 'aa-2', Name: 'Band Album Artist', AlbumCount: 3, ImageTags: {} },
          ],
          total: 2,
        },
        // Albums
        'IncludeItemTypes=MusicAlbum': { items: [], total: 0 },
        // Playlists
        'IncludeItemTypes=Playlist': { items: [], total: 0 },
        // Genres
        '/Genres': { items: [], total: 0 },
        // Music library id resolution for the /Genres ParentId
        '/Views': { items: [], total: 0 },
      });

      const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

      await act(async () => {
        await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
      });

      // artists, albumArtists, albums, playlists, genres — all 5 tabs are loaded,
      // plus one /Users/{id}/Views call to resolve the music library id for /Genres
      expect(mockFetch).toHaveBeenCalledTimes(6);
      // Verify the AlbumArtists endpoint was called
      const albumArtistsCall = mockFetch.mock.calls.find((call) =>
        (call[0] as string).includes('/Artists/AlbumArtists'),
      );
      expect(albumArtistsCall).toBeDefined();
    });
  });

  describe('loadTab loads albumArtists', () => {
    it('loadTab fetches albumArtists data when called with albumArtists tab', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Items: [{ Id: 'aa-1', Name: 'Various Artists', AlbumCount: 10, ImageTags: {} }],
            TotalRecordCount: 1,
          }),
      });

      const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

      await act(async () => {
        await result.current.loadTab('albumArtists');
      });

      expect(mockFetch).toHaveBeenCalled();
      const lastCallUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
      expect(lastCallUrl).toContain('/Artists/AlbumArtists');
    });
  });

  describe('loadMore handles albumArtists pagination', () => {
    it('appends album artist items with deduplication', async () => {
      setupFetchMock({
        'SortBy=Name&Limit=50&StartIndex=0': {
          items: [{ Id: 'aa-1', Name: 'AA 1', AlbumCount: 5, ImageTags: {} }],
          total: 3,
        },
        'Limit=50&StartIndex=1': {
          items: [
            { Id: 'aa-1', Name: 'AA 1', AlbumCount: 5, ImageTags: {} }, // duplicate
            { Id: 'aa-2', Name: 'AA 2', AlbumCount: 3, ImageTags: {} }, // new
          ],
          total: 3,
        },
        '/Artists/AlbumArtists': {
          items: [{ Id: 'aa-1', Name: 'AA 1', AlbumCount: 5, ImageTags: {} }],
          total: 3,
        },
        'IncludeItemTypes=MusicAlbum': { items: [], total: 0 },
        'IncludeItemTypes=Playlist': { items: [], total: 0 },
      });

      const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

      await act(async () => {
        await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
      });

      // albumArtists should have 1 item
      expect(result.current.albumArtists).toHaveLength(1);
      expect(result.current.albumArtists[0].Id).toBe('aa-1');
    });
  });

  describe('selectAllWithCompleteSet for albumArtists', () => {
    it('fetches all album artists for select all', async () => {
      mockFetch.mockClear();
      let fetchCount = 0;

      mockFetch.mockImplementation((url: string) => {
        fetchCount++;
        // Only respond to AlbumArtists endpoint
        if (url.includes('/Artists/AlbumArtists')) {
          return Promise.resolve({
            ok: true,
            json: () => {
              // Return 25 items per call, total of 50 items in 2 calls
              if (fetchCount <= 2) {
                const items = Array.from({ length: 25 }, (_, i) => ({
                  Id: `aa-${(fetchCount - 1) * 25 + i + 1}`,
                  Name: `Album Artist ${(fetchCount - 1) * 25 + i + 1}`,
                  AlbumCount: 5,
                  ImageTags: {},
                }));
                return Promise.resolve({ Items: items, TotalRecordCount: 50 });
              }
              // This should not be reached for selectAllWithCompleteSet
              const items = Array.from({ length: 25 }, (_, i) => ({
                Id: `aa-${(fetchCount - 1) * 25 + i + 1}`,
                Name: `Album Artist ${(fetchCount - 1) * 25 + i + 1}`,
                AlbumCount: 3,
                ImageTags: {},
              }));
              return Promise.resolve({ Items: items, TotalRecordCount: 50 });
            },
          });
        }
        // Return empty for other endpoints (artists, albums, playlists)
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
        });
      });

      const { result } = renderHook(() => useLibrary(mockConfig, 'user-1'));

      await act(async () => {
        await result.current.loadLibrary('https://jellyfin.test', 'test-key', 'user-1');
      });

      // Reset count after loadLibrary
      fetchCount = 0;

      let selectedIds: string[] = [];
      await act(async () => {
        await result.current.selectAllWithCompleteSet('albumArtists', (ids) => {
          selectedIds = ids;
        });
      });

      // Should have fetched all 50 items
      expect(selectedIds).toHaveLength(50);
    });
  });
});
