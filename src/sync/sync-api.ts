/**
 * Jellyfin API Client Module
 *
 * Handles all HTTP communication with Jellyfin server.
 * Designed to be mockable for unit tests.
 */

import type { TrackInfo, ItemType, SyncLogger } from './types';
import type { JellyfinTrackItem, JellyfinAlbumItem } from './types';

/**
 * API client configuration
 */
export interface ApiClientConfig {
  /** Base URL for Jellyfin server */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** User ID for requests */
  userId: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Custom fetch implementation (for testing) */
  fetch?: typeof fetch;
  /** Logger for debug output */
  logger?: SyncLogger;
}

/**
 * API error with status code
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public body?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Create API client instance
 */
export function createApiClient(config: ApiClientConfig): SyncApi {
  return new SyncApiImpl(config);
}

/**
 * API client interface (for mocking)
 */
export interface SyncApi {
  /** Test connection to Jellyfin server */
  testConnection(): Promise<{ success: boolean; serverName?: string; error?: string }>;

  /** Get user information */
  getUser(): Promise<{ id: string; name: string }>;

  /** Get tracks for an artist. ORAIN-0534: type discriminates between regular
   *  artists (ArtistIds= query) and album-artists (AlbumArtistIds= query). The two
   *  share IDs in Jellyfin but resolve to different album sets. */
  getArtistTracks(artistId: string, type?: 'artist' | 'albumArtist'): Promise<TrackInfo[]>;

  /** Get tracks for an album */
  getAlbumTracks(albumId: string): Promise<TrackInfo[]>;

  /** Get tracks in a playlist */
  getPlaylistTracks(playlistId: string): Promise<TrackInfo[]>;

  /** Get tracks for a genre (all Audio items with matching GenreIds) */
  getGenreTracks(genreId: string): Promise<TrackInfo[]>;

  /** Get tracks for multiple items (batch) */
  getTracksForItems(
    itemIds: string[],
    itemTypes: Map<string, ItemType>,
  ): Promise<{ tracks: TrackInfo[]; errors: string[] }>;

  /** Get item information */
  getItem(itemId: string): Promise<{ id: string; name: string; type: string } | null>;

  /** Get library statistics */
  getLibraryStats(): Promise<{ artists: number; albums: number; tracks: number }>;

  /** Download item from Jellyfin server */
  downloadItem(itemId: string): Promise<Buffer>;

  /** Stream item from Jellyfin server as a Node.js Readable */
  downloadItemStream(itemId: string): Promise<NodeJS.ReadableStream>;

  /** Get primary cover art image for an item */
  getCoverArt(itemId: string): Promise<Buffer>;

  /** Fetch lyrics for a track (returns LRC string or null if unavailable) */

  /** Fetch ReplayGain normalization data for a track (returns data or null if unavailable) */
  fetchReplayGain(itemId: string): Promise<{ trackGain: string; trackPeak: string } | null>;
  fetchLyrics(itemId: string): Promise<string | null>;
}

/**
 * Simple concurrency limiter — caps the number of in-flight promises.
 * Prevents flooding the Jellyfin server when syncing large libraries.
 */
class ConcurrencyLimiter {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

/** Max concurrent Jellyfin API requests (avoids saturating the server) */
const API_CONCURRENCY = 4;

/**
 * Max album IDs per `Ids=` batch request. Keeps the query string well within
 * URL-length limits (~100 × 32-char GUIDs ≈ 3.2KB) and avoids oversized requests
 * while still collapsing hundreds of albums into a handful of calls.
 */
const ALBUM_IDS_CHUNK_SIZE = 100;

/**
 * Canonical `Fields` list for every track query, regardless of the source
 * endpoint (artist, album, playlist, genre). Keeping a single list guarantees
 * the same track yields identical hash-relevant metadata (album, year,
 * trackNumber=IndexNumber, discNumber=ParentIndexNumber) no matter which item
 * fetched it. If the lists diverge, a track shared between two items hashes
 * differently per fetch path and ping-pongs between "out of sync"/"retagged".
 */
const TRACK_FIELDS =
  'Path,MediaSources,AlbumId,Genres,Artists,AlbumArtist,Album,RunTimeTicks,IndexNumber,ParentIndexNumber';

/** Split an array into chunks of at most `size` elements. */
function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * API client implementation
 */
class SyncApiImpl implements SyncApi {
  private baseUrl: string;
  private apiKey: string;
  private userId: string;
  private timeout: number;
  private fetchFn: typeof fetch;
  private limiter = new ConcurrencyLimiter(API_CONCURRENCY);
  // Separate limiter for the per-album track fan-out inside getAlbumTracksBatch.
  // The albumArtist path runs getAlbumTracksBatch from *inside* `limiter.run`,
  // so reusing the same limiter for the inner fan-out would deadlock (outer
  // slots waiting on inner slots of the same semaphore). A distinct limiter
  // bounds album track requests without that risk.
  private albumLimiter = new ConcurrencyLimiter(API_CONCURRENCY);
  private logger?: SyncLogger;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.userId = config.userId;
    this.timeout = config.timeout ?? 30000;
    this.fetchFn = config.fetch ?? fetch;
    this.logger = config.logger;
  }

  private getAuthHeaders(): Record<string, string> {
    return {
      'X-MediaBrowser-Token': this.apiKey,
      'X-Emby-Token': this.apiKey,
    };
  }

  private async request<T>(
    endpoint: string,
    options?: { method?: string; body?: unknown },
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchFn(url, {
        method: options?.method ?? 'GET',
        headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
        body: options?.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new ApiError(
          `API request failed: ${response.status} ${response.statusText}`,
          response.status,
          body,
        );
      }

      return response.json();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiError('Request timed out', 408);
      }

      throw new ApiError(
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        0,
      );
    }
  }

  async testConnection(): Promise<{ success: boolean; serverName?: string; error?: string }> {
    try {
      const data = await this.request<{ ServerName?: string }>('/System/Info/Public');
      return {
        success: true,
        serverName: data.ServerName,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof ApiError ? error.message : 'Connection failed',
      };
    }
  }

  async getUser(): Promise<{ id: string; name: string }> {
    const data = await this.request<{ Id: string; Name: string }>(`/Users/${this.userId}`);
    return {
      id: data.Id,
      name: data.Name,
    };
  }

  async getArtistTracks(
    artistId: string,
    type: 'artist' | 'albumArtist' = 'artist',
  ): Promise<TrackInfo[]> {
    this.logger?.debug(`[BATCH] getArtistTracks START artistId=${artistId} type=${type}`);
    const startTime = Date.now();

    if (type === 'albumArtist') {
      // ORAIN-0534 / ORAIN-0554: album-artist semantics — "every track on every
      // album this person is the album artist of". Query MusicAlbum by
      // AlbumArtistIds=, then expand to tracks. Kept exactly as before.
      const filterParam = 'AlbumArtistIds';
      const albumsEndpoint = `/Users/${this.userId}/Items?${filterParam}=${artistId}&includeItemTypes=MusicAlbum&Recursive=true&Fields=Path,MediaSources`;
      this.logger?.debug(
        `[BATCH] getArtistTracks ${artistId} (albumArtist) → fetching albums endpoint=${albumsEndpoint}`,
      );
      const albumsData = await this.request<{ Items: JellyfinAlbumItem[] }>(albumsEndpoint);

      const albums = albumsData.Items ?? [];
      if (albums.length === 0) {
        this.logger?.debug(
          `[BATCH] getArtistTracks ${artistId} → 0 albums, took ${Date.now() - startTime}ms`,
        );
        return [];
      }

      this.logger?.debug(
        `[BATCH] getArtistTracks ${artistId} → found ${albums.length} albums: ${albums
          .slice(0, 5)
          .map((a) => a.Id)
          .join(',')}...`,
      );

      // Route through getAlbumTracksBatch: chunked Ids= metadata + one bounded
      // parentId= per album, instead of 2 unbounded calls per album.
      const allTracks = (await this.getAlbumTracksBatch(albums.map((album) => album.Id))).map(
        ({ _albumId, ...track }) => track,
      );

      const elapsed = Date.now() - startTime;
      this.logger?.debug(
        `[BATCH] getArtistTracks ${artistId} → DONE ${allTracks.length} tracks in ${elapsed}ms`,
      );
      return allTracks;
    }

    // ORAIN-0554: regular artist semantics — "every track where this person
    // performed", INCLUDING contributions on albums owned by other artists
    // (e.g., a guest vocal on someone else's record). The previous flow
    // fetched MusicAlbum by ArtistIds= and then expanded to tracks, which
    // missed those contribution tracks entirely AND double-counted when the
    // same album also listed the artist as an album artist.
    //
    // The new flow queries Audio items directly. `artistIds=` in Jellyfin
    // matches both the `Artists` array on a track AND the `AlbumArtists` on
    // its album (broad semantic). The alternative `contributingArtistIds=`
    // would be a tighter "performer" semantic, but only matches the
    // `Artists` array; the trade-off is documented in
    // `docs/JELLYFIN_API.md` (pending manual verification).
    const tracksEndpoint = `/Users/${this.userId}/Items?ArtistIds=${artistId}&includeItemTypes=Audio&Recursive=true&Fields=${TRACK_FIELDS}`;
    this.logger?.debug(
      `[BATCH] getArtistTracks ${artistId} (artist) → fetching tracks endpoint=${tracksEndpoint}`,
    );
    const tracksData = await this.request<{ Items: JellyfinTrackItem[] }>(tracksEndpoint);
    const items = (tracksData.Items ?? []).filter((item) => item.MediaSources?.[0]?.Path);

    // ORAIN-0560 follow-up: the flat ArtistIds= query returns each track's
    // `Album` scalar empty for files lacking an album tag, and unlike
    // getAlbumTracks this path has no parent-album fallback — so the album tag
    // was dropped when syncing by artist. Resolve names + years for all distinct
    // albums in ONE batched Ids= call and pass them as the album-name fallback.
    const tracks = await this.itemsToInfoWithAlbumBackfill(items);

    const elapsed = Date.now() - startTime;
    this.logger?.debug(
      `[BATCH] getArtistTracks ${artistId} → DONE ${tracks.length} tracks in ${elapsed}ms`,
    );
    return tracks;
  }

  /**
   * Fetch the Audio tracks under a single album with ONE parentId= request.
   * The album Name/Year are supplied by the caller (resolved separately, usually
   * batched via fetchAlbumMetaByIds) and used as the album-name/year fallback —
   * the per-track `Album` scalar can't be relied on (see fetchAlbumMetaByIds).
   */
  private async getAlbumTracksByParent(
    albumId: string,
    albumName?: string,
    albumYear?: number,
  ): Promise<TrackInfo[]> {
    const data = await this.request<{ Items: JellyfinTrackItem[] }>(
      // ORAIN-0560: IndexNumber/ParentIndexNumber are required for track/disc tags.
      `/Users/${this.userId}/Items?parentId=${albumId}&includeItemTypes=Audio&Recursive=true&Fields=${TRACK_FIELDS}`,
    );
    return (data.Items ?? [])
      .filter((item) => item.MediaSources?.[0]?.Path)
      .map((item) => this.trackItemToInfo(item, albumYear, albumName));
  }

  async getAlbumTracks(albumId: string): Promise<TrackInfo[]> {
    const startTime = Date.now();
    this.logger?.debug(`[BATCH] getAlbumTracks START albumId=${albumId}`);

    const albumData = await this.request<{ Name?: string; ProductionYear?: number }>(
      `/Users/${this.userId}/Items/${albumId}`,
    ).catch(() => ({ Name: undefined, ProductionYear: undefined }));

    const tracks = await this.getAlbumTracksByParent(
      albumId,
      albumData.Name,
      albumData.ProductionYear,
    );

    this.logger?.debug(
      `[BATCH] getAlbumTracks ${albumId} → albumName="${albumData.Name}" tracks=${tracks.length} in ${Date.now() - startTime}ms`,
    );

    return tracks;
  }

  async getPlaylistTracks(playlistId: string): Promise<TrackInfo[]> {
    const startTime = Date.now();
    this.logger?.debug(`[BATCH] getPlaylistTracks START playlistId=${playlistId}`);

    const data = await this.request<{ Items: JellyfinTrackItem[] }>(
      `/Playlists/${playlistId}/Items?UserId=${this.userId}&Fields=${TRACK_FIELDS}`,
    );

    const items = (data.Items ?? []).filter((item) => item.MediaSources?.[0]?.Path);
    const tracks = await this.itemsToInfoWithAlbumBackfill(items);

    this.logger?.debug(
      `[BATCH] getPlaylistTracks ${playlistId} → ${tracks.length} tracks in ${Date.now() - startTime}ms`,
    );

    return tracks;
  }

  async getGenreTracks(genreId: string): Promise<TrackInfo[]> {
    const startTime = Date.now();
    this.logger?.debug(`[BATCH] getGenreTracks START genreId=${genreId}`);

    const endpoint = `/Items?IncludeItemTypes=Audio&GenreIds=${encodeURIComponent(genreId)}&Recursive=true&Fields=${TRACK_FIELDS}`;
    const data = await this.request<{ Items: JellyfinTrackItem[] }>(endpoint);

    const items = (data.Items ?? []).filter((item) => item.MediaSources?.[0]?.Path);
    const tracks = await this.itemsToInfoWithAlbumBackfill(items);

    this.logger?.debug(
      `[BATCH] getGenreTracks ${genreId} → ${tracks.length} tracks in ${Date.now() - startTime}ms`,
    );

    return tracks;
  }

  /**
   * Resolve album Name + ProductionYear for multiple albums in a SINGLE HTTP
   * call via Jellyfin's `Ids=` filter. Used to backfill the album-name fallback
   * for track queries (e.g. ArtistIds=) where the per-track `Album` scalar is
   * empty: Jellyfin sets `dto.Album = audio.Album` directly with no parent
   * fallback (verified against DtoService.cs), so the album name only lives on
   * the parent MusicAlbum entity reachable via AlbumId.
   *
   * Returns a map keyed by album ID. On failure it resolves to an empty map so
   * callers degrade gracefully (the album tag simply stays unset).
   */
  /**
   * Map raw Jellyfin track items to TrackInfo, backfilling the album name + year
   * from the parent MusicAlbum (resolved in ONE batched Ids= call). Jellyfin
   * leaves the per-track `Album` scalar empty for files without an album tag and
   * never returns a track-level year, so without this fallback those fields stay
   * blank — diverging from the artist/album fetch paths that already backfill.
   * Routing every flat track query through here keeps the metadata hash stable
   * across endpoints (see TRACK_FIELDS).
   */
  private async itemsToInfoWithAlbumBackfill(items: JellyfinTrackItem[]): Promise<TrackInfo[]> {
    const albumIds = [
      ...new Set(items.map((i) => i.AlbumId).filter((id): id is string => Boolean(id))),
    ];
    const albumMeta = await this.fetchAlbumMetaByIds(albumIds);
    return items.map((item) => {
      const meta = item.AlbumId ? albumMeta.get(item.AlbumId) : undefined;
      return this.trackItemToInfo(item, meta?.year, meta?.name);
    });
  }

  private async fetchAlbumMetaByIds(
    albumIds: string[],
  ): Promise<Map<string, { name?: string; year?: number }>> {
    const map = new Map<string, { name?: string; year?: number }>();
    if (albumIds.length === 0) return map;

    // Split into chunks so the Ids= URL never grows unbounded (a single artist
    // can span hundreds of albums). Chunks run through albumLimiter to cap
    // parallelism. Each chunk is one HTTP call; failures degrade gracefully
    // (those albums simply keep an unset album tag).
    const chunks = chunk(albumIds, ALBUM_IDS_CHUNK_SIZE);
    await Promise.all(
      chunks.map((ids) =>
        this.albumLimiter.run(async () => {
          const endpoint = `/Users/${this.userId}/Items?Ids=${ids.join(',')}&Fields=ProductionYear`;
          const data = await this.request<{ Items: JellyfinAlbumItem[] }>(endpoint).catch(() => ({
            Items: [] as JellyfinAlbumItem[],
          }));
          for (const album of data.Items ?? []) {
            map.set(album.Id, { name: album.Name, year: album.ProductionYear });
          }
        }),
      ),
    );
    return map;
  }

  private async getAlbumTracksBatch(
    albumIds: string[],
  ): Promise<Array<TrackInfo & { _albumId: string }>> {
    // Resolve every album's Name/Year in chunked Ids= batches (1 call per chunk,
    // not 1 per album), then fetch tracks with one bounded parentId= query each.
    // Total: ceil(M/CHUNK) + M calls instead of the old 2M, with the per-album
    // fan-out capped by albumLimiter so we never flood the server.
    const albumMeta = await this.fetchAlbumMetaByIds(albumIds);
    const results = await Promise.all(
      albumIds.map((albumId) =>
        this.albumLimiter.run(async () => {
          const meta = albumMeta.get(albumId);
          const tracks = await this.getAlbumTracksByParent(albumId, meta?.name, meta?.year);
          return tracks.map((t) => ({ ...t, _albumId: albumId }));
        }),
      ),
    );
    return results.flat();
  }

  async getTracksForItems(
    itemIds: string[],
    itemTypes: Map<string, ItemType>,
  ): Promise<{ tracks: TrackInfo[]; errors: string[] }> {
    const startTime = Date.now();
    this.logger?.debug(
      `[BATCH] getTracksForItems START items=${itemIds.length} (${Array.from(itemTypes.entries())
        .slice(0, 3)
        .map(([id, t]) => `${t}:${id}`)
        .join(',')}${itemIds.length > 3 ? '...' : ''})`,
    );

    const albumIds = itemIds.filter((id) => itemTypes.get(id) === 'album');
    const nonAlbumIds = itemIds.filter((id) => itemTypes.get(id) !== 'album');

    const tracks: TrackInfo[] = [];
    const errors: string[] = [];

    // Batch-fetch all albums in a single HTTP call instead of N parallel requests
    if (albumIds.length > 0) {
      this.logger?.debug(
        `[BATCH] getTracksForItems → batch fetching ${albumIds.length} albums in one HTTP call`,
      );
      try {
        const albumTracks = await this.getAlbumTracksBatch(albumIds);
        // parentItemId = albumId so the registry groups tracks under their album
        for (const { _albumId, ...track } of albumTracks) {
          tracks.push({ ...track, parentItemId: _albumId });
        }
        this.logger?.debug(`[BATCH] getTracksForItems albums batch → ${albumTracks.length} tracks`);
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? `Failed to batch fetch albums: ${err.message}`
            : 'Error batch fetching albums';
        this.logger?.debug(
          `[BATCH] getTracksForItems albums batch → ERROR: ${err instanceof Error ? err.message : String(err)}`,
        );
        errors.push(msg);
      }
    }

    // Artists and playlists still fetched individually (no multi-item batch endpoint)
    if (nonAlbumIds.length > 0) {
      const results = await Promise.allSettled(
        nonAlbumIds.map((itemId) =>
          this.limiter.run(async () => {
            const itemType = itemTypes.get(itemId);
            this.logger?.debug(`[BATCH] getTracksForItems → fetching ${itemType} ${itemId}`);
            if (!itemType) throw new Error(`Unknown item type for ID: ${itemId}`);
            switch (itemType) {
              case 'artist':
              case 'albumArtist':
                // ORAIN-0534: pass type to use the correct Jellyfin filter (ArtistIds vs AlbumArtistIds)
                return await this.getArtistTracks(itemId, itemType);
              case 'playlist':
                return await this.getPlaylistTracks(itemId);
              case 'genre':
                return await this.getGenreTracks(itemId);
              default:
                throw new Error(`Unsupported item type: ${itemType}`);
            }
          }),
        ),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const itemId = nonAlbumIds[i];
        const itemType = itemTypes.get(itemId) ?? 'unknown';
        if (result.status === 'fulfilled') {
          const taggedTracks = result.value.map((t) => ({ ...t, parentItemId: itemId }));
          this.logger?.debug(
            `[BATCH] getTracksForItems ${itemType} ${itemId} → ${result.value.length} tracks`,
          );
          tracks.push(...taggedTracks);
        } else {
          const err = result.reason;
          const msg =
            err instanceof ApiError
              ? `Failed to fetch ${itemType} ${itemId}: ${err.message}`
              : `Error processing ${itemType} ${itemId}`;
          this.logger?.debug(
            `[BATCH] getTracksForItems ${itemType} ${itemId} → ERROR: ${err instanceof Error ? err.message : String(err)}`,
          );
          errors.push(msg);
        }
      }
    }

    this.logger?.debug(
      `[BATCH] getTracksForItems DONE → ${tracks.length} total tracks, ${errors.length} errors in ${Date.now() - startTime}ms`,
    );

    return { tracks, errors };
  }

  async getItem(itemId: string): Promise<{ id: string; name: string; type: string } | null> {
    try {
      const endpoint = `/Users/${this.userId}/Items/${itemId}`;
      const data = await this.request<{ Id: string; Name: string; Type: string }>(endpoint);

      return {
        id: data.Id,
        name: data.Name,
        type: data.Type,
      };
    } catch {
      return null;
    }
  }

  async getLibraryStats(): Promise<{ artists: number; albums: number; tracks: number }> {
    const endpoint = `/Users/${this.userId}/Items/Counts`;
    const data = await this.request<{
      ArtistCount?: number;
      AlbumCount?: number;
      SongCount?: number;
    }>(endpoint);

    return {
      artists: data.ArtistCount ?? 0,
      albums: data.AlbumCount ?? 0,
      tracks: data.SongCount ?? 0,
    };
  }

  /**
   * Shared logic for downloading an item — fetches the raw HTTP response.
   * Handles URL construction, auth headers, timeout, and error normalization.
   */
  private async fetchDownloadResponse(itemId: string, timeoutMs: number): Promise<Response> {
    const url = `${this.baseUrl}/Items/${itemId}/Download`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: this.getAuthHeaders(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new ApiError(
          `Download failed: ${response.status} ${response.statusText}`,
          response.status,
        );
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiError('Download timed out', 408);
      }
      throw new ApiError(
        `Network error: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    }
  }

  async downloadItemStream(itemId: string): Promise<NodeJS.ReadableStream> {
    const response = await this.fetchDownloadResponse(itemId, this.timeout * 10);

    if (!response.body) {
      throw new ApiError('Download failed: empty response body', 0);
    }

    // Convert Web ReadableStream → Node.js Readable (Node 16.7+, Electron 22+)
    const { Readable } = require('stream');
    return Readable.fromWeb(response.body);
  }

  async downloadItem(itemId: string): Promise<Buffer> {
    const response = await this.fetchDownloadResponse(itemId, this.timeout * 10);
    return Buffer.from(await response.arrayBuffer());
  }

  async getCoverArt(itemId: string): Promise<Buffer> {
    const url = `${this.baseUrl}/Items/${itemId}/Images/Primary`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: this.getAuthHeaders(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new ApiError(
          `Failed to fetch cover art: ${response.status} ${response.statusText}`,
          response.status,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError')
        throw new ApiError('Cover art request timed out', 408);
      throw new ApiError(
        `Failed to fetch cover art: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    }
  }

  async fetchLyrics(itemId: string): Promise<string | null> {
    const url = `${this.baseUrl}/Audio/${itemId}/Lyrics`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: this.getAuthHeaders(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 404) {
        this.logger?.debug(`No lyrics found for item ${itemId}`);
        return null;
      }

      if (!response.ok) {
        throw new ApiError(
          `Failed to fetch lyrics: ${response.status} ${response.statusText}`,
          response.status,
        );
      }

      const text = await response.text();
      return text ? parseLyricsResponse(text) : null;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof ApiError) {
        // 404 is non-fatal (track simply has no lyrics)
        if (error.statusCode === 404) {
          this.logger?.debug(`No lyrics found for item ${itemId}`);
          return null;
        }
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiError('Lyrics request timed out', 408);
      }
      throw new ApiError(
        `Failed to fetch lyrics: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    }
  }

  async fetchReplayGain(itemId: string): Promise<{ trackGain: string; trackPeak: string } | null> {
    const url = `${this.baseUrl}/Users/${this.userId}/Items/${itemId}?Fields=MediaSources`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: this.getAuthHeaders(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 404) {
        this.logger?.debug(`No item found for ReplayGain: ${itemId}`);
        return null;
      }

      if (!response.ok) {
        throw new ApiError(
          `Failed to fetch ReplayGain: ${response.status} ${response.statusText}`,
          response.status,
        );
      }

      const data = (await response.json()) as {
        MediaSources?: Array<{
          Metadata?: Record<string, string>;
        }>;
      };

      const metadata = data.MediaSources?.[0]?.Metadata;
      const trackGain = metadata?.['@replaygain_track_gain'];
      const trackPeak = metadata?.['@replaygain_track_peak'];

      if (trackGain && trackPeak) {
        return { trackGain, trackPeak };
      }
      return null;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof ApiError) {
        if (error.statusCode === 404) {
          this.logger?.debug(`No item found for ReplayGain: ${itemId}`);
          return null;
        }
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiError('ReplayGain request timed out', 408);
      }
      throw new ApiError(
        `Failed to fetch ReplayGain: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    }
  }
  /**
   * Maps a Jellyfin track item to TrackInfo.
   * Year is injected separately (resolved at album level to avoid N+1 requests).
   */
  private trackItemToInfo(
    item: JellyfinTrackItem,
    albumYear?: number,
    albumName?: string,
  ): TrackInfo {
    const source = item.MediaSources?.[0];
    // ORAIN-0560: use `||` (not `??`) so empty strings returned by Jellyfin
    // fall through to the next fallback. With `??`, item.Album === "" would
    // be kept and the album tag would be written as "". If every fallback is
    // falsy, leave the field undefined so the tag is not written at all
    // (rather than writing an "Unknown" placeholder).
    /* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- ORAIN-0560: empty strings must fall through, not be kept as-is */
    const resolvedAlbum = item.Album || item.AlbumName || albumName || undefined;
    /* eslint-enable @typescript-eslint/prefer-nullish-coalescing */

    // Parse RunTimeTicks: 1 tick = 100 nanoseconds = 10,000,000 ticks per second
    const durationSeconds = item.RunTimeTicks
      ? Math.floor(item.RunTimeTicks / 10_000_000)
      : undefined;

    return {
      id: item.Id,
      name: item.Name,
      album: resolvedAlbum,
      artists: item.Artists,
      albumArtist: item.AlbumArtist,
      year: albumYear,
      genres: item.Genres ?? [],
      albumId: item.AlbumId,
      path: source?.Path ?? '',
      format: source?.Container ?? 'unknown',
      size: source?.Size,
      bitrate: source?.Bitrate,
      trackNumber: item.IndexNumber,
      discNumber: item.ParentIndexNumber,
      durationSeconds,
    };
  }
}

/**
 * Extract the server root path (parent of the Jellyfin library folder) from track paths.
 *
 * A standard Jellyfin music library has paths structured as:
 *   server_prefix / library_name / Artist / Album / track.mp3
 * Going 4 levels up from the file gives `server_prefix`, so the relative path
 * used at the destination preserves `library_name/Artist/Album/track.mp3`.
 *
 * @param tracks - Array of TrackInfo with path property
 * @returns Detected server root path ending with "/", or empty string if not detectable
 */
export function detectServerRootPath(tracks: TrackInfo[]): string {
  const paths = tracks.map((t) => t.path).filter((p) => p && p.length > 0);

  if (paths.length === 0) {
    return '';
  }

  // For each track, compute the candidate server prefix by dropping the last 4
  // path components: filename + album_dir + artist_dir + library_name.
  // e.g. /mediamusic/lib/lib/Ace/Album/track.mp3 → /mediamusic/lib/
  const candidates = paths.map((p) => {
    const parts = p.split('/'); // ['', 'mediamusic', 'lib', 'lib', 'Ace', 'Album', 'track.mp3']
    if (parts.length < 5) return ''; // path too shallow to infer root
    const prefixParts = parts.slice(0, -4); // ['', 'mediamusic', 'lib']
    const prefix = prefixParts.join('/');
    return prefix.endsWith('/') ? prefix : prefix + '/';
  });

  // Filter out shallow paths (< 5 components) — they can't infer a root.
  // This prevents a single shallow track from poisoning detection for the whole batch.
  const validCandidates = candidates.filter((c) => c !== '');
  if (validCandidates.length === 0) {
    return '';
  }

  // All candidates should agree for a single Jellyfin library; find common prefix.
  const commonRoot = validCandidates.reduce((acc, c) => {
    let i = 0;
    while (i < acc.length && i < c.length && acc[i] === c[i]) i++;
    return acc.substring(0, i);
  });

  if (!commonRoot || commonRoot === '/') {
    return commonRoot || '';
  }

  // Ensure the result ends at a directory boundary with a trailing slash.
  if (!commonRoot.endsWith('/')) {
    const lastSlash = commonRoot.lastIndexOf('/');
    if (lastSlash > 0) {
      return commonRoot.substring(0, lastSlash + 1);
    }
    return '';
  }

  return commonRoot;
}

/**
 * Parse lyrics response from Jellyfin.
 * Handles Jellyfin >= 10.9 returning JSON with Lyrics array (ticks format)
 * and Jellyfin < 10.9 returning plain text LRC.
 *
 * @param responseText - Raw response text from /Audio/{id}/Lyrics endpoint
 * @returns Parsed lyrics as plain text LRC format, or original text if not JSON
 */
export function parseLyricsResponse(responseText: string): string {
  try {
    const parsed = JSON.parse(responseText);
    if (Array.isArray(parsed.Lyrics)) {
      return (parsed.Lyrics as unknown[])
        .filter(
          (line): line is { Start?: number; Text?: string } =>
            // eslint-disable-next-line eqeqeq -- != null intentionally checks both null and undefined
            line != null && typeof line === 'object',
        )
        .map((line: { Start?: number; Text?: string }) => {
          const seconds = (line.Start ?? 0) / 10_000_000;
          const minutes = Math.floor(seconds / 60);
          const secs = Math.floor(seconds % 60);
          const hundredths = Math.floor((seconds % 1) * 100);
          const timestamp = `[${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
          return `${timestamp}${line.Text ?? ''}`;
        })
        .join('\n');
    }
  } catch {
    // Not JSON — return as-is (plain LRC text or fallback)
  }
  return responseText;
}

/**
 * Create mock API client for testing
 */
export function createMockApiClient(overrides?: Partial<SyncApi>): SyncApi {
  const defaultMock: SyncApi = {
    testConnection: async () => ({ success: true, serverName: 'Mock Server' }),
    getUser: async () => ({ id: 'mock-user', name: 'Mock User' }),
    getArtistTracks: async () => [],
    getAlbumTracks: async () => [],
    getPlaylistTracks: async () => [],
    getGenreTracks: async () => [],
    getTracksForItems: async () => ({ tracks: [], errors: [] }),
    getItem: async () => null,
    getLibraryStats: async () => ({ artists: 0, albums: 0, tracks: 0 }),
    downloadItem: async () => Buffer.from(''),
    downloadItemStream: async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from(''));
    },
    getCoverArt: async () => Buffer.from(''),
    fetchLyrics: async () => null,
    fetchReplayGain: async () => null,
  };

  return { ...defaultMock, ...overrides };
}
