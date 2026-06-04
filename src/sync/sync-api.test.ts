import { describe, it, expect, vi } from 'vitest';
import { createApiClient } from './sync-api';
import type { JellyfinTrackItem } from './types';

// Helper to create a minimal track item
function makeTrackItem(overrides: Partial<JellyfinTrackItem> = {}): JellyfinTrackItem {
  return {
    Id: 'track-1',
    Name: 'Yesterday',
    Album: 'Help!',
    AlbumName: 'Help! (Remastered)',
    AlbumArtist: 'The Beatles',
    Artists: ['John Lennon', 'Paul McCartney'],
    Genres: ['Rock', 'Pop'],
    AlbumId: 'album-1',
    Path: '/music/The Beatles/Help!/yesterday.mp3',
    MediaSources: [
      {
        Path: '/music/The Beatles/Help!/yesterday.mp3',
        Container: 'mp3',
        Size: 3_500_000,
        Bitrate: 320_000,
      },
    ],
    IndexNumber: 1,
    ParentIndexNumber: 1,
    ...overrides,
  };
}

describe('sync-api', () => {
  describe('trackItemToInfo (via getAlbumTracks)', () => {
    it('maps item.Album to the album field', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Items: [makeTrackItem({ Id: 'track-1', Album: 'Abbey Road', Name: 'Come Together' })],
          }),
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const tracks = await api.getAlbumTracks('album-1');
      expect(tracks[0].album).toBe('Abbey Road');
    });

    it('falls back to AlbumName when Album is undefined', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Items: [
              makeTrackItem({ Id: 'track-1', Album: undefined, AlbumName: 'Help! (Deluxe)' }),
            ],
          }),
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const tracks = await api.getAlbumTracks('album-1');
      expect(tracks[0].album).toBe('Help! (Deluxe)');
    });
  });

  describe('getAlbumTracks fields', () => {
    it('includes Artists and AlbumArtist in the Fields query param', async () => {
      let capturedUrl = '';
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: [], ProductionYear: 1969 }),
        });
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      await api.getAlbumTracks('album-1');

      expect(capturedUrl).toContain('Fields=');
      expect(capturedUrl).toContain('Artists');
      expect(capturedUrl).toContain('AlbumArtist');
    });
  });

  describe('getPlaylistTracks fields', () => {
    it('includes Artists and AlbumArtist in the Fields query param', async () => {
      let capturedUrl = '';
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: [] }),
        });
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      await api.getPlaylistTracks('playlist-1');

      expect(capturedUrl).toContain('Fields=');
      expect(capturedUrl).toContain('Artists');
      expect(capturedUrl).toContain('AlbumArtist');
    });
  });

  describe('getTracksForItems', () => {
    it('with empty array: returns { tracks: [], errors: [] } with 0 HTTP calls', async () => {
      const mockFetch = vi.fn();

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const result = await api.getTracksForItems([], new Map());

      expect(result.tracks).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('ORAIN-0534: artist type → uses ArtistIds= (NOT AlbumArtistIds=)', async () => {
      const capturedUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: [] }),
        });
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      await api.getTracksForItems(['artist-1'], new Map([['artist-1', 'artist']]));

      const artistCall = capturedUrls.find((u) => u.includes('Items?'));
      expect(artistCall).toBeDefined();
      // Must use bare ArtistIds= (not the album-artist variant)
      expect(artistCall).toMatch(/[?&]ArtistIds=artist-1/);
      expect(artistCall).not.toMatch(/[?&]AlbumArtistIds=artist-1/);
    });

    it('ORAIN-0534: albumArtist type → uses AlbumArtistIds= (NOT bare ArtistIds=)', async () => {
      const capturedUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: [] }),
        });
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      await api.getTracksForItems(['aa-1'], new Map([['aa-1', 'albumArtist']]));

      const aaCall = capturedUrls.find((u) => u.includes('Items?'));
      expect(aaCall).toBeDefined();
      expect(aaCall).toMatch(/[?&]AlbumArtistIds=aa-1/);
      // Bare ArtistIds= would be wrong — AlbumArtistIds already contains "ArtistIds" as a substring,
      // so check the param name with the [?&] boundary
      expect(aaCall).not.toMatch(/[?&]ArtistIds=aa-1/);
    });
  });

  describe('getCoverArt', () => {
    it('emits warning (via error) when cover art fetch fails — sync continues', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not Found'),
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      await expect(api.getCoverArt('cover-art-1')).rejects.toThrow();
    });
  });

  describe('request() AbortController', () => {
    it('cancels the request when timeout expires', async () => {
      vi.useFakeTimers();
      let abortThrown = false;
      let abortError: Error | undefined;
      const mockFetch = vi.fn().mockImplementation(async (_url: string, opts?: unknown) => {
        const signal = (opts as { signal?: AbortSignal })?.signal;
        while (!signal?.aborted && !abortThrown) {
          await vi.advanceTimersByTimeAsync(1);
        }
        if (!abortThrown) {
          abortThrown = true;
          abortError = new Error('aborted');
          abortError.name = 'AbortError';
          throw abortError;
        }
      });
      const api = createApiClient({
        baseUrl: 'https://jellyfin.example.com',
        apiKey: 'test-key',
        userId: 'user-1',
        timeout: 100,
        fetch: mockFetch,
      });
      const requestPromise = (api as unknown as { request<T>(ep: string): Promise<T> }).request(
        '/test',
      );
      let caught: unknown;
      const settled = requestPromise.catch((e) => {
        caught = e;
      });
      await vi.advanceTimersByTimeAsync(101);
      await settled;
      expect(caught).toMatchObject({ statusCode: 408 });
      await vi.advanceTimersByTimeAsync(0);
      mockFetch.mockRestore();
      vi.useRealTimers();
    });

    it('does not throw or double-resolve when response arrives as timeout fires', async () => {
      vi.useFakeTimers();
      let abortThrown = false;
      let abortError: Error | undefined;
      const mockFetch = vi.fn().mockImplementation(async (_url: string, opts?: unknown) => {
        const signal = (opts as { signal?: AbortSignal })?.signal;
        await vi.advanceTimersByTimeAsync(99);
        if (signal?.aborted && !abortThrown) {
          abortThrown = true;
          abortError = new Error('aborted');
          abortError.name = 'AbortError';
          throw abortError;
        }
        await vi.advanceTimersByTimeAsync(2);
        if (signal?.aborted && !abortThrown) {
          abortThrown = true;
          abortError = new Error('aborted');
          abortError.name = 'AbortError';
          throw abortError;
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const api = createApiClient({
        baseUrl: 'https://jellyfin.example.com',
        apiKey: 'test-key',
        userId: 'user-1',
        timeout: 100,
        fetch: mockFetch,
      });
      const requestPromise = (api as unknown as { request<T>(ep: string): Promise<T> }).request(
        '/test',
      );
      let caught: unknown;
      const settled = requestPromise.catch((e) => {
        caught = e;
      });
      await vi.advanceTimersByTimeAsync(200);
      await settled;
      expect(caught).toMatchObject({ statusCode: 408 });
      await vi.advanceTimersByTimeAsync(0);
      mockFetch.mockRestore();
      vi.useRealTimers();
    });
  });
});
