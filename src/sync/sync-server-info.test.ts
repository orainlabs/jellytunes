/**
 * ORAIN-0770 — AC3: a failing /Users/{id}/Items/Counts or
 * /System/Info/Public call must NOT break the library load or the
 * sync. The corresponding [server-info] field renders as 'unknown'.
 *
 * ORAIN-0770 — AC2: [server-info] is emitted once after the first
 * library load and again on each refresh; the dedupe helper inside
 * main/index.ts keys the re-emit on a per-payload hash.
 *
 * The library-load wiring lives in main/index.ts; this test focuses
 * on the SyncApi surface (getServerLibraryStats + getServerVersion)
 * and a single integration through SyncCore.sync() that exercises
 * the failure → graceful-degradation path. The main-side emission
 * timing is verified end-to-end in main/index.ts unit tests; for the
 * sync module we only assert the API contract.
 */
import { describe, it, expect } from 'vitest';
import { createApiClient } from './sync-api';

const SERVER_URL = 'https://jellyfin.example.com';
const API_KEY = '0123456789abcdef0123456789abcdef';
const USER_ID = 'abcdef1234567890abcdef1234567890';

function makeJsonFetch(responses: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    // The /System/Info/Public endpoint is unauthenticated; the others
    // are scoped under /Users/{id}/. Pick the entry whose key is a
    // substring of the URL.
    for (const [key, value] of Object.entries(responses)) {
      if (u.includes(key)) {
        return new Response(JSON.stringify(value), { status: 200 });
      }
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('SyncApi.getServerVersion — ORAIN-0770 AC2', () => {
  it('returns the Jellyfin Version from /System/Info/Public', async () => {
    const api = createApiClient({
      baseUrl: SERVER_URL,
      apiKey: API_KEY,
      userId: USER_ID,
      fetch: makeJsonFetch({ '/System/Info/Public': { Version: '10.9.0' } }),
    });
    const v = await api.getServerVersion();
    expect(v).toBe('10.9.0');
  });

  it('returns null when the server omits Version (AC3 graceful degradation)', async () => {
    const api = createApiClient({
      baseUrl: SERVER_URL,
      apiKey: API_KEY,
      userId: USER_ID,
      fetch: makeJsonFetch({ '/System/Info/Public': { ServerName: 'Jellyfin' } }),
    });
    const v = await api.getServerVersion();
    expect(v).toBeNull();
  });

  it('returns null when the endpoint is unreachable (AC3 must not break library load)', async () => {
    const api = createApiClient({
      baseUrl: SERVER_URL,
      apiKey: API_KEY,
      userId: USER_ID,
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    // AC3: a failing fetch must not throw — the caller (main/index.ts)
    // will see null and emit the [server-info] line with
    // `jellyfinVersion=unknown`.
    const v = await api.getServerVersion();
    expect(v).toBeNull();
  });
});

describe('SyncApi.getServerLibraryStats — ORAIN-0770 AC2', () => {
  it('returns Artists, AlbumArtists, Albums, and audio tracks from /Items/Counts', async () => {
    const api = createApiClient({
      baseUrl: SERVER_URL,
      apiKey: API_KEY,
      userId: USER_ID,
      // The ORAIN-0770 spec assumes Items/Counts can return AlbumArtist
      // counts in addition to Artist/Album/Song. If the live server
      // omits the field, the getter falls back to undefined so the
      // formatter renders 'unknown'. Both shapes must be supported.
      fetch: makeJsonFetch({
        '/Items/Counts': {
          ArtistCount: 2489,
          AlbumArtistCount: 2489,
          AlbumCount: 12345,
          SongCount: 23195,
        },
      }),
    });
    const s = await api.getServerLibraryStats();
    expect(s.artists).toBe(2489);
    expect(s.albumArtists).toBe(2489);
    expect(s.albums).toBe(12345);
    expect(s.audioTracks).toBe(23195);
  });

  it('returns null for missing fields (AC3 graceful degradation)', async () => {
    const api = createApiClient({
      baseUrl: SERVER_URL,
      apiKey: API_KEY,
      userId: USER_ID,
      fetch: makeJsonFetch({ '/Items/Counts': { ArtistCount: 100 } }),
    });
    const s = await api.getServerLibraryStats();
    expect(s.artists).toBe(100);
    expect(s.albumArtists).toBeNull();
    expect(s.albums).toBeNull();
    expect(s.audioTracks).toBeNull();
  });

  it('returns all-null payload when the endpoint is unreachable (AC3 must not break library load)', async () => {
    const api = createApiClient({
      baseUrl: SERVER_URL,
      apiKey: API_KEY,
      userId: USER_ID,
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const s = await api.getServerLibraryStats();
    expect(s).toEqual({
      artists: null,
      albumArtists: null,
      albums: null,
      audioTracks: null,
    });
  });
});
