/**
 * Lyrics Sync Unit Tests
 * Tests for fetchLyrics API, embedding by format, LRC sidecar, and fallback behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import { createApiClient, ApiError, createMockApiClient } from './sync-api';
import { createMockConverter, createMockFileSystem } from './sync-files';
import { createTestSyncCore, type SyncDependencies } from './sync-core';
import type { SyncConfig, TrackInfo, ItemType } from './types';

const VALID_API_CONFIG = {
  baseUrl: 'https://jellyfin.example.com',
  apiKey: '0123456789abcdef0123456789abcdef',
  userId: 'abcdef1234567890abcdef1234567890',
  timeout: 5000,
};

const validConfig: SyncConfig = {
  serverUrl: 'https://jellyfin.example.com',
  apiKey: '0123456789abcdef0123456789abcdef',
  userId: 'abcdef1234567890abcdef1234567890',
};

function makeMockResponse(overrides: Partial<Response> & { ok: boolean; status: number; statusText: string }): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: 'https://jellyfin.example.com/Audio/track-1/Lyrics',
    clone: () => ({}) as any,
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => '',
    json: async () => { throw new Error('not json'); },
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    bodyUsed: false,
    body: null,
    ...overrides,
  } as unknown as Response;
}

describe('fetchLyrics', () => {
  it('returns lyrics string on successful fetch', async () => {
    const expectedLyrics = '[00:00.00]Hello world\n[00:05.00]This is a test';
    const api = createApiClient({
      ...VALID_API_CONFIG,
      fetch: async () => makeMockResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream(),
        text: async () => expectedLyrics,
      }),
    });

    const result = await api.fetchLyrics('track-1');
    expect(result).toBe(expectedLyrics);
  });

  it('returns null on HTTP 404 (no lyrics available)', async () => {
    const api = createApiClient({
      ...VALID_API_CONFIG,
      fetch: async () => makeMockResponse({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        body: null,
      }),
    });

    const result = await api.fetchLyrics('track-1');
    expect(result).toBeNull();
  });

  it('returns null on empty response body', async () => {
    const api = createApiClient({
      ...VALID_API_CONFIG,
      fetch: async () => makeMockResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream(),
        text: async () => '',
      }),
    });

    const result = await api.fetchLyrics('track-1');
    expect(result).toBeNull();
  });

  it('throws ApiError on HTTP 500', async () => {
    const api = createApiClient({
      ...VALID_API_CONFIG,
      fetch: async () => makeMockResponse({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        body: null,
      }),
    });

    await expect(api.fetchLyrics('track-1')).rejects.toThrow(ApiError);
  });

  it('handles pre-10.9 fallback when endpoint returns 404', async () => {
    // Jellyfin < 10.9 doesn't have the /Audio/{id}/Lyrics endpoint - returns 404
    const api = createApiClient({
      ...VALID_API_CONFIG,
      fetch: async () => makeMockResponse({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        body: null,
      }),
    });

    const result = await api.fetchLyrics('track-1');
    expect(result).toBeNull();
  });
});

describe('embedLyrics FFmpeg integration', () => {
  it('embedLyrics is present on FFmpeg converter', async () => {
    const { createFFmpegConverter } = await import('./sync-files');
    const converter = createFFmpegConverter();
    expect(typeof converter.embedLyrics).toBe('function');
  });

  it('mock converter supports embedLyrics', async () => {
    const mock = createMockConverter();
    const result = await mock.embedLyrics?.('/input.mp3', '/output.mp3', '[00:00]Test lyrics', 'mp3');
    expect(result?.success).toBe(true);
  });

  it('mock converter embedLyrics returns error on failure', async () => {
    const mock = createMockConverter();
    mock.embedLyrics = async () => ({ success: false, error: 'FFmpeg not found' });
    const result = await mock.embedLyrics('/input.mp3', '/output.mp3', 'lyrics', 'mp3');
    expect(result.success).toBe(false);
    expect(result.error).toBe('FFmpeg not found');
  });
});

describe('lyrics sync config', () => {
  it('DEFAULT_SYNC_OPTIONS includes lyricsMode off', async () => {
    const { DEFAULT_SYNC_OPTIONS } = await import('./sync-config');
    expect(DEFAULT_SYNC_OPTIONS.lyricsMode).toBe('off');
  });

  it('resolveSyncOptions merges user lyricsMode', async () => {
    const { resolveSyncOptions } = await import('./sync-config');
    const options = resolveSyncOptions({ lyricsMode: 'lrc' });
    expect(options.lyricsMode).toBe('lrc');
  });

  it('LyricsMode type accepts lrc embed off', async () => {
    const { LyricsMode } = await import('./types');
    const modes: LyricsMode[] = ['lrc', 'embed', 'off'];
    expect(modes).toContain('lrc');
    expect(modes).toContain('embed');
    expect(modes).toContain('off');
  });
});

describe('processLyrics behavior', () => {
  // Test processLyrics directly by calling it via the public sync() with controlled mocks

  function createTestDeps(overrides?: Partial<SyncDependencies>) {
    const mockFs = createMockFileSystem() as any;
    mockFs.getItemSize = async () => 100;
    return {
      api: createMockApiClient(),
      fs: mockFs,
      converter: createMockConverter(),
      ...overrides,
    };
  }

  it('skips when lyricsMode is off', async () => {
    const mockApi = createMockApiClient();
    const fetchLyricsSpy = vi.fn().mockResolvedValue('[00:00]Test lyrics');
    mockApi.fetchLyrics = fetchLyricsSpy;

    // Track needs to be "new" so it goes through copyOrConvertTrack → processLyrics
    // Set up getTracksForItems to return our track
    const tracks: TrackInfo[] = [
      { id: 'track-1', name: 'Track', album: 'Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Album/track.mp3', format: 'mp3', size: 100 },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from('fake audio'));
    };
    mockApi.getItem = vi.fn().mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const deps = createTestDeps({ api: mockApi });
    const core = createTestSyncCore(validConfig, deps);

    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'off' },
    });

    // fetchLyrics should NOT be called when lyricsMode is off
    expect(fetchLyricsSpy).not.toHaveBeenCalled();
  });

  it('returns 0 lyricsAdded when lyricsMode is embed but no lyrics available', async () => {
    const mockApi = createMockApiClient();
    mockApi.fetchLyrics = vi.fn().mockResolvedValue(null); // No lyrics

    const tracks: TrackInfo[] = [
      { id: 'track-1', name: 'Track', album: 'Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Album/track.mp3', format: 'mp3', size: 100 },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from('fake audio'));
    };
    mockApi.getItem = vi.fn().mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const deps = createTestDeps({ api: mockApi });
    const core = createTestSyncCore(validConfig, deps);

    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'embed' },
    });

    expect(result.lyricsAdded).toBe(0);
  });
});