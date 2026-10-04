/**
 * ORAIN-0770 — renderer-side helper that fetches the Jellyfin server
 * info (totals + version) and forwards it to the main process so a
 * `[server-info]` line ends up in main.log. The renderer is the
 * natural owner of this because:
 *
 *  1. It already calls `/Users/{userId}/Items/Counts` to populate the
 *     sidebar (the totals shown there are exactly what AC2 wants).
 *  2. It already calls `/System/Info/Public` indirectly through the
 *     login handshake (server name + version), but on login we want a
 *     SEPARATE call so the [server-info] line is re-emitted on every
 *     library refresh (AC2: "una vez tras la primera carga de la
 *     biblioteca y otra tras cada refresh").
 *  3. It owns the lifecycle: first load and refresh happen here.
 *
 * Privacy: this module only fetches counts and a single opaque version
 * string. It never reads or forwards track names, album names, or
 * library names.
 */
import { buildUrl } from './jellyfin';
import type { LibraryStats } from '../appTypes';
import { logger as rendererLogger } from './logger';

/**
 * Shape of `/System/Info/Public`. We only need `Version` for the
 * `[server-info]` line; the other fields are read to keep the JSON
 * parse type-safe but are not used.
 *
 * `null` for Version is rendered as `unknown` by the [server-info]
 * formatter (ORAIN-0770 AC3 graceful degradation).
 */
interface PublicSystemInfo {
  Version?: string;
}

interface ServerInfoReportPayload {
  artists: number | null;
  albumArtists: number | null;
  albums: number | null;
  audioTracks: number | null;
  jellyfinVersion: string | null;
}

/**
 * Read the totals from the already-loaded `LibraryStats` payload.
 * `/Items/Counts` may omit `AlbumArtistCount` (legacy servers) — when
 * so, we surface `null` so the [server-info] line renders `unknown`
 * rather than masking the gap as zero (ORAIN-0770 AC3).
 */
function countsFromStats(stats: LibraryStats | null): {
  artists: number | null;
  albumArtists: number | null;
  albums: number | null;
  audioTracks: number | null;
} {
  if (stats === null) {
    return { artists: null, albumArtists: null, albums: null, audioTracks: null };
  }
  return {
    artists: typeof stats.ArtistCount === 'number' ? stats.ArtistCount : null,
    albumArtists: typeof stats.AlbumArtistCount === 'number' ? stats.AlbumArtistCount : null,
    albums: typeof stats.AlbumCount === 'number' ? stats.AlbumCount : null,
    audioTracks: typeof stats.SongCount === 'number' ? stats.SongCount : null,
  };
}

/**
 * Fetch `/System/Info/Public` and return the Version string. The
 * endpoint is unauthenticated — we deliberately do NOT send the
 * Authorization header to avoid logging a token-bearing request on
 * the server side. Returns `null` for any failure (network, non-OK,
 * missing field) so the caller can render `unknown` (AC3).
 */
async function fetchJellyfinVersion(baseUrl: string): Promise<string | null> {
  try {
    const url = buildUrl(baseUrl, '/System/Info/Public');
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const data = (await res.json()) as PublicSystemInfo;
    if (typeof data.Version === 'string' && data.Version.length > 0) {
      return data.Version;
    }
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * Build a report payload from already-loaded stats and the version
 * endpoint. Pure function so the renderer-side test can assert the
 * shape without spinning up fetch.
 *
 * `null` inputs mean "we couldn't obtain this value" and surface
 * as `unknown` in the [server-info] line.
 */
export function buildServerInfoReport(
  stats: LibraryStats | null,
  version: string | null,
): ServerInfoReportPayload {
  return { ...countsFromStats(stats), jellyfinVersion: version };
}

/**
 * Fetch the latest server info and forward it to main. Safe to call
 * repeatedly — the main side de-duplicates so an unchanged payload
 * does not re-emit the line (ORAIN-0770 AC2).
 *
 * `lib.loadStats` already returns once the count data has landed in
 * React state; passing the fresh value here avoids a stale-closure
 * race where the IPC fires before the renderer has stored it.
 *
 * `baseUrl` is passed explicitly for the same reason — the renderer
 * may have switched servers since the closure was created.
 */
export async function reportServerInfo(args: {
  baseUrl: string;
  stats: LibraryStats | null;
}): Promise<void> {
  const version = await fetchJellyfinVersion(args.baseUrl);
  const payload = buildServerInfoReport(args.stats, version);
  try {
    await window.api.reportServerInfo(payload);
  } catch (e) {
    // ORAIN-0770 AC3: a failing IPC must NEVER break the library load
    // or a sync. Log locally and move on.
    rendererLogger.warn('reportServerInfo failed: ' + (e instanceof Error ? e.message : String(e)));
  }
}
