/**
 * Lyrics Sync Unit Tests
 * Tests for fetchLyrics API, embedding by format, LRC sidecar, and fallback behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApiClient, ApiError, createMockApiClient } from './sync-api';
import { createMockConverter, createMockFileSystem } from './sync-files';
import { createTestSyncCore, type SyncDependencies } from './sync-core';
import type { SyncConfig, TrackInfo, ItemType, LyricsMode } from './types';
import { LyricsModes } from './types';

const mockGetSyncedTracksForDevice = vi.hoisted(() => vi.fn(() => []));
const mockGetSyncedItems = vi.hoisted(() => vi.fn(() => []));

vi.mock('../main/database', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  upsertSyncedTrack: vi.fn(),
  getSyncedTracksForDevice: mockGetSyncedTracksForDevice,
  getSyncedTracksForItem: mockGetSyncedTracksForDevice,
  getSyncedItems: mockGetSyncedItems,
  removeSyncedTracksForItem: vi.fn(),
  removeSyncedTrack: vi.fn(),
}));

beforeEach(() => {
  mockGetSyncedTracksForDevice.mockReset();
  mockGetSyncedTracksForDevice.mockReturnValue([]);
  mockGetSyncedItems.mockReset();
  mockGetSyncedItems.mockReturnValue([]);
});
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

// Helper to create test dependencies (reused across tests)
function createTestDeps(overrides?: Partial<SyncDependencies>) {
  return {
    api: createMockApiClient(),
    fs: createMockFileSystem(),
    converter: createMockConverter(),
    ...overrides,
  };
}

function makeMockResponse(
  overrides: Partial<Response> & { ok: boolean; status: number; statusText: string },
): Response {
  return {
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: 'https://jellyfin.example.com/Audio/track-1/Lyrics',
    clone: () => ({}) as any,
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => '',
    json: async () => {
      throw new Error('not json');
    },
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
      fetch: async () =>
        makeMockResponse({
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
      fetch: async () =>
        makeMockResponse({
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
      fetch: async () =>
        makeMockResponse({
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
      fetch: async () =>
        makeMockResponse({
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
      fetch: async () =>
        makeMockResponse({
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
    const embedFn = converter.embedLyrics;
    expect(typeof embedFn).toBe('function');
  });

  it('mock converter supports embedLyrics', async () => {
    const mock = createMockConverter();
    const result = await mock.embedLyrics?.(
      '/input.mp3',
      '/output.mp3',
      '[00:00]Test lyrics',
      'mp3',
    );
    expect(result?.success).toBe(true);
  });

  it('mock converter embedLyrics returns error on failure', async () => {
    const mock = createMockConverter();
    mock.embedLyrics = async () => ({ success: false, error: 'FFmpeg not found' });
    const result = await mock.embedLyrics('/input.mp3', '/output.mp3', 'lyrics', 'mp3');
    expect(result.success).toBe(false);
    expect(result.error).toBe('FFmpeg not found');
  });

  it('embedLyrics for MP3 does NOT use a temp file that gets deleted before FFmpeg runs', async () => {
    // This test verifies the fix for the bug where MP3 branch:
    // 1. Creates a temp file
    // 2. Passes temp file path to FFmpeg args
    // 3. Deletes temp file BEFORE FFmpeg spawns
    // Result: FFmpeg fails with "No such file"
    const { createFFmpegConverter } = await import('./sync-files');
    const converter = createFFmpegConverter();

    // Track files that are unlinked BEFORE spawn is called
    const unlinkedFiles: string[] = [];
    const fs = require('fs');
    const originalUnlinkSync = fs.unlinkSync;
    fs.unlinkSync = function (path: string) {
      unlinkedFiles.push(path);
      return originalUnlinkSync(path);
    };

    // Mock spawn to capture args but not actually run FFmpeg
    const childProcess = require('child_process');
    const spawnArgs: string[][] = [];
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = function (_cmd: string, args: string[], _opts: any) {
      spawnArgs.push(args);
      // Return a mock proc that simulates successful FFmpeg exit
      const mockProc = {
        on: function (event: string, cb: (arg: number | Error) => void) {
          if (event === 'close') {
            // Simulate async FFmpeg success after args are captured
            setTimeout(() => cb(0), 0);
          }
          if (event === 'error') {
            setTimeout(() => cb(new Error('mock')), 0);
          }
          return mockProc;
        },
        emit: () => mockProc,
        removeAllListeners: () => mockProc,
        kill: () => {},
        stderr: { on: () => {} },
      };
      return mockProc;
    } as typeof childProcess.spawn;

    // Direct call — embedLyrics is a required method on AudioConverter
    try {
      await converter.embedLyrics('/input.mp3', '/output.mp3', '[00:00]Test lyrics', 'mp3');

      // Find the args passed to the FFmpeg call
      const ffmpegCall = spawnArgs.find(
        (args) => args.includes('-i') && args.includes('/input.mp3'),
      );
      expect(ffmpegCall).toBeDefined();

      // The bug: ffmpegCall would include '-i', '<tempfile>.txt' that gets deleted
      // After fix: MP3 should NOT have a second -i flag with a temp file
      const tempFileArgs = ffmpegCall!.filter((arg) => arg.includes('jt-lrc-'));
      expect(tempFileArgs).toHaveLength(0);

      // Also verify that NO temp file was unlinked before we got here
      // (if bug exists, unlinkedFiles would contain a jt-lrc- file)
      const deletedTempFiles = unlinkedFiles.filter((f) => f.includes('jt-lrc-'));
      expect(deletedTempFiles).toHaveLength(0);

      // Verify correct metadata flags are present
      const metadataIdx = ffmpegCall!.indexOf('-metadata');
      expect(metadataIdx).toBeGreaterThan(-1);
      const lyricsArg = ffmpegCall![metadataIdx + 1];
      expect(lyricsArg).toMatch(/^lyrics=/);
      // Verify lyrics value contains our test content
      expect(lyricsArg).toContain('Test lyrics');

      // Verify NOT using the invalid `-metadata:sync` syntax
      const invalidSyncArgs = ffmpegCall!.filter((arg) => arg.startsWith('-metadata:sync'));
      expect(invalidSyncArgs).toHaveLength(0);
    } finally {
      // Restore
      fs.unlinkSync = originalUnlinkSync;
      if (originalSpawn) {
        childProcess.spawn = originalSpawn;
      }
    }
  });
  it('embedLyrics for M4A uses "lyrics=" metadata key, not "©lyr"', async () => {
    // Bug: sync-files.ts line 819 uses `-metadata ©lyr=...` for M4A/AAC,
    // but FFmpeg silently ignores the ©lyr key — lyrics never get written.
    // Fix: use `-metadata lyrics=...` which FFmpeg correctly maps to ©lyr atom.
    const { createFFmpegConverter } = await import('./sync-files');
    const converter = createFFmpegConverter();

    const childProcess = require('child_process');
    const spawnArgs: string[][] = [];
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = function (_cmd: string, args: string[], _opts: any) {
      spawnArgs.push(args);
      const mockProc = {
        on: function (event: string, cb: (arg: number | Error) => void) {
          if (event === 'close') setTimeout(() => cb(0), 0);
          if (event === 'error') setTimeout(() => cb(new Error('mock')), 0);
          return mockProc;
        },
        emit: () => mockProc,
        removeAllListeners: () => mockProc,
        kill: () => {},
        stderr: { on: () => {} },
      };
      return mockProc;
    } as typeof childProcess.spawn;

    try {
      await converter.embedLyrics('/input.m4a', '/output.m4a', '[00:00]M4A lyrics', 'm4a');

      const ffmpegCall = spawnArgs.find(
        (args) => args.includes('-i') && args.includes('/input.m4a'),
      );
      expect(ffmpegCall).toBeDefined();

      // Find metadata arg for lyrics
      const metadataIdx = ffmpegCall!.indexOf('-metadata');
      expect(metadataIdx).toBeGreaterThan(-1);
      const lyricsArg = ffmpegCall![metadataIdx + 1];

      // CORRECT: use `lyrics=` — FFmpeg maps this to ©lyr atom in MP4 container
      expect(lyricsArg).toMatch(/^lyrics=/);
      expect(lyricsArg).toContain('M4A lyrics');

      // WRONG: ©lyr key is silently ignored by FFmpeg — verify we're NOT using it
      const invalidCpyrArgs = ffmpegCall!.filter((arg) => arg.startsWith('©lyr='));
      expect(invalidCpyrArgs).toHaveLength(0);
    } finally {
      childProcess.spawn = originalSpawn;
    }
  });

  it('embedLyrics for AAC uses "lyrics=" metadata key, not "©lyr"', async () => {
    const { createFFmpegConverter } = await import('./sync-files');
    const converter = createFFmpegConverter();

    const childProcess = require('child_process');
    const spawnArgs: string[][] = [];
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = function (_cmd: string, args: string[], _opts: any) {
      spawnArgs.push(args);
      const mockProc = {
        on: function (event: string, cb: (arg: number | Error) => void) {
          if (event === 'close') setTimeout(() => cb(0), 0);
          if (event === 'error') setTimeout(() => cb(new Error('mock')), 0);
          return mockProc;
        },
        emit: () => mockProc,
        removeAllListeners: () => mockProc,
        kill: () => {},
        stderr: { on: () => {} },
      };
      return mockProc;
    } as typeof childProcess.spawn;

    try {
      await converter.embedLyrics('/input.aac', '/output.aac', '[00:00]AAC lyrics', 'aac');

      const ffmpegCall = spawnArgs.find(
        (args) => args.includes('-i') && args.includes('/input.aac'),
      );
      expect(ffmpegCall).toBeDefined();

      const metadataIdx = ffmpegCall!.indexOf('-metadata');
      expect(metadataIdx).toBeGreaterThan(-1);
      const lyricsArg = ffmpegCall![metadataIdx + 1];

      expect(lyricsArg).toMatch(/^lyrics=/);
      expect(lyricsArg).toContain('AAC lyrics');

      const invalidCpyrArgs = ffmpegCall!.filter((arg) => arg.startsWith('©lyr='));
      expect(invalidCpyrArgs).toHaveLength(0);
    } finally {
      childProcess.spawn = originalSpawn;
    }
  });
});

describe('JSON to LRC text conversion', () => {
  it('AC-1: parses JSON with Lyrics array and converts to LRC text', async () => {
    const { parseLyricsResponse } = await import('./sync-api');

    const jsonResponse = JSON.stringify({
      Lyrics: [
        { Start: 0, Text: 'Hello world' },
        { Start: 50000000, Text: 'Second line' },
        { Start: 120000000, Text: 'Third line' },
      ],
    });

    const result = parseLyricsResponse(jsonResponse);
    expect(result).toBe('[00:00.00]Hello world\n[00:05.00]Second line\n[00:12.00]Third line');
  });

  it('AC-1: uses original text as fallback when JSON parse fails', async () => {
    const { parseLyricsResponse } = await import('./sync-api');

    const plainLrc = '[00:00.00]Original lyrics\n[00:05.00]More lyrics';
    const result = parseLyricsResponse(plainLrc);
    expect(result).toBe(plainLrc);
  });

  it('AC-2: returns plain text LRC unchanged (pre-10.9 fallback)', async () => {
    const { parseLyricsResponse } = await import('./sync-api');

    const plainLrc = '[00:12.34]Line one\n[00:56.78]Line two';
    const result = parseLyricsResponse(plainLrc);
    expect(result).toBe(plainLrc);
  });

  it('AC-3: LRC format has two decimal places for seconds', async () => {
    const { parseLyricsResponse } = await import('./sync-api');

    const jsonResponse = JSON.stringify({
      Lyrics: [
        { Start: 123456789, Text: 'Test' }, // ~12.3 seconds
      ],
    });

    const result = parseLyricsResponse(jsonResponse);
    expect(result).toMatch(/^\[00:12\.\d{2}\]Test$/);
  });

  it('AC-3: lines are separated by newline', async () => {
    const { parseLyricsResponse } = await import('./sync-api');

    const jsonResponse = JSON.stringify({
      Lyrics: [
        { Start: 0, Text: 'Line 1' },
        { Start: 10000000, Text: 'Line 2' },
        { Start: 20000000, Text: 'Line 3' },
      ],
    });

    const result = parseLyricsResponse(jsonResponse);
    expect(result).toBe('[00:00.00]Line 1\n[00:01.00]Line 2\n[00:02.00]Line 3');
  });

  it('AC-4: LRC file written to disk contains plain text LRC, never JSON', async () => {
    const mockApi = createMockApiClient();
    // parseLyricsResponse converts JSON to LRC text, so mock fetchLyrics to return the parsed text
    const jsonResponse = JSON.stringify({
      Lyrics: [{ Start: 0, Text: 'Test lyrics' }],
    });
    // Import and use the real parseLyricsResponse to simulate what fetchLyrics does
    const { parseLyricsResponse } = await import('./sync-api');
    const parsedLyrics = parseLyricsResponse(jsonResponse);
    mockApi.fetchLyrics = vi.fn().mockResolvedValue(parsedLyrics);

    const tracks: TrackInfo[] = [
      {
        id: 'track-1',
        name: 'Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/lib/lib/Artist/Album/track.mp3',
        format: 'mp3',
        size: 100,
      },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from('fake audio'));
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const mockFs = createMockFileSystem() as any;
    const deps = createTestDeps({ api: mockApi, fs: mockFs });
    const core = createTestSyncCore(validConfig, deps);

    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'lrc' },
    });

    // Verify LRC file contains plain text, not JSON
    // getOutputDir falls back to metadata-based path: /usb/lib/Artist/Album (no serverRootPath)
    const lrcContent = mockFs.__getFile('/usb/lib/Artist/Album/track.lrc');
    expect(lrcContent).toBeDefined();
    expect(lrcContent!.toString('utf8')).not.toContain('{"Lyrics"');
    expect(lrcContent!.toString('utf8')).toContain('[00:00.00]Test lyrics');
  });

  it('AC-5: embed mode passes plain text (no timestamps) to FFmpeg', async () => {
    const mockApi = createMockApiClient();
    const jsonResponse = JSON.stringify({
      Lyrics: [
        { Start: 0, Text: 'Embedded line 1' },
        { Start: 50000000, Text: 'Embedded line 2' },
      ],
    });
    // parseLyricsResponse converts JSON to LRC text (simulating real fetchLyrics behavior)
    const { parseLyricsResponse } = await import('./sync-api');
    const parsedLyrics = parseLyricsResponse(jsonResponse);
    mockApi.fetchLyrics = vi.fn().mockResolvedValue(parsedLyrics);

    const tracks: TrackInfo[] = [
      {
        id: 'track-1',
        name: 'Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/lib/lib/Artist/Album/track.mp3',
        format: 'mp3',
        size: 100,
      },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from('fake audio'));
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const mockConverter = createMockConverter();
    const embedLyricsSpy = vi.fn().mockResolvedValue({ success: true });
    mockConverter.embedLyrics = embedLyricsSpy;

    const deps = createTestDeps({ api: mockApi, converter: mockConverter });
    const core = createTestSyncCore(validConfig, deps);

    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'embed', embedMetadata: true },
    });

    // Verify embedLyrics was called with plain text (no JSON, no timestamps)
    expect(embedLyricsSpy).toHaveBeenCalled();
    const [, , lyricsArg] = embedLyricsSpy.mock.calls[0];
    expect(lyricsArg).not.toContain('{');
    expect(lyricsArg).not.toContain('[00:');
    expect(lyricsArg).toContain('Embedded line 1');
  });
});

describe('removeItems cleans up LRC sidecars', () => {
  // Stable config WITH serverRootPath so path computation works in tests
  const configWithServerRoot: SyncConfig = {
    serverUrl: 'https://jellyfin.example.com',
    apiKey: '0123456789abcdef0123456789abcdef',
    userId: 'abcdef1234567890abcdef1234567890',
    serverRootPath: '/music/',
  };

  it('AC-6: deletes .lrc sidecar when removing audio file', async () => {
    const mockApi = createMockApiClient();
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({
      tracks: [
        {
          id: 'track-1',
          name: 'Track',
          album: 'Album',
          artists: ['Artist'],
          path: '/music/Artist/Album/track.mp3',
          format: 'mp3',
          size: 100,
        },
      ],
      errors: [],
    });
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    // Set up mock filesystem with files that need to be deleted
    const mockFs = createMockFileSystem() as any;
    mockFs.__setFile('/music/Artist/Album/track.mp3', Buffer.from('audio'));
    mockFs.__setFile('/music/Artist/Album/track.lrc', Buffer.from('[00:00]lyrics'));
    // Mock readdir to return no M3U8 files (empty set for protectedPaths)
    mockFs.readdir = async (path: string) => {
      if (path === '/music') return []; // No M3U8 files
      return [];
    };

    const deps = createTestDeps({ api: mockApi, fs: mockFs });
    const core = createTestSyncCore(configWithServerRoot, deps);

    const result = await core.removeItems(
      ['album-1'],
      new Map([['album-1', 'album' as ItemType]]),
      '/music',
    );

    // Verify track was removed
    expect(result.removed).toBeGreaterThan(0);
    // Verify LRC sidecar was deleted
    expect(mockFs.__getFile('/music/Artist/Album/track.lrc')).toBeUndefined();
    expect(mockFs.__getFile('/music/Artist/Album/track.mp3')).toBeUndefined();
  });

  it('AC-7: detects and removes orphaned .lrc files after removing audio', async () => {
    const mockApi = createMockApiClient();
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({
      tracks: [
        {
          id: 'track-1',
          name: 'Track',
          album: 'Album',
          artists: ['Artist'],
          path: '/music/Artist/Album/track.mp3',
          format: 'mp3',
          size: 100,
        },
      ],
      errors: [],
    });
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const mockFs = createMockFileSystem() as any;
    // Simulate existing audio and LRC files
    mockFs.__setFile('/music/Artist/Album/track.mp3', Buffer.from('audio'));
    mockFs.__setFile('/music/Artist/Album/track.lrc', Buffer.from('[00:00]lyrics'));
    // Simulate orphaned LRC file (no corresponding audio)
    mockFs.__setFile('/music/Artist/Album/orphan.lrc', Buffer.from('[00:00]orphan lyrics'));
    // Mock readdir - no M3U8 files
    mockFs.readdir = async (path: string) => {
      if (path === '/music') return []; // No M3U8 files
      if (path === '/music/Artist/Album') {
        return ['track.mp3', 'track.lrc', 'orphan.lrc'];
      }
      return [];
    };

    const deps = createTestDeps({ api: mockApi, fs: mockFs });
    const core = createTestSyncCore(configWithServerRoot, deps);

    const result = await core.removeItems(
      ['album-1'],
      new Map([['album-1', 'album' as ItemType]]),
      '/music',
    );

    // Verify track was removed
    expect(result.removed).toBeGreaterThan(0);
    // Verify orphaned LRC was removed
    expect(mockFs.__getFile('/music/Artist/Album/orphan.lrc')).toBeUndefined();
    // Verify legitimate LRC (with corresponding audio) is also removed when audio is deleted
    // (since removeItems deletes both the audio and its companion .lrc sidecar)
    expect(mockFs.__getFile('/music/Artist/Album/track.lrc')).toBeUndefined();
  });

  it('AC-7b: legitimate .lrc files survive when audio files remain', async () => {
    // This verifies cleanOrphanedLrcFiles does NOT delete .lrc files that have
    // corresponding audio files (track.mp3 exists → track.lrc survives)
    const mockApi = createMockApiClient();
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({
      tracks: [
        {
          id: 'track-1',
          name: 'Track',
          album: 'Album',
          artists: ['Artist'],
          path: '/music/Artist/Album/track.mp3',
          format: 'mp3',
          size: 100,
        },
      ],
      errors: [],
    });
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const mockFs = createMockFileSystem() as any;
    // Simulate existing audio and its companion LRC
    mockFs.__setFile('/music/Artist/Album/track.mp3', Buffer.from('audio'));
    mockFs.__setFile('/music/Artist/Album/track.lrc', Buffer.from('[00:00]lyrics'));
    // Simulate orphaned LRC file (no corresponding audio)
    mockFs.__setFile('/music/Artist/Album/orphan.lrc', Buffer.from('[00:00]orphan lyrics'));
    // Mock readdir - no M3U8 files
    mockFs.readdir = async (path: string) => {
      if (path === '/music') return []; // No M3U8 files
      if (path === '/music/Artist/Album') {
        return ['track.mp3', 'track.lrc', 'orphan.lrc'];
      }
      return [];
    };

    const deps = createTestDeps({ api: mockApi, fs: mockFs });
    const core = createTestSyncCore(configWithServerRoot, deps) as any;

    // Call cleanOrphanedLrcFiles directly on the directory
    await core.cleanOrphanedLrcFiles('/music/Artist/Album');

    // Verify track.lrc survives (has corresponding audio file)
    expect(mockFs.__getFile('/music/Artist/Album/track.lrc')).toBeDefined();
    // Verify orphaned LRC was removed (no corresponding audio file)
    expect(mockFs.__getFile('/music/Artist/Album/orphan.lrc')).toBeUndefined();
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
    // LyricsMode is a string literal union type imported from types.ts
    // LyricsModes provides runtime values that stay in sync with the type
    const modes: LyricsMode[] = [...LyricsModes];
    expect(modes).toContain('lrc');
    expect(modes).toContain('embed');
    expect(modes).toContain('off');
  });
});

describe('processLyrics for unchanged files — ORAIN-0313', () => {
  // Bug: when a track is unchanged (same metadata, bitrate, coverArt, path),
  // handleSyncedRecord returns { skipped: true, lyricsAdded: 0 } without processing lyrics.
  // If the user changes lyricsMode after an initial sync, existing files should still get lyrics.

  function makeTrack(overrides?: Partial<TrackInfo>): TrackInfo {
    return {
      id: 'track-x',
      name: 'Track',
      album: 'Album',
      artists: ['Artist'],
      path: '/music/Artist/Album/track.mp3',
      format: 'mp3',
      size: 5_000_000,
      trackNumber: 1,
      ...overrides,
    };
  }

  it('processes lyrics for unchanged file when lyricsMode is lrc', async () => {
    const { upsertSyncedTrack } = await import('../main/database');

    const mockApi = createMockApiClient();
    const fetchLyricsSpy = vi.fn().mockResolvedValue('[00:00]Test lyrics');
    mockApi.fetchLyrics = fetchLyricsSpy;
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks: [makeTrack()], errors: [] });
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from('fake audio'));
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    // Existing synced record with SAME metadata hash — track is "unchanged"
    // but lyricsMode changed from 'off' → 'lrc'
    const existingRecord = {
      id: 1,
      deviceId: 1,
      itemId: 'album-1',
      trackId: 'track-x',
      destinationPath: '/usb/Artist/Album/track.mp3',
      fileSize: 5_000_000,
      metadataHash: '937fa605ca04', // matches computeMetadataHash(buildMetadata(track))
      coverArtMode: 'embed' as const,
      encodedBitrate: '192k' as const,
      serverPath: '/music/Artist/Album/track.mp3',
      serverRootPath: null,
      syncedAt: new Date().toISOString(),
    } as const;

    mockGetSyncedTracksForDevice.mockReturnValueOnce([existingRecord] as any);
    mockGetSyncedTracksForDevice.mockReturnValueOnce([existingRecord] as any);

    const deps = {
      api: mockApi,
      fs: createMockFileSystem(),
      converter: createMockConverter(),
    };

    const core = createTestSyncCore(validConfig, deps);

    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'lrc' },
    });

    // fetchLyrics MUST be called even though the file is unchanged
    expect(fetchLyricsSpy).toHaveBeenCalledWith('track-x');
    expect(vi.mocked(upsertSyncedTrack)).toHaveBeenCalled();
  });

  it('processes lyrics for unchanged file when lyricsMode is embed', async () => {
    const { upsertSyncedTrack } = await import('../main/database');

    const mockApi = createMockApiClient();
    const fetchLyricsSpy = vi.fn().mockResolvedValue('[00:00]Embedded lyrics');
    mockApi.fetchLyrics = fetchLyricsSpy;
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks: [makeTrack()], errors: [] });
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from('fake audio'));
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const existingRecord = {
      id: 1,
      deviceId: 1,
      itemId: 'album-1',
      trackId: 'track-x',
      destinationPath: '/usb/Artist/Album/track.mp3',
      fileSize: 5_000_000,
      metadataHash: '4291b888db42e390',
      coverArtMode: 'embed' as const,
      encodedBitrate: '192k' as const,
      serverPath: '/music/Artist/Album/track.mp3',
      serverRootPath: null,
      syncedAt: new Date().toISOString(),
    } as const;

    mockGetSyncedTracksForDevice.mockReturnValueOnce([existingRecord] as any);
    mockGetSyncedTracksForDevice.mockReturnValueOnce([existingRecord] as any);

    const deps = {
      api: mockApi,
      fs: createMockFileSystem(),
      converter: createMockConverter(),
    };

    const core = createTestSyncCore(validConfig, deps);

    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'embed' },
    });

    // fetchLyrics MUST be called even though the file is unchanged
    expect(fetchLyricsSpy).toHaveBeenCalledWith('track-x');
    expect(vi.mocked(upsertSyncedTrack)).toHaveBeenCalled();
  });
});

describe('processLyrics behavior', () => {
  // Test processLyrics directly by calling it via the public sync() with controlled mocks

  it('skips when lyricsMode is off', async () => {
    const mockApi = createMockApiClient();
    const fetchLyricsSpy = vi.fn().mockResolvedValue('[00:00]Test lyrics');
    mockApi.fetchLyrics = fetchLyricsSpy;

    // Track needs to be "new" so it goes through copyOrConvertTrack → processLyrics
    // Set up getTracksForItems to return our track
    const tracks: TrackInfo[] = [
      {
        id: 'track-1',
        name: 'Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/lib/lib/Artist/Album/track.mp3',
        format: 'mp3',
        size: 100,
      },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from('fake audio'));
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
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
      {
        id: 'track-1',
        name: 'Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/lib/lib/Artist/Album/track.mp3',
        format: 'mp3',
        size: 100,
      },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from('fake audio'));
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
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

  it('logs warn (not debug) for non-404 API errors in processLyrics', async () => {
    const mockApi = createMockApiClient();
    // Simulate pre-10.9 server returning 501 (not implemented)
    const fetchLyricsSpy = vi
      .fn()
      .mockRejectedValue(new ApiError('Failed to fetch lyrics: 501 Not Implemented', 501));
    mockApi.fetchLyrics = fetchLyricsSpy;

    const tracks: TrackInfo[] = [
      {
        id: 'track-1',
        name: 'Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/lib/lib/Artist/Album/track.mp3',
        format: 'mp3',
        size: 100,
      },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from('fake audio'));
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const mockFs = createMockFileSystem();
    mockFs.isDirectory = async () => true; // Simulate /usb being a real directory

    // Spy on the logger
    const warnSpy = vi.fn();
    const debugSpy = vi.fn();
    const deps = createTestDeps({
      api: mockApi,
      fs: mockFs,
      logger: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: debugSpy },
    });
    const core = createTestSyncCore(validConfig, deps);

    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'lrc', embedMetadata: false },
    });

    // Non-fatal: sync completes with 0 lyrics added
    expect(result.lyricsAdded).toBe(0);

    // Verify fetchLyrics was called (so we know processLyrics ran)
    expect(fetchLyricsSpy).toHaveBeenCalledOnce();

    // Non-404 error should use warn (not debug)
    // Note: warnSpy may also receive "Failed to load synced records" — filter by the lyrics message
    const lyricsWarnings = warnSpy.mock.calls.filter(([msg]) =>
      msg.includes('Could not process lyrics'),
    );
    expect(lyricsWarnings).toHaveLength(1);
    expect(lyricsWarnings[0][0]).toContain('Could not process lyrics');
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('logs debug (not warn) for 404 in processLyrics', async () => {
    const mockApi = createMockApiClient();
    // 404 = no lyrics available (non-fatal, should stay debug)
    const fetchLyricsSpy = vi
      .fn()
      .mockRejectedValue(new ApiError('Failed to fetch lyrics: 404 Not Found', 404));
    mockApi.fetchLyrics = fetchLyricsSpy;

    const tracks: TrackInfo[] = [
      {
        id: 'track-1',
        name: 'Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/lib/lib/Artist/Album/track.mp3',
        format: 'mp3',
        size: 100,
      },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from('fake audio'));
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const mockFs = createMockFileSystem();
    mockFs.isDirectory = async () => true;

    const warnSpy = vi.fn();
    const debugSpy = vi.fn();
    const deps = createTestDeps({
      api: mockApi,
      fs: mockFs,
      logger: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: debugSpy },
    });
    const core = createTestSyncCore(validConfig, deps);

    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'lrc', embedMetadata: false },
    });

    expect(result.lyricsAdded).toBe(0);

    // Verify fetchLyrics was called (so we know processLyrics ran)
    expect(fetchLyricsSpy).toHaveBeenCalledOnce();

    // 404 should use debug, not warn
    const lyricsDebugs = debugSpy.mock.calls.filter(([msg]) =>
      msg.includes('Could not process lyrics'),
    );
    expect(lyricsDebugs).toHaveLength(1);
    expect(lyricsDebugs[0][0]).toContain('Could not process lyrics');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
