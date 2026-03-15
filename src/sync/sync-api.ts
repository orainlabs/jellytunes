/**
 * Jellyfin API Client Module
 * 
 * Handles all HTTP communication with Jellyfin server.
 * Designed to be mockable for unit tests.
 */

import type { SyncConfig, TrackInfo, ItemType } from './types';
import type { JellyfinTrackItem, JellyfinAlbumItem, JellyfinPlaylistItem } from './types';

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

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.userId = config.userId;
    this.timeout = config.timeout ?? 30000;
    this.fetchFn = config.fetch ?? fetch;
  }

  private getHeaders(): Record<string, string> {
    return {
      'X-MediaBrowser-Token': this.apiKey,
      'X-Emby-Token': this.apiKey,
      'Content-Type': 'application/json',
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
        headers: this.getHeaders(),
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
    // First get albums, then tracks for each album
    const albumsEndpoint = `/Users/${this.userId}/Items?AlbumArtistIds=${artistId}&includeItemTypes=MusicAlbum&Recursive=true&Fields=Path,MediaSources`;
    const albumsData = await this.request<{ Items: JellyfinAlbumItem[] }>(albumsEndpoint);
    
    const tracks: TrackInfo[] = [];
    
    for (const album of albumsData.Items ?? []) {
      const albumTracks = await this.getAlbumTracks(album.Id);
      tracks.push(...albumTracks);
    }
    
    return tracks;
  }

  async getAlbumTracks(albumId: string): Promise<TrackInfo[]> {
    // First get album info for year
    let albumYear: number | undefined;
    try {
      const albumData = await this.request<{ ProductionYear?: number }>(`/Users/${this.userId}/Items/${albumId}`);
      albumYear = albumData.ProductionYear;
    } catch {
      // Ignore - year is optional
    }
    
    const endpoint = `/Users/${this.userId}/Items?parentId=${albumId}&includeItemTypes=Audio&Recursive=true&Fields=Path,MediaSources,AlbumId`;
    const data = await this.request<{ Items: JellyfinTrackItem[] }>(endpoint);
    
    const tracks = await Promise.all(
      (data.Items ?? [])
        .filter(item => item.MediaSources?.[0]?.Path)
        .map(async item => {
          const track = await this.trackItemToInfo(item);
          track.year = track.year ?? albumYear;
          return track;
        })
    );
    
    return tracks;
  }

  async getPlaylistTracks(playlistId: string): Promise<TrackInfo[]> {
    const endpoint = `/Playlists/${playlistId}/Items?Fields=Path,MediaSources,AlbumId,ParentId`;
    const data = await this.request<{ Items: JellyfinTrackItem[] }>(endpoint);
    
    const tracks = await Promise.all(
      (data.Items ?? [])
        .filter(item => item.MediaSources?.[0]?.Path)
        .map(item => this.trackItemToInfo(item))
    );
    
    return tracks;
  }

  async getTracksForItems(
    itemIds: string[],
    itemTypes: Map<string, ItemType>
  ): Promise<{ tracks: TrackInfo[]; errors: string[] }> {
    const tracks: TrackInfo[] = [];
    const errors: string[] = [];
    
    for (const itemId of itemIds) {
      const itemType = itemTypes.get(itemId);
      
      if (!itemType) {
        errors.push(`Unknown item type for ID: ${itemId}`);
        continue;
      }
      
      try {
        let itemTracks: TrackInfo[];
        
        switch (itemType) {
          case 'artist':
            itemTracks = await this.getArtistTracks(itemId);
            break;
          case 'album':
            itemTracks = await this.getAlbumTracks(itemId);
            break;
          case 'playlist':
            itemTracks = await this.getPlaylistTracks(itemId);
            break;
          default:
            errors.push(`Unsupported item type: ${itemType}`);
            continue;
        }
        
        tracks.push(...itemTracks);
      } catch (error) {
        const message = error instanceof ApiError
          ? `Failed to fetch ${itemType} ${itemId}: ${error.message}`
          : `Error processing ${itemType} ${itemId}`;
        errors.push(message);
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

  private async trackItemToInfo(item: JellyfinTrackItem): Promise<TrackInfo> {
    const source = item.MediaSources?.[0];
    
    let year: number | undefined;
    // Try to get album year from parent item
    if (item.AlbumName) {
      try {
        const albumData = await this.request<{ ProductionYear?: number }>(`/Users/${this.userId}/Items/${item.AlbumId || item.ParentId}`);
        year = albumData.ProductionYear;
      } catch {
        // Ignore - year is optional
      }
    }
    
    return {
      id: item.Id,
      name: item.Name,
      album: item.AlbumName,
      artists: item.Artists,
      albumArtist: item.AlbumArtist,
      year,
      path: source?.Path ?? '',
      format: source?.Container ?? 'unknown',
      size: source?.Size,
      trackNumber: item.IndexNumber,
      discNumber: item.ParentIndexNumber,
    };
  }
}

/**
 * Extract common server root path from an array of track paths
 * 
 * Analyzes all track paths and finds the longest common prefix that looks like
 * a media library root (e.g., "/mediamusic/lib/lib/").
 * 
 * @param tracks - Array of TrackInfo with path property
 * @returns Detected server root path, or empty string if not detectable
 */
export function detectServerRootPath(tracks: TrackInfo[]): string {
  const paths = tracks
    .map(t => t.path)
    .filter(p => p && p.length > 0);
  
  if (paths.length === 0) {
    return '';
  }
  
  // Find the shortest path length to use as reference
  const minLength = Math.min(...paths.map(p => p.length));
  
  if (minLength === 0) {
    return '';
  }
  
  // Find common prefix character by character
  let commonPrefix = '';
  for (let i = 0; i < minLength; i++) {
    const char = paths[0][i];
    if (paths.every(p => p[i] === char)) {
      commonPrefix += char;
    } else {
      break;
    }
  }
  
  // The common prefix should end at a folder boundary (contains /)
  // and ideally looks like a media library root (contains 'lib' or 'music')
  if (!commonPrefix.includes('/')) {
    // No common folder structure, try to find a reasonable root
    // Look for patterns like /mediamusic/ or /music/
    const firstPath = paths[0];
    const mediaMatch = firstPath.match(/^\/[^/]+\/(lib|music|media|mediafiles|multimedia)\//i);
    if (mediaMatch) {
      const rootEnd = firstPath.indexOf('/', mediaMatch.index! + 1);
      if (rootEnd > 0) {
        return firstPath.substring(0, rootEnd + 1); // Include trailing slash
      }
    }
    return '';
  }
  
  // Ensure it ends with /
  if (!commonPrefix.endsWith('/')) {
    const lastSlash = commonPrefix.lastIndexOf('/');
    if (lastSlash > 0) {
      commonPrefix = commonPrefix.substring(0, lastSlash + 1);
    } else {
      return '';
    }
  }
  
  return commonPrefix;
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
  };
  
  return { ...defaultMock, ...overrides };
}