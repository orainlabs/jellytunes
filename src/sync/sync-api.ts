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
    public body?: string
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
  
  /** Get tracks for an artist */
  getArtistTracks(artistId: string): Promise<TrackInfo[]>;
  
  /** Get tracks for an album */
  getAlbumTracks(albumId: string): Promise<TrackInfo[]>;
  
  /** Get tracks in a playlist */
  getPlaylistTracks(playlistId: string): Promise<TrackInfo[]>;
  
  /** Get tracks for multiple items (batch) */
  getTracksForItems(
    itemIds: string[],
    itemTypes: Map<string, ItemType>
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
      await new Promise<void>(resolve => this.queue.push(resolve));
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
 * API client implementation
 */
class SyncApiImpl implements SyncApi {
  private baseUrl: string;
  private apiKey: string;
  private userId: string;
  private timeout: number;
  private fetchFn: typeof fetch;
  private limiter = new ConcurrencyLimiter(API_CONCURRENCY);
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
    options?: { method?: string; body?: unknown }
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
          body
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
        0
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

  async getArtistTracks(artistId: string): Promise<TrackInfo[]> {
    // First get albums, then fetch all album tracks in parallel (avoids N+1 serial calls)
    const albumsEndpoint = `/Users/${this.userId}/Items?AlbumArtistIds=${artistId}&includeItemTypes=MusicAlbum&Recursive=true&Fields=Path,MediaSources`;
    const albumsData = await this.request<{ Items: JellyfinAlbumItem[] }>(albumsEndpoint);

    const albumTrackArrays = await Promise.all(
      (albumsData.Items ?? []).map(album => this.getAlbumTracks(album.Id))
    );
    return albumTrackArrays.flat();
  }

  async getAlbumTracks(albumId: string): Promise<TrackInfo[]> {
    const [albumData, tracksData] = await Promise.all([
      this.request<{ Name?: string; ProductionYear?: number }>(`/Users/${this.userId}/Items/${albumId}`)
        .catch(() => ({ Name: undefined, ProductionYear: undefined })),
      this.request<{ Items: JellyfinTrackItem[] }>(
        `/Users/${this.userId}/Items?parentId=${albumId}&includeItemTypes=Audio&Recursive=true&Fields=Path,MediaSources,AlbumId,Genres,Artists,AlbumArtist,Album`
      ),
    ]);

    this.logger?.debug(`getAlbumTracks albumId=${albumId} → albumName="${albumData.Name}" tracks=${tracksData.Items?.length ?? 0}`);

    return (tracksData.Items ?? [])
      .filter(item => item.MediaSources?.[0]?.Path)
      .map(item => this.trackItemToInfo(item, albumData.ProductionYear, albumData.Name));
  }

  async getPlaylistTracks(playlistId: string): Promise<TrackInfo[]> {
    const data = await this.request<{ Items: JellyfinTrackItem[] }>(
      `/Playlists/${playlistId}/Items?UserId=${this.userId}&Fields=Path,MediaSources,AlbumId,ParentId,Genres,Artists,AlbumArtist,Album`
    );

    return (data.Items ?? [])
      .filter(item => item.MediaSources?.[0]?.Path)
      .map(item => this.trackItemToInfo(item));
  }

  async getTracksForItems(
    itemIds: string[],
    itemTypes: Map<string, ItemType>
  ): Promise<{ tracks: TrackInfo[]; errors: string[] }> {
    // Fetch all items in parallel, capped at API_CONCURRENCY to avoid server flooding
    const results = await Promise.allSettled(
      itemIds.map((itemId) => this.limiter.run(async () => {
        const itemType = itemTypes.get(itemId);
        if (!itemType) throw new Error(`Unknown item type for ID: ${itemId}`);
        switch (itemType) {
          case 'artist': return await this.getArtistTracks(itemId);
          case 'album': return await this.getAlbumTracks(itemId);
          case 'playlist': return await this.getPlaylistTracks(itemId);
          default: throw new Error(`Unsupported item type: ${itemType}`);
        }
      }))
    );

    const tracks: TrackInfo[] = [];
    const errors: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const itemId = itemIds[i];
      const itemType = itemTypes.get(itemId) ?? 'unknown';
      if (result.status === 'fulfilled') {
        // Tag every track with its parent item ID so callers can group by parent
        const taggedTracks = result.value.map(t => ({ ...t, parentItemId: itemId }));
        tracks.push(...taggedTracks);
      } else {
        const err = result.reason;
        errors.push(err instanceof ApiError
          ? `Failed to fetch ${itemType} ${itemId}: ${err.message}`
          : `Error processing ${itemType} ${itemId}`
        );
      }
    }
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
  private async fetchDownloadResponse(
    itemId: string,
    timeoutMs: number
  ): Promise<Response> {
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
          response.status
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
        0
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
        throw new ApiError(`Failed to fetch cover art: ${response.status} ${response.statusText}`, response.status);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw new ApiError('Cover art request timed out', 408);
      throw new ApiError(`Failed to fetch cover art: ${error instanceof Error ? error.message : String(error)}`, 0);
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
        throw new ApiError(`Failed to fetch lyrics: ${response.status} ${response.statusText}`, response.status);
      }

      const text = await response.text();
      return text || null;
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
      throw new ApiError(`Failed to fetch lyrics: ${error instanceof Error ? error.message : String(error)}`, 0);
    }
  }

  /**
   * Maps a Jellyfin track item to TrackInfo.
   * Year is injected separately (resolved at album level to avoid N+1 requests).
   */
  private trackItemToInfo(item: JellyfinTrackItem, albumYear?: number, albumName?: string): TrackInfo {
    const source = item.MediaSources?.[0];
    const resolvedAlbum = item.Album || item.AlbumName || albumName;

    this.logger?.debug(`trackItemToInfo track="${item.Name}" → item.Album="${item.Album ?? '(empty)'}" item.AlbumName="${item.AlbumName ?? '(empty)'}" albumName="${albumName ?? '(empty)'}" resolved="${resolvedAlbum}"`);

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
  const paths = tracks
    .map(t => t.path)
    .filter(p => p && p.length > 0);

  if (paths.length === 0) {
    return '';
  }

  // For each track, compute the candidate server prefix by dropping the last 4
  // path components: filename + album_dir + artist_dir + library_name.
  // e.g. /mediamusic/lib/lib/Ace/Album/track.mp3 → /mediamusic/lib/
  const candidates = paths.map(p => {
    const parts = p.split('/'); // ['', 'mediamusic', 'lib', 'lib', 'Ace', 'Album', 'track.mp3']
    if (parts.length < 5) return ''; // path too shallow to infer root
    const prefixParts = parts.slice(0, -4); // ['', 'mediamusic', 'lib']
    const prefix = prefixParts.join('/');
    return prefix.endsWith('/') ? prefix : prefix + '/';
  });

  // Filter out shallow paths (< 5 components) — they can't infer a root.
  // This prevents a single shallow track from poisoning detection for the whole batch.
  const validCandidates = candidates.filter(c => c !== '');
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
 * Create mock API client for testing
 */
export function createMockApiClient(overrides?: Partial<SyncApi>): SyncApi {
  const defaultMock: SyncApi = {
    testConnection: async () => ({ success: true, serverName: 'Mock Server' }),
    getUser: async () => ({ id: 'mock-user', name: 'Mock User' }),
    getArtistTracks: async () => [],
    getAlbumTracks: async () => [],
    getPlaylistTracks: async () => [],
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
  };

  return { ...defaultMock, ...overrides };
}