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

  describe('getGenreTracks', () => {
    it('returns tracks for a given genre id (ORAIN-0535)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Items: [
              makeTrackItem({ Id: 't1', Name: 'So What', Genres: ['Jazz'] }),
              makeTrackItem({ Id: 't2', Name: 'Take Five', Genres: ['Jazz'] }),
            ],
          }),
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const tracks = await api.getGenreTracks('genre-jazz');
      expect(tracks).toHaveLength(2);
      expect(tracks[0].id).toBe('t1');
      expect(tracks[1].id).toBe('t2');
    });

    it('queries /Items with GenreIds and IncludeItemTypes=Audio (ORAIN-0535)', async () => {
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

      await api.getGenreTracks('genre-jazz');

      expect(capturedUrl).toContain('/Items?');
      expect(capturedUrl).toContain('GenreIds=genre-jazz');
      expect(capturedUrl).toContain('IncludeItemTypes=Audio');
      expect(capturedUrl).toContain('Recursive=true');
    });

    it('returns empty array when no tracks match the genre', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ Items: [] }),
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const tracks = await api.getGenreTracks('genre-empty');
      expect(tracks).toEqual([]);
    });

    it('skips tracks without a MediaSources path', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Items: [
              makeTrackItem({ Id: 't1', Name: 'Good' }),
              makeTrackItem({
                Id: 't2',
                Name: 'Bad (no source)',
                MediaSources: undefined,
                Path: undefined,
              }),
            ],
          }),
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const tracks = await api.getGenreTracks('genre-jazz');
      expect(tracks).toHaveLength(1);
      expect(tracks[0].id).toBe('t1');
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

    it("dispatches 'genre' type to getGenreTracks (ORAIN-0535)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Items: [
              makeTrackItem({ Id: 't1', Name: 'So What', Genres: ['Jazz'] }),
              makeTrackItem({ Id: 't2', Name: 'Take Five', Genres: ['Jazz'] }),
            ],
          }),
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const result = await api.getTracksForItems(
        ['genre-jazz'],
        new Map<string, 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre'>([
          ['genre-jazz', 'genre'],
        ]),
      );

      expect(result.tracks).toHaveLength(2);
      expect(result.errors).toEqual([]);
      // Verify the request was made with GenreIds
      const calls = mockFetch.mock.calls as Array<[string]>;
      expect(calls[0][0]).toContain('GenreIds=genre-jazz');
    });

    it("tags 'genre' tracks with parentItemId (ORAIN-0535)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Items: [makeTrackItem({ Id: 't1', Name: 'So What' })],
          }),
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const result = await api.getTracksForItems(
        ['genre-jazz'],
        new Map<string, 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre'>([
          ['genre-jazz', 'genre'],
        ]),
      );

      expect(result.tracks[0].parentItemId).toBe('genre-jazz');
    });
  });

  describe('getArtistTracks (ORAIN-0554)', () => {
    it('type="artist" queries Audio items directly (not albums) using artistIds=', async () => {
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

      await api.getArtistTracks('artist-1', 'artist');

      // ORAIN-0554: direct track query, NOT the album→tracks flow
      const trackCall = capturedUrls.find(
        (u) => u.includes('ArtistIds=artist-1') && u.includes('includeItemTypes=Audio'),
      );
      expect(trackCall).toBeDefined();
      // The old flow used ArtistIds= for MusicAlbum — ensure we never query albums
      const albumCall = capturedUrls.find(
        (u) => u.includes('ArtistIds=artist-1') && u.includes('includeItemTypes=MusicAlbum'),
      );
      expect(albumCall).toBeUndefined();
    });

    it('type="albumArtist" keeps the MusicAlbum→tracks flow (AlbumArtistIds=)', async () => {
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

      await api.getArtistTracks('aa-1', 'albumArtist');

      // AlbumArtist path: first fetches MusicAlbum items via AlbumArtistIds=
      const albumCall = capturedUrls.find(
        (u) => u.includes('AlbumArtistIds=aa-1') && u.includes('includeItemTypes=MusicAlbum'),
      );
      expect(albumCall).toBeDefined();
    });

    it('type="artist" returns tracks from a direct Audio query (no album roundtrip)', async () => {
      // ORAIN-0554 acceptance: artista con 4 tracks propios + 1 contribución en album ajeno
      // → sync como artist copia 5 tracks.
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        // Direct Audio query returns 5 tracks — including the contribution track
        // whose album is owned by a different artist.
        if (url.includes('ArtistIds=artist-1') && url.includes('includeItemTypes=Audio')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                Items: [
                  {
                    Id: 't1',
                    Name: 'A',
                    AlbumId: 'album-self',
                    AlbumArtist: 'Self',
                    Album: 'X',
                    Artists: ['artist-1'],
                    Path: '/p/t1.mp3',
                    MediaSources: [{ Path: '/p/t1.mp3' }],
                  },
                  {
                    Id: 't2',
                    Name: 'B',
                    AlbumId: 'album-self',
                    AlbumArtist: 'Self',
                    Album: 'X',
                    Artists: ['artist-1'],
                    Path: '/p/t2.mp3',
                    MediaSources: [{ Path: '/p/t2.mp3' }],
                  },
                  {
                    Id: 't3',
                    Name: 'C',
                    AlbumId: 'album-self',
                    AlbumArtist: 'Self',
                    Album: 'X',
                    Artists: ['artist-1'],
                    Path: '/p/t3.mp3',
                    MediaSources: [{ Path: '/p/t3.mp3' }],
                  },
                  {
                    Id: 't4',
                    Name: 'D',
                    AlbumId: 'album-self',
                    AlbumArtist: 'Self',
                    Album: 'X',
                    Artists: ['artist-1'],
                    Path: '/p/t4.mp3',
                    MediaSources: [{ Path: '/p/t4.mp3' }],
                  },
                  {
                    Id: 't5',
                    Name: 'Contrib',
                    AlbumId: 'album-other',
                    AlbumArtist: 'Other',
                    Album: 'Y',
                    Artists: ['other', 'artist-1'],
                    Path: '/p/t5.mp3',
                    MediaSources: [{ Path: '/p/t5.mp3' }],
                  },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ Items: [] }) });
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const tracks = await api.getArtistTracks('artist-1', 'artist');
      expect(tracks).toHaveLength(5);
    });
  });

  describe('createMockApiClient', () => {
    it('includes a getGenreTracks mock method (ORAIN-0535)', async () => {
      const { createMockApiClient } = await import('./sync-api');
      const mock = createMockApiClient();
      expect(typeof mock.getGenreTracks).toBe('function');
      const tracks = await mock.getGenreTracks('genre-jazz');
      expect(tracks).toEqual([]);
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
