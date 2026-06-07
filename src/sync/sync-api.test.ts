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

    it('ORAIN-0560: falls back to AlbumName when Album is empty string ("" → falsy)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Items: [makeTrackItem({ Id: 'track-1', Album: '', AlbumName: 'Help! (Deluxe)' })],
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

    it('ORAIN-0560: falls back to albumData.Name when both Album and AlbumName are empty', async () => {
      let albumDataCallCount = 0;
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        // The first call fetches album metadata; subsequent calls fetch tracks
        if (url.includes(`/Items/${'album-1'}`) && !url.includes('parentId=')) {
          albumDataCallCount++;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ Name: 'Parent Album Title' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              Items: [makeTrackItem({ Id: 'track-1', Album: '', AlbumName: '' })],
            }),
        });
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const tracks = await api.getAlbumTracks('album-1');
      expect(albumDataCallCount).toBe(1);
      expect(tracks[0].album).toBe('Parent Album Title');
    });

    it('ORAIN-0560: leaves album undefined when Album, AlbumName, and parent album name are all empty', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes(`/Items/${'album-1'}`) && !url.includes('parentId=')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ Name: '' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              Items: [makeTrackItem({ Id: 'track-1', Album: '', AlbumName: '' })],
            }),
        });
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const tracks = await api.getAlbumTracks('album-1');
      // AC: "Si item.Album, item.AlbumName y albumName son todos falsy, el tag no se escribe (no se escribe 'Unknown')"
      expect(tracks[0].album).toBeUndefined();
    });
  });

  describe('getArtistTracks album enrichment (ORAIN-0560 follow-up)', () => {
    // The flat ArtistIds= query returns each track's Album scalar empty for
    // untagged files; the album name only lives on the parent MusicAlbum and is
    // backfilled via a batched Ids= call.
    it('backfills album name + year from the parent album when the track Album scalar is empty', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('ArtistIds=')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                Items: [
                  makeTrackItem({
                    Id: 'track-1',
                    Name: 'This I Promise You',
                    Album: undefined,
                    AlbumName: undefined,
                    AlbumId: 'album-9',
                  }),
                ],
              }),
          });
        }
        // Batched album-metadata call (Ids=)
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              Items: [{ Id: 'album-9', Name: 'No Strings Attached', ProductionYear: 2000 }],
            }),
        });
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const tracks = await api.getArtistTracks('artist-1', 'artist');
      expect(tracks[0].album).toBe('No Strings Attached');
      expect(tracks[0].year).toBe(2000);
    });

    it('resolves all distinct albums in a SINGLE batched Ids= call (no per-album fan-out)', async () => {
      const idsCalls: string[] = [];
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('ArtistIds=')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                Items: [
                  makeTrackItem({ Id: 't1', Album: '', AlbumName: '', AlbumId: 'a1' }),
                  makeTrackItem({ Id: 't2', Album: '', AlbumName: '', AlbumId: 'a2' }),
                  makeTrackItem({ Id: 't3', Album: '', AlbumName: '', AlbumId: 'a1' }),
                ],
              }),
          });
        }
        idsCalls.push(url);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              Items: [
                { Id: 'a1', Name: 'Album One' },
                { Id: 'a2', Name: 'Album Two' },
              ],
            }),
        });
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const tracks = await api.getArtistTracks('artist-1', 'artist');

      // Exactly one batched metadata call covering both distinct albums
      expect(idsCalls).toHaveLength(1);
      expect(idsCalls[0]).toContain('Ids=a1,a2');
      expect(tracks.find((t) => t.id === 't1')?.album).toBe('Album One');
      expect(tracks.find((t) => t.id === 't2')?.album).toBe('Album Two');
      expect(tracks.find((t) => t.id === 't3')?.album).toBe('Album One');
    });

    it('makes no batch call and leaves album unset when no track has an AlbumId', async () => {
      const allCalls: string[] = [];
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        allCalls.push(url);
        if (url.includes('ArtistIds=')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                Items: [makeTrackItem({ Id: 't1', Album: '', AlbumName: '', AlbumId: undefined })],
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

      expect(tracks[0].album).toBeUndefined();
      // No Ids= batch call when there are no album IDs to resolve
      expect(allCalls.every((u) => !u.includes('?Ids='))).toBe(true);
    });
  });

  describe('album batching strategy (M+1, chunked, bounded)', () => {
    const resp = (body: unknown) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

    it('syncing M albums uses ONE Ids= metadata call + one parentId= per album (no per-album /Items/{id})', async () => {
      const calls = { ids: 0, parent: 0, single: 0 };
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('?Ids=')) {
          calls.ids++;
          return resp({
            Items: [
              { Id: 'al1', Name: 'Album One', ProductionYear: 2001 },
              { Id: 'al2', Name: 'Album Two', ProductionYear: 2002 },
            ],
          });
        }
        if (url.includes('parentId=al1')) {
          calls.parent++;
          return resp({
            Items: [makeTrackItem({ Id: 't1', Album: '', AlbumName: '', AlbumId: 'al1' })],
          });
        }
        if (url.includes('parentId=al2')) {
          calls.parent++;
          return resp({
            Items: [makeTrackItem({ Id: 't2', Album: '', AlbumName: '', AlbumId: 'al2' })],
          });
        }
        if (/\/Items\/al\d/.test(url)) {
          calls.single++;
          return resp({});
        }
        return resp({ Items: [] });
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const { tracks } = await api.getTracksForItems(
        ['al1', 'al2'],
        new Map([
          ['al1', 'album'],
          ['al2', 'album'],
        ]),
      );

      expect(calls.ids).toBe(1); // one batched metadata call for both albums
      expect(calls.parent).toBe(2); // one track call per album
      expect(calls.single).toBe(0); // NO legacy per-album /Items/{id} metadata call
      expect(tracks.find((t) => t.id === 't1')?.album).toBe('Album One');
      expect(tracks.find((t) => t.id === 't2')?.album).toBe('Album Two');
      expect(tracks.find((t) => t.id === 't1')?.parentItemId).toBe('al1');
    });

    it('chunks the Ids= metadata query so the URL never grows unbounded (150 albums → 2 chunks)', async () => {
      const albumIds = Array.from({ length: 150 }, (_, i) => `a${i}`);
      const idsCalls: string[] = [];
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('ArtistIds=')) {
          return resp({
            Items: albumIds.map((aid, i) =>
              makeTrackItem({ Id: `t${i}`, Album: '', AlbumName: '', AlbumId: aid }),
            ),
          });
        }
        if (url.includes('?Ids=')) {
          idsCalls.push(url);
          const ids = decodeURIComponent(url.split('Ids=')[1].split('&')[0]).split(',');
          return resp({ Items: ids.map((id) => ({ Id: id, Name: `Name ${id}` })) });
        }
        return resp({ Items: [] });
      });

      const api = createApiClient({
        baseUrl: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
        fetch: mockFetch,
      });

      const tracks = await api.getArtistTracks('artist-1', 'artist');

      // 150 albums / 100 per chunk → 2 batched metadata calls (not 150)
      expect(idsCalls).toHaveLength(2);
      idsCalls.forEach((u) => {
        const count = u.split('Ids=')[1].split('&')[0].split(',').length;
        expect(count).toBeLessThanOrEqual(100);
      });
      expect(tracks.find((t) => t.id === 't0')?.album).toBe('Name a0');
      expect(tracks.find((t) => t.id === 't149')?.album).toBe('Name a149');
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

    it('ORAIN-0560: includes IndexNumber and ParentIndexNumber in the Fields query param (so track number is populated)', async () => {
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
      expect(capturedUrl).toContain('IndexNumber');
      expect(capturedUrl).toContain('ParentIndexNumber');
    });

    it('ORAIN-0560: getAlbumTracks returns trackNumber and discNumber from the IndexNumber/ParentIndexNumber fields', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            Items: [
              makeTrackItem({
                Id: 'track-1',
                Album: 'Abbey Road',
                IndexNumber: 7,
                ParentIndexNumber: 1,
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

      const tracks = await api.getAlbumTracks('album-1');
      expect(tracks[0].trackNumber).toBe(7);
      expect(tracks[0].discNumber).toBe(1);
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

    // ORAIN-0560: AC — "Tests unitarios cubren item.Album como undefined, null y '' en el path de artista"
    it('ORAIN-0560: artist path → album = item.Album when present', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('ArtistIds=artist-1') && url.includes('includeItemTypes=Audio')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                Items: [
                  makeTrackItem({ Id: 't1', Album: 'Album A', AlbumName: 'Album A (Remastered)' }),
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
      expect(tracks[0].album).toBe('Album A');
    });

    it('ORAIN-0560: artist path → falls back to AlbumName when item.Album is undefined', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('ArtistIds=artist-1') && url.includes('includeItemTypes=Audio')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                Items: [
                  makeTrackItem({ Id: 't1', Album: undefined, AlbumName: 'Album A (Remastered)' }),
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
      expect(tracks[0].album).toBe('Album A (Remastered)');
    });

    it('ORAIN-0560: artist path → falls back to AlbumName when item.Album is null', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('ArtistIds=artist-1') && url.includes('includeItemTypes=Audio')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                Items: [
                  // The TS type doesn't allow null, but JSON may carry it — cast to bypass typing
                  {
                    Id: 't1',
                    Name: 'A',
                    Album: null,
                    AlbumName: 'Album A (Remastered)',
                    AlbumArtist: 'Self',
                    Artists: ['artist-1'],
                    AlbumId: 'album-1',
                    Path: '/p/t1.mp3',
                    MediaSources: [{ Path: '/p/t1.mp3', Container: 'mp3' }],
                    IndexNumber: 1,
                    ParentIndexNumber: 1,
                  } as unknown as JellyfinTrackItem,
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
      expect(tracks[0].album).toBe('Album A (Remastered)');
    });

    it('ORAIN-0560: artist path → falls back to AlbumName when item.Album is empty string', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('ArtistIds=artist-1') && url.includes('includeItemTypes=Audio')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                Items: [makeTrackItem({ Id: 't1', Album: '', AlbumName: 'Album A (Remastered)' })],
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
      expect(tracks[0].album).toBe('Album A (Remastered)');
    });

    it('ORAIN-0560: artist path → album is undefined when both Album and AlbumName are empty (no fallback to "Unknown")', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('ArtistIds=artist-1') && url.includes('includeItemTypes=Audio')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                Items: [makeTrackItem({ Id: 't1', Album: '', AlbumName: '' })],
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
      // AC: "Si item.Album, item.AlbumName y albumName son todos falsy, el tag no se escribe (no se escribe 'Unknown')"
      expect(tracks[0].album).toBeUndefined();
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
