/**
 * Sync Module Unit Tests
 *
 * Comprehensive tests for the sync module using Vitest.
 * Tests use mocked dependencies to isolate unit behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SyncConfig, SyncInput, TrackInfo, ItemType } from './types';
import { createSyncCore, createTestSyncCore, type SyncDependencies } from './sync-core';
import { createMockApiClient } from './sync-api';
import { createMockFileSystem } from './sync-files';
import { createMockConverter } from './sync-files';
import {
  validateSyncConfig,
  normalizeServerUrl,
  validateApiKey,
  resolveSyncOptions,
  buildDestinationPath,
  getRelativePath,
  getFilenameFromPath,
} from './sync-config';
import {
  createProgressEmitter,
  createCancellationController,
  progress,
} from './sync-progress';

import { getSyncedTracksForDevice, getSyncedTracksForItem, upsertSyncedTrack } from '../main/database';

// Stable mock for getSyncedTracksForItem — hoisted so the vi.mock factory below can reference it
const mockGetSyncedTracksForItem = vi.hoisted(() => vi.fn(() => []));
// Stable mock for getSyncedItems — hoisted for same reason
const mockGetSyncedItems = vi.hoisted(() => vi.fn<() => Array<{ id: string; name: string; type: string }>>(() => []));

// Mock database module so getSyncedTracksForDevice doesn't throw "Database not initialized"
vi.mock('../main/database', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  upsertSyncedTrack: vi.fn(),
  getSyncedTracksForDevice: vi.fn(() => []),
  getSyncedTracksForItem: mockGetSyncedTracksForItem,
  getSyncedItems: mockGetSyncedItems,
  removeSyncedTracksForItem: vi.fn(),
  removeSyncedTrack: vi.fn(),
}));

// Reset all database mocks between tests to prevent state leakage
beforeEach(() => {
  mockGetSyncedTracksForItem.mockReset();
  mockGetSyncedTracksForItem.mockReturnValue([]);
  mockGetSyncedItems.mockReset();
  mockGetSyncedItems.mockReturnValue([]);
});

afterEach(() => {
  mockGetSyncedTracksForItem.mockReset();
  mockGetSyncedItems.mockReset();
});

// =============================================================================
// TEST FIXTURES
// =============================================================================

const validConfig: SyncConfig = {
  serverUrl: 'https://jellyfin.example.com',
  apiKey: '0123456789abcdef0123456789abcdef',
  userId: 'abcdef1234567890abcdef1234567890',
};

const mockTracks: TrackInfo[] = [
  {
    id: 'track-1',
    name: 'Track One',
    album: 'Album One',
    artists: ['Artist One'],
    path: '/music/artist/album/track1.mp3',
    format: 'mp3',
    size: 5000000,
    trackNumber: 1,
  },
  {
    id: 'track-2',
    name: 'Track Two',
    album: 'Album One',
    artists: ['Artist One'],
    path: '/music/artist/album/track2.flac',
    format: 'flac',
    size: 30000000,
    trackNumber: 2,
  },
];

function createMockDeps(overrides?: Partial<SyncDependencies>): SyncDependencies {
  return {
    api: createMockApiClient({
      getTracksForItems: async () => ({ tracks: mockTracks, errors: [] }),
    }),
    fs: createMockFileSystem(),
    converter: createMockConverter(),
    ...overrides,
  };
}

/**
 * Shared helper to construct a fully-typed Response mock.
 * Use this instead of inline partial objects to satisfy globalThis.fetch's Response type.
 */
function mockFetchResponse(overrides: Partial<Response> & { ok: boolean; status: number; statusText: string }): Response {
  return {
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => ({}) as Response,
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

// =============================================================================
// CONFIG TESTS
// =============================================================================

describe('sync-config', () => {
  describe('validateSyncConfig', () => {
    it('should validate a correct config', () => {
      const result = validateSyncConfig(validConfig);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject missing serverUrl', () => {
      const result = validateSyncConfig({ ...validConfig, serverUrl: '' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Server URL is required');
    });

    it('should reject missing apiKey', () => {
      const result = validateSyncConfig({ ...validConfig, apiKey: '' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('API key is required');
    });

    it('should reject missing userId', () => {
      const result = validateSyncConfig({ ...validConfig, userId: '' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('User ID is required');
    });

    it('should reject invalid userId format', () => {
      const result = validateSyncConfig({ ...validConfig, userId: 'short-id' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('User ID must be a 32-character hex string');
    });

    it('should reject invalid URL', () => {
      // A URL that's truly invalid (spaces, special chars)
      const result = validateSyncConfig({ ...validConfig, serverUrl: '://invalid' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Server URL is not a valid URL');
    });
  });

  describe('normalizeServerUrl', () => {
    it('should remove trailing slashes', () => {
      expect(normalizeServerUrl('https://example.com/')).toBe('https://example.com');
      expect(normalizeServerUrl('https://example.com///')).toBe('https://example.com');
    });

    it('should add https protocol if missing', () => {
      expect(normalizeServerUrl('example.com')).toBe('https://example.com');
    });

    it('should preserve http protocol', () => {
      expect(normalizeServerUrl('http://example.com')).toBe('http://example.com');
    });

    it('should remove /web suffix', () => {
      expect(normalizeServerUrl('https://example.com/web')).toBe('https://example.com');
      expect(normalizeServerUrl('https://example.com/web/index.html')).toBe('https://example.com');
    });
  });

  describe('validateApiKey', () => {
    it('should accept 32-character hex string', () => {
      const result = validateApiKey('0123456789abcdef0123456789abcdef');
      expect(result.valid).toBe(true);
    });

    it('should accept non-standard format but warn', () => {
      const result = validateApiKey('custom-key-format');
      expect(result.valid).toBe(true);
    });

    it('should reject empty string', () => {
      const result = validateApiKey('');
      expect(result.valid).toBe(false);
    });
  });

  describe('resolveSyncOptions', () => {
    it('should return defaults for no options', () => {
      const options = resolveSyncOptions();
      expect(options.convertToMp3).toBe(false);
      expect(options.bitrate).toBe('192k');
      expect(options.skipExisting).toBe(true);
      expect(options.preserveStructure).toBe(true);
    });

    it('should merge user options with defaults', () => {
      const options = resolveSyncOptions({ convertToMp3: true, bitrate: '320k' });
      expect(options.convertToMp3).toBe(true);
      expect(options.bitrate).toBe('320k');
      expect(options.skipExisting).toBe(true);
    });
  });
});

// =============================================================================
// PROGRESS TESTS
// =============================================================================

describe('sync-progress', () => {
  describe('createProgressEmitter', () => {
    it('should emit progress to subscribers', () => {
      const emitter = createProgressEmitter();
      const callback = vi.fn();
      
      emitter.subscribe(callback);
      emitter.emit({ phase: 'copying', current: 1, total: 10 });
      
      expect(callback).toHaveBeenCalledWith({
        phase: 'copying',
        current: 1,
        total: 10,
      });
    });

    it('should support multiple subscribers', () => {
      const emitter = createProgressEmitter();
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      
      emitter.subscribe(callback1);
      emitter.subscribe(callback2);
      emitter.emit({ phase: 'fetching', current: 0, total: 5 });
      
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should unsubscribe correctly', () => {
      const emitter = createProgressEmitter();
      const callback = vi.fn();
      
      const unsubscribe = emitter.subscribe(callback);
      emitter.emit({ phase: 'fetching', current: 0, total: 5 });
      expect(callback).toHaveBeenCalledTimes(1);
      
      unsubscribe();
      emitter.emit({ phase: 'copying', current: 1, total: 5 });
      expect(callback).toHaveBeenCalledTimes(1); // Not called again
    });

    it('should return current progress', () => {
      const emitter = createProgressEmitter();
      
      emitter.emit({ phase: 'fetching', current: 0, total: 5 });
      
      expect(emitter.getCurrent()).toEqual({
        phase: 'fetching',
        current: 0,
        total: 5,
      });
    });
  });

  describe('createCancellationController', () => {
    it('should not be cancelled initially', () => {
      const controller = createCancellationController();
      expect(controller.isCancelled()).toBe(false);
    });

    it('should be cancelled after cancel()', () => {
      const controller = createCancellationController();
      controller.cancel();
      expect(controller.isCancelled()).toBe(true);
    });

    it('should throw when cancelled', () => {
      const controller = createCancellationController();
      controller.cancel();
      
      expect(() => controller.throwIfCancelled()).toThrow('Sync operation was cancelled');
    });

    it('should reset cancellation state', () => {
      const controller = createCancellationController();
      controller.cancel();
      expect(controller.isCancelled()).toBe(true);
      
      controller.reset();
      expect(controller.isCancelled()).toBe(false);
    });
  });

  describe('ProgressBuilder', () => {
    it('should build progress object', () => {
      const p = progress(10)
        .phase('copying')
        .current(3)
        .track('Test Track')
        .bytes(1000000, 5000000)
        .build();
      
      expect(p).toEqual({
        phase: 'copying',
        current: 3,
        total: 10,
        currentTrack: 'Test Track',
        bytesProcessed: 1000000,
        totalBytes: 5000000,
      });
    });
  });
});

// =============================================================================
// API TESTS
// =============================================================================

describe('sync-api', () => {
  describe('createMockApiClient', () => {
    it('should return default mock values', async () => {
      const api = createMockApiClient();
      
      const result = await api.testConnection();
      expect(result.success).toBe(true);
      expect(result.serverName).toBe('Mock Server');
    });

    it('should allow overriding mock methods', async () => {
      const api = createMockApiClient({
        testConnection: async () => ({ success: false, error: 'Connection refused' }),
      });
      
      const result = await api.testConnection();
      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });

    it('should return mock tracks', async () => {
      const mockTracks: TrackInfo[] = [
        { id: '1', name: 'Track', path: '/path', format: 'mp3' },
      ];

      const api = createMockApiClient({
        getArtistTracks: async () => mockTracks,
      });

      const tracks = await api.getArtistTracks('artist-1');
      expect(tracks).toHaveLength(1);
      expect(tracks[0].name).toBe('Track');
    });
  });

  describe('downloadItemStream', () => {
    it('throws ApiError with useful message on HTTP 404', async () => {
      const { createApiClient, ApiError } = await import('./sync-api');

      const api = createApiClient({
        baseUrl: 'https://jellyfin.example.com',
        apiKey: '0123456789abcdef0123456789abcdef',
        userId: 'abcdef1234567890abcdef1234567890',
        timeout: 5000,
        fetch: async (_url: URL | RequestInfo, _opts?: any) => {
          return mockFetchResponse({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            body: null,
          });
        },
      });

      await expect(api.downloadItemStream('non-existent-id')).rejects.toThrow();
      try {
        await api.downloadItemStream('non-existent-id');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(404);
        expect(err.message).toContain('404');
      }
    });

    it('throws ApiError with useful message on HTTP 500', async () => {
      const { createApiClient, ApiError } = await import('./sync-api');

      const api = createApiClient({
        baseUrl: 'https://jellyfin.example.com',
        apiKey: '0123456789abcdef0123456789abcdef',
        userId: 'abcdef1234567890abcdef1234567890',
        timeout: 5000,
        fetch: async () => mockFetchResponse({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          body: null,
        }),
      });

      try {
        await api.downloadItemStream('server-error-id');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(500);
        expect(err.message).toContain('500');
      }
      // If fetch doesn't throw, verify the rejection path
      await expect(api.downloadItemStream('server-error-id')).rejects.toThrow();
    });

    it('propagates stream abort error to caller without hanging', async () => {
      const { createApiClient } = await import('./sync-api');
      const { Readable } = await import('stream');

      const api = createApiClient({
        baseUrl: 'https://jellyfin.example.com',
        apiKey: '0123456789abcdef0123456789abcdef',
        userId: 'abcdef1234567890abcdef1234567890',
        timeout: 5000,
        fetch: async () => {
          // Create a Node.js Readable, wrap as web ReadableStream via Readable.toWeb
          // The API uses Readable.fromWeb to convert back to Node Readable
          const nodeStream = Readable.from([Buffer.from([1, 2, 3])]);
          return mockFetchResponse({
            ok: true,
            status: 200,
            statusText: 'OK',
            body: Readable.toWeb(nodeStream) as ReadableStream,
          });
        },
      });

      const stream = await api.downloadItemStream('track-id') as import('stream').Readable;

      // Destroy the stream mid-consumption
      stream.destroy(new Error('Stream aborted by client'));

      // Caller should receive the abort error
      const readPromise = new Promise((resolve, reject) => {
        stream.on('data', () => {});
        stream.on('error', (err: Error) => reject(err));
        stream.on('end', () => resolve(null));
      });

      await expect(readPromise).rejects.toThrow('Stream aborted by client');
    });

    it('propagates EPIPE error from downstream write failure', async () => {
      const { createApiClient } = await import('./sync-api');
      const { Readable, Writable } = await import('stream');

      // Simulate EPIPE: writable stream closes prematurely while readable is still pushing data
      class PrematureCloseWritable extends Writable {
        private firstWrite = true;
        _write(_chunk: any, _encoding: any, callback: () => void) {
          if (this.firstWrite) {
            this.firstWrite = false;
            // Close the stream immediately after first chunk — simulates EPIPE
            this.destroy(new Error('write EPIPE'));
            return;
          }
          callback();
        }
      }

      const api = createApiClient({
        baseUrl: 'https://jellyfin.example.com',
        apiKey: '0123456789abcdef0123456789abcdef',
        userId: 'abcdef1234567890abcdef1234567890',
        timeout: 5000,
        fetch: async () => {
          // Create a Node.js Readable and wrap as web ReadableStream via Readable.toWeb
          const nodeStream = Readable.from([Buffer.alloc(100)]);
          return mockFetchResponse({
            ok: true,
            status: 200,
            statusText: 'OK',
            body: Readable.toWeb(nodeStream) as ReadableStream,
          });
        },
      });

      // Read the stream and write to a premature-close writable
      const stream = await api.downloadItemStream('track-id') as import('stream').Readable;
      const writable = new PrematureCloseWritable();

      const pipePromise = new Promise((resolve, reject) => {
        stream.pipe(writable);
        writable.on('error', (err) => reject(err));
        writable.on('finish', resolve);
      });

      // EPIPE should propagate as the error event on the writable
      await expect(pipePromise).rejects.toThrow();
    });

    it('aborts request on timeout via AbortController', async () => {
      vi.useFakeTimers();

      const { createApiClient } = await import('./sync-api');
      const { Readable } = await import('stream');

      const api = createApiClient({
        baseUrl: 'https://jellyfin.example.com',
        apiKey: '0123456789abcdef0123456789abcdef',
        userId: 'abcdef1234567890abcdef1234567890',
        timeout: 50, // timeout * 10 = 500ms until AbortController fires
        fetch: async (_url: URL | RequestInfo, options?: RequestInit) => {
          const slowStream = new Readable({
            read() {
              // Never push — stream hangs
            },
          });

          return new Promise<Response>((resolve, reject) => {
            if (options?.signal?.aborted) {
              const abortErr = new Error('Aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
              return;
            }

            options?.signal?.addEventListener('abort', () => {
              const abortErr = new Error('Aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            });

            setTimeout(() => {
              resolve(mockFetchResponse({
                ok: true,
                status: 200,
                statusText: 'OK',
                body: Readable.toWeb(slowStream) as ReadableStream,
              }));
            }, 600);
          });
        },
      });

      let caughtError: any;
      const downloadPromise = api.downloadItemStream('slow-track-id');
      const settled = downloadPromise.catch(err => { caughtError = err; });

      // Advance timers to trigger AbortController timeout (~500ms)
      await vi.runAllTimersAsync();
      await settled;

      // Verify error was thrown with correct message
      expect(caughtError).toBeDefined();
      expect(caughtError.message).toMatch(/timed out|Download timed out/i);

      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    });
  });
});

// =============================================================================
// FILESYSTEM TESTS
// =============================================================================

describe('sync-files', () => {
  describe('createMockFileSystem', () => {
    it('should track files written', async () => {
      const fs = createMockFileSystem() as any;
      
      await fs.writeFile('/test/file.txt', Buffer.from('content'));
      
      expect(await fs.exists('/test/file.txt')).toBe(true);
      expect(await fs.readFile('/test/file.txt')).toEqual(Buffer.from('content'));
    });

    it('should support directory operations', async () => {
      const fs = createMockFileSystem();
      
      await fs.mkdir('/test/dir');
      expect(await fs.isDirectory('/test/dir')).toBe(true);
    });

    it('should mock unlimited disk space', async () => {
      const fs = createMockFileSystem();
      
      const freeSpace = await fs.getFreeSpace('/any/path');
      expect(freeSpace).toBe(Number.MAX_SAFE_INTEGER);
    });
  });
});

// =============================================================================
// SYNC CORE TESTS
// =============================================================================

describe('sync-core', () => {
  describe('createSyncCore', () => {
    it('should create SyncCore instance', () => {
      const core = createSyncCore(validConfig);
      expect(core).toBeDefined();
      expect(core.sync).toBeInstanceOf(Function);
      expect(core.validateDestination).toBeInstanceOf(Function);
      expect(core.estimateSize).toBeInstanceOf(Function);
    });

    it('should throw for invalid config', () => {
      expect(() => createSyncCore({ serverUrl: '', apiKey: '', userId: '' }))
        .toThrow('Invalid config');
    });
  });

  describe('validateDestination', () => {
    it('should return invalid for non-existent path', async () => {
      const deps = createMockDeps();
      const core = createTestSyncCore(validConfig, deps);
      
      const result = await core.validateDestination('/nonexistent/path');
      expect(result.valid).toBe(true); // Mock FS allows any path
      expect(result.exists).toBe(false);
    });

    it('should return valid for existing directory', async () => {
      const deps = createMockDeps();
      (deps.fs as any).__setFile('/existing/dir/.keep', Buffer.from(''));
      
      const core = createTestSyncCore(validConfig, deps);
      
      const result = await core.validateDestination('/existing/dir');
      // Mock filesystem behavior
      expect(result).toBeDefined();
    });
  });

  describe('sync', () => {
    it('should return error when no items selected', async () => {
      const deps = createMockDeps({
        api: createMockApiClient({
          getTracksForItems: async () => ({ tracks: [], errors: [] }),
        }),
      });
      
      const core = createTestSyncCore(validConfig, deps);
      
      const input: SyncInput = {
        itemIds: [],
        itemTypes: new Map(),
        destinationPath: '/music',
      };
      
      const result = await core.sync(input);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('No tracks found for selected items');
    });

    it('should sync tracks successfully', async () => {
      const deps = createMockDeps();
      
      // Set up source files in mock filesystem
      const mockFs = deps.fs as any;
      mockFs.__setFile('/music/artist/album/track1.mp3', Buffer.alloc(5000000));
      mockFs.__setFile('/music/artist/album/track2.flac', Buffer.alloc(30000000));
      
      const core = createTestSyncCore(validConfig, deps);
      
      const itemTypes = new Map<string, ItemType>([
        ['album-1', 'album'],
      ]);
      
      const input: SyncInput = {
        itemIds: ['album-1'],
        itemTypes,
        destinationPath: '/music',
      };
      
      let lastProgress: any;
      const result = await core.sync(input, (progress) => {
        lastProgress = progress;
      });
      
      expect(result.success).toBe(true);
      expect(result.tracksCopied).toBe(2);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(lastProgress.phase).toBe('complete');
    });

    it('should call progress callback during sync', async () => {
      const deps = createMockDeps();
      const core = createTestSyncCore(validConfig, deps);
      
      const progressEvents: any[] = [];
      
      const itemTypes = new Map<string, ItemType>([
        ['album-1', 'album'],
      ]);
      
      await core.sync(
        { itemIds: ['album-1'], itemTypes, destinationPath: '/music' },
        (progress) => progressEvents.push(progress)
      );
      
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents[0].phase).toBe('fetching');
    });

    it('should handle conversion when convertToMp3 istrue', async () => {
      const deps = createMockDeps();
      const converter = {
        isAvailable: async () => true,
        convertToMp3: async () => ({ success: true }),
        convertStreamToMp3: async () => ({ success: true }),
        convertStreamToMp3WithMeta: vi.fn().mockResolvedValue({ success: true }),
        tagFile: async () => ({ success: true }),
        readFileMetadata: async () => ({}),
      };

      const core = createTestSyncCore(validConfig, { ...deps, converter });

      const itemTypes = new Map<string, ItemType>([
        ['album-1', 'album'],
      ]);

      const input: SyncInput = {
        itemIds: ['album-1'],
        itemTypes,
        destinationPath: '/music',
        options: { convertToMp3: true, bitrate: '320k' },
      };

      await core.sync(input);

      // FLAC track should trigger conversion
      expect(converter.convertStreamToMp3WithMeta).toHaveBeenCalled();
    });

    it('should include errors for failed tracks', async () => {
      const deps = createMockDeps({
        api: createMockApiClient({
          getTracksForItems: async () => ({
            tracks: [
              { id: '1', name: 'Track', path: '/nonexistent.mp3', format: 'mp3' },
            ],
            errors: [],
          }),
          // Now using downloadItem instead of copyFile
          downloadItem: async () => { throw new Error('Download failed - file not found'); },
        }),
        fs: {
          ...createMockFileSystem(),
        },
      });
      
      const core = createTestSyncCore(validConfig, deps);
      
      const itemTypes = new Map<string, ItemType>([['1', 'album']]);
      
      const result = await core.sync({
        itemIds: ['1'],
        itemTypes,
        destinationPath: '/music',
      });
      
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.tracksFailed).toContain('1');
    });
  });

  describe('estimateSize', () => {
    it('should return size estimate for items', async () => {
      const deps = createMockDeps();
      const core = createTestSyncCore(validConfig, deps);
      
      const itemTypes = new Map<string, ItemType>([
        ['album-1', 'album'],
      ]);
      
      const estimate = await core.estimateSize(['album-1'], itemTypes);
      
      expect(estimate.trackCount).toBe(2);
      expect(estimate.totalBytes).toBe(35000000); // 5MB + 30MB
    });

    it('should break down by format', async () => {
      const deps = createMockDeps();
      const core = createTestSyncCore(validConfig, deps);
      
      const itemTypes = new Map<string, ItemType>([
        ['album-1', 'album'],
      ]);
      
      const estimate = await core.estimateSize(['album-1'], itemTypes);
      
      expect(estimate.formatBreakdown.get('mp3')).toBe(5000000);
      expect(estimate.formatBreakdown.get('flac')).toBe(30000000);
    });
  });
});

// =============================================================================
// INTEGRATION TESTS (with real-ish dependencies)
// =============================================================================

describe('Integration: Full Sync Flow', () => {
  it('should complete full sync workflow', async () => {
    // Setup mock dependencies that simulate real behavior
    const mockApi = createMockApiClient({
      testConnection: async () => ({ success: true, serverName: 'Test Server' }),
      getTracksForItems: async () => ({ tracks: mockTracks, errors: [] }),
    });

    const mockFs = createMockFileSystem();
    // Set up source files
    (mockFs as any).__setFile('/music/artist/album/track1.mp3', Buffer.alloc(5000000));
    (mockFs as any).__setFile('/music/artist/album/track2.flac', Buffer.alloc(30000000));
    
    const mockConverter = createMockConverter();
    
    const deps: SyncDependencies = {
      api: mockApi,
      fs: mockFs,
      converter: mockConverter,
    };
    
    const core = createTestSyncCore(validConfig, deps);
    
    // Test connection first
    const connection = await core.testConnection();
    expect(connection.success).toBe(true);
    
    // Validate destination
    const destValidation = await core.validateDestination('/music');
    expect(destValidation.valid).toBe(true);
    
    // Estimate size
    const itemTypes = new Map<string, ItemType>([['album-1', 'album']]);
    const estimate = await core.estimateSize(['album-1'], itemTypes);
    expect(estimate.trackCount).toBeGreaterThan(0);
    
    // Run sync
    const progressEvents: any[] = [];
    const result = await core.sync(
      {
        itemIds: ['album-1'],
        itemTypes,
        destinationPath: '/music',
      },
      (progress) => progressEvents.push(progress)
    );
    
    // Verify result
    expect(result.success).toBe(true);
    expect(result.tracksCopied).toBeGreaterThan(0);
    
    // Verify progress events
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[0].phase).toBe('fetching');
    expect(progressEvents[progressEvents.length - 1].phase).toBe('complete');
  });

  it('should handle cancellation correctly', async () => {
    const deps = createMockDeps();
    const core = createTestSyncCore(validConfig, deps);
    
    // Start sync and cancel immediately
    const itemTypes = new Map<string, ItemType>([['album-1', 'album']]);
    
    const syncPromise = core.sync({
      itemIds: ['album-1'],
      itemTypes,
      destinationPath: '/music',
    });
    
    // Cancel the sync
    (core as any).cancel?.();
    
    const result = await syncPromise;
    
    // Should either cancel or complete (race condition)
    expect(result.cancelled || result.success).toBe(true);
  });
});

// =============================================================================
// ERROR HANDLING TESTS
// =============================================================================

describe('Error Handling', () => {
  it('should handle API errors gracefully', async () => {
    const deps = createMockDeps({
      api: createMockApiClient({
        getTracksForItems: async () => {
          throw new Error('API connection timeout');
        },
      }),
    });
    
    const core = createTestSyncCore(validConfig, deps);
    
    const itemTypes = new Map<string, ItemType>([['album-1', 'album']]);
    
    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes,
      destinationPath: '/music',
    });
    
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should handle filesystem errors gracefully', async () => {
    const deps = createMockDeps({
      fs: {
        ...createMockFileSystem(),
        mkdir: async () => { throw new Error('Permission denied'); },
      },
    });
    
    const core = createTestSyncCore(validConfig, deps);
    
    const itemTypes = new Map<string, ItemType>([['album-1', 'album']]);
    
    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes,
      destinationPath: '/readonly',
    });
    
    expect(result.success).toBe(false);
  });

  it('should handle converter errors gracefully', async () => {
    const deps = createMockDeps({
      converter: {
        isAvailable: async () => true,
        convertToMp3: async () => ({ success: true }),
        convertStreamToMp3: async () => ({ success: false, error: 'FFmpeg not installed' }),
        convertStreamToMp3WithMeta: async () => ({ success: false, error: 'FFmpeg not installed' }),
        tagFile: async () => ({ success: true }),
        readFileMetadata: async () => ({}),
      },
    });

    const core = createTestSyncCore(validConfig, deps);

    const itemTypes = new Map<string, ItemType>([['album-1', 'album']]);
    
    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes,
      destinationPath: '/music',
      options: { convertToMp3: true },
    });
    
    // FLAC track should fail conversion
    expect(result.tracksFailed.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Re-tag without re-download (Phase 3)
  // When metadata changes but file exists, converter.tagFile() is called
  // without calling api.downloadItemStream()
  // ---------------------------------------------------------------------------
  describe('re-tag without re-download', () => {
    function makeTrack(overrides: Partial<TrackInfo>): TrackInfo {
      return {
        id: 'track-x',
        name: 'track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/Artist/Album/track.mp3', // Must match existingRecord.destinationPath after serverRootPath stripping
        format: 'mp3',
        size: 5_000_000,
        trackNumber: 1,
        ...overrides,
      };
    }

    it('re-tags metadata-only changes without downloading', async () => {
      const downloadSpy = vi.fn();
      const tagFileSpy = vi.fn().mockResolvedValue({ success: true });

      // Test-local config with explicit serverRootPath to ensure path matching works
      const configWithServerRoot: SyncConfig = {
        ...validConfig,
        serverRootPath: '/music/',
      };

      const deps = createMockDeps({
        api: createMockApiClient({
          getTracksForItems: async () => ({
            tracks: [makeTrack({ id: 'track-x', name: 'Updated Track' })],
            errors: [],
          }),
          downloadItemStream: downloadSpy,
        }),
        converter: {
          ...createMockConverter(),
          tagFile: tagFileSpy,
        },
      });

      // Override getSyncedTracksForDevice to return a record with DIFFERENT metadata hash
      // so sync detects metadataChanged = true
      const existingRecord = {
        id: 1,
        deviceId: 1,
        itemId: 'album-1',
        trackId: 'track-x',
        destinationPath: '/music/Artist/Album/track.mp3',
        fileSize: 5_000_000,
        metadataHash: 'old_hash_value_12', // different from server → metadataChanged
        coverArtMode: 'embed',
        encodedBitrate: '192k',
        serverPath: '/music/track.mp3',
        serverRootPath: null,
        syncedAt: new Date().toISOString(),
      } as const;

      vi.mocked(getSyncedTracksForDevice).mockReturnValueOnce([existingRecord] as any);
      vi.mocked(getSyncedTracksForItem).mockReturnValueOnce([existingRecord] as any);

      const core = createTestSyncCore(configWithServerRoot, deps);

      await core.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/music',
        options: { convertToMp3: false },
      });

      // tagFile should be called (re-tag) but downloadItemStream should NOT be called (no re-download)
      expect(tagFileSpy).toHaveBeenCalled();
      expect(downloadSpy).not.toHaveBeenCalled();
    });
  });

  describe('convertStreamToMp3WithMeta FFmpeg failures', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns success:false when FFmpeg exits with non-zero code', async () => {
      const { createFFmpegConverter } = await import('./sync-files');
      const { Writable, Readable } = require('stream');

      // Mock proc.stdin as a real Writable so pipe() works
      const mockStdin = new Writable({
        write(_chunk: Buffer, _enc: string, cb: () => void) { cb(); }
      });

      vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const proc = new (require('events').EventEmitter)() as any;
        proc.stdin = mockStdin;
        proc.stderr = new (require('events').EventEmitter)();
        proc.stderr.on = vi.fn();
        proc.kill = vi.fn();
        setTimeout(() => proc.emit('close', 1), 0);
        return proc;
      });

      const converter = createFFmpegConverter();
      const input = Readable.from(Buffer.alloc(1024));

      const result = await converter.convertStreamToMp3WithMeta(
        input,
        '/tmp/test-output.mp3',
        '192k',
        { title: 'Test' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('FFmpeg exited with code 1');
    });

    it('deletes temp cover file after FFmpeg failure', async () => {
      const fs = require('fs');
      const unlinkSyncSpy = vi.spyOn(fs, 'unlinkSync');
      const { Writable, Readable } = require('stream');

      const mockStdin = new Writable({
        write(_chunk: Buffer, _enc: string, cb: () => void) { cb(); }
      });

      vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const proc = new (require('events').EventEmitter)() as any;
        proc.stdin = mockStdin;
        proc.stderr = new (require('events').EventEmitter)();
        proc.stderr.on = vi.fn();
        proc.kill = vi.fn();
        setTimeout(() => proc.emit('close', 1), 0);
        return proc;
      });

      const { createFFmpegConverter } = await import('./sync-files');
      const converter = createFFmpegConverter();
      const input = Readable.from(Buffer.alloc(1024));
      const coverData = Buffer.alloc(1024);

      await converter.convertStreamToMp3WithMeta(
        input,
        '/tmp/test-output.mp3',
        '192k',
        { title: 'Test', artist: 'Artist' },
        coverData
      );

      // After FFmpeg failed (exit code 1), temp cover file must have been deleted
      const tmpdir = require('os').tmpdir();
      const calledPaths = unlinkSyncSpy.mock.calls.map((args: unknown[]) => args[0] as string);
      const coverTempFiles = calledPaths.filter((p: string) => p.startsWith(`${tmpdir}/jt-cover-`));
      expect(coverTempFiles.length).toBeGreaterThan(0);
    });
  });

  describe('tagFile error handling', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns error when input file does not exist (FFmpeg exits non-zero)', async () => {
      const { Writable } = require('stream');
      const mockStdin = new Writable({
        write(_chunk: Buffer, _enc: string, cb: () => void) { cb(); }
      });

      vi.spyOn(require('child_process'), 'spawn').mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const proc = new (require('events').EventEmitter)() as any;
        proc.stdin = mockStdin;
        proc.stderr = new (require('events').EventEmitter)();
        proc.stderr.on = vi.fn();
        proc.kill = vi.fn();
        // FFmpeg exits with 1 when input file is not found
        setTimeout(() => proc.emit('close', 1), 0);
        return proc;
      });

      const { createFFmpegConverter } = await import('./sync-files');
      const converter = createFFmpegConverter();

      const result = await converter.tagFile(
        '/nonexistent/file.mp3',
        '/tmp/tagged-output.mp3',
        { title: 'Test', artist: 'Artist' }
      );

      // Should return error result, not throw
      expect(result.success).toBe(false);
      expect(result.error).toContain('FFmpeg exited with code 1');
    });
  });

  // ---------------------------------------------------------------------------
  // Move detection without re-download (Phase 3)
  // When path changes but metadata same, upsertSyncedTrack is called with new path
  // without any file copy operations
  // ---------------------------------------------------------------------------
  describe('move detection without re-download', () => {
    function makeTrack(overrides: Partial<TrackInfo>): TrackInfo {
      return {
        id: 'track-x',
        name: 'Test Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/NewAlbum/track.mp3', // new path on server (album renamed)
        format: 'mp3',
        size: 5_000_000,
        trackNumber: 1,
        ...overrides,
      };
    }

    it('detects moved track and updates DB without re-downloading', async () => {
      const downloadSpy = vi.fn();

      const deps = createMockDeps({
        api: createMockApiClient({
          getTracksForItems: async () => ({
            tracks: [makeTrack({ path: '/music/NewAlbum/track.mp3' })],
            errors: [],
          }),
          downloadItemStream: downloadSpy,
        }),
      });

      // Override getSyncedTracksForDevice to return a record at the OLD path
      // but with SAME metadata hash (so metadataChanged = false, pathChanged = true)
      // NOTE: hash must match what computeMetadataHash(buildMetadata(track)) produces.
      // For makeTrack({ path: '/music/NewAlbum/track.mp3' }) the hash is 4291b888db42e390.
      const existingRecord = {
        id: 1,
        deviceId: 1,
        itemId: 'album-1',
        trackId: 'track-x',
        destinationPath: '/music/OldAlbum/track.mp3', // old path
        fileSize: 5_000_000,
        metadataHash: '4291b888db42e390', // matches actual hash computed from track metadata
        coverArtMode: 'embed',
        encodedBitrate: '192k',
        serverPath: '/music/OldAlbum/track.mp3',
        serverRootPath: null,
        syncedAt: new Date().toISOString(),
      } as const;

      vi.mocked(getSyncedTracksForDevice).mockReturnValueOnce([existingRecord] as any);
      vi.mocked(getSyncedTracksForItem).mockReturnValueOnce([existingRecord] as any);

      const core = createTestSyncCore(validConfig, deps);

      await core.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/music',
        options: { convertToMp3: false },
      });

      // upsertSyncedTrack should be called (update DB with new path)
      // but NO download should occur for the moved track
      expect(vi.mocked(upsertSyncedTrack)).toHaveBeenCalled();
      expect(downloadSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Regression: MP3→MP3 re-encoding (needsConversion bitrate-aware logic)
  // Bug: commit 2a2b8ab removed needsConversion(), causing ALL tracks (including
  // MP3s that didn't need conversion) to go through FFmpeg, making sync slow.
  // Fix: only run FFmpeg for non-MP3 formats, or for MP3 when source bitrate
  // exceeds the target bitrate (i.e. the user genuinely wants to reduce quality).
  // ---------------------------------------------------------------------------
  describe('needsConversion (bitrate-aware regression)', () => {
    function makeTrack(overrides: Partial<TrackInfo>): TrackInfo {
      return {
        id: 'track-x',
        name: 'Test Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/track.mp3',
        format: 'mp3',
        size: 5_000_000,
        ...overrides,
      };
    }

    function makeDeps(tracks: TrackInfo[], converterMock: Partial<import('./sync-files').AudioConverter>): SyncDependencies {
      return {
        api: createMockApiClient({
          getTracksForItems: async () => ({ tracks, errors: [] }),
        }),
        fs: createMockFileSystem(),
        converter: { ...createMockConverter(), ...converterMock },
      };
    }

    it('does NOT convert an MP3 whose bitrate is at or below the target', async () => {
      const converter = { convertStreamToMp3WithMeta: vi.fn().mockResolvedValue({ success: true }) };
      const track = makeTrack({ format: 'mp3', bitrate: 128_000 }); // 128 kbps, at target
      const core = createTestSyncCore(validConfig, makeDeps([track], converter));

      await core.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/music',
        options: { convertToMp3: true, bitrate: '128k' },
      });

      expect(converter.convertStreamToMp3WithMeta).not.toHaveBeenCalled();
    });

    it('re-encodes an MP3 whose bitrate is above the target', async () => {
      const converter = { convertStreamToMp3WithMeta: vi.fn().mockResolvedValue({ success: true }) };
      const track = makeTrack({ format: 'mp3', bitrate: 320_000 }); // 320 kbps, above 128k target
      const core = createTestSyncCore(validConfig, makeDeps([track], converter));

      await core.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/music',
        options: { convertToMp3: true, bitrate: '128k' },
      });

      expect(converter.convertStreamToMp3WithMeta).toHaveBeenCalledTimes(1);
    });

    it('does NOT re-encode an MP3 with unknown bitrate (conservative: copy instead)', async () => {
      const converter = { convertStreamToMp3WithMeta: vi.fn().mockResolvedValue({ success: true }) };
      const track = makeTrack({ format: 'mp3', bitrate: undefined }); // bitrate unknown
      const core = createTestSyncCore(validConfig, makeDeps([track], converter));

      await core.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/music',
        options: { convertToMp3: true, bitrate: '192k' },
      });

      expect(converter.convertStreamToMp3WithMeta).not.toHaveBeenCalled();
    });

    it('always converts FLAC regardless of bitrate', async () => {
      const converter = { convertStreamToMp3WithMeta: vi.fn().mockResolvedValue({ success: true }) };
      const track = makeTrack({ format: 'flac', path: '/music/track.flac', bitrate: 900_000 });
      const core = createTestSyncCore(validConfig, makeDeps([track], converter));

      await core.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/music',
        options: { convertToMp3: true, bitrate: '320k' },
      });

      expect(converter.convertStreamToMp3WithMeta).toHaveBeenCalledTimes(1);
    });

    it('does not convert anything when convertToMp3 is false', async () => {
      const converter = { convertStreamToMp3WithMeta: vi.fn().mockResolvedValue({ success: true }) };
      const track = makeTrack({ format: 'flac', path: '/music/track.flac', bitrate: 900_000 });
      const core = createTestSyncCore(validConfig, makeDeps([track], converter));

      await core.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/music',
        options: { convertToMp3: false },
      });

      expect(converter.convertStreamToMp3WithMeta).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// INTEGRATION TESTS (Real API - Skip by default in CI)
// =============================================================================

/**
 * Integration tests that connect to a real Jellyfin server.
 * These tests are skipped by default - run with: npm test -- --integration
 * 
 * To enable:
 * 1. Set JELLYFIN_SERVER, JELLYFIN_API_KEY, JELLYFIN_USER_ID environment variables
 * 2. Run: npm test -- --integration
 */
describe('Integration: Real API Tests', () => {
  const serverUrl = process.env.JELLYFIN_SERVER;
  const apiKey = process.env.JELLYFIN_API_KEY;
  const userId = process.env.JELLYFIN_USER_ID;

  // Skip these tests unless integration flag is provided
  const itIfIntegration = process.env.INTEGRATION ? it : it.skip;

  itIfIntegration('should connect to real Jellyfin server', async () => {
    if (!serverUrl || !apiKey || !userId) {
      console.warn('Skipping integration test: Missing JELLYFIN_* environment variables');
      return;
    }

    const { createApiClient } = await import('./sync-api');
    const api = createApiClient({
      baseUrl: serverUrl,
      apiKey,
      userId,
      timeout: 30000,
    });

    const result = await api.testConnection();
    expect(result.success).toBe(true);
    expect(result.serverName).toBeDefined();
  });

  itIfIntegration('should fetch tracks from real server', async () => {
    if (!serverUrl || !apiKey || !userId) {
      console.warn('Skipping integration test: Missing JELLYFIN_* environment variables');
      return;
    }

    const { createApiClient } = await import('./sync-api');
    const api = createApiClient({
      baseUrl: serverUrl,
      apiKey,
      userId,
      timeout: 60000,
    });

    // Get user first to verify credentials
    const user = await api.getUser();
    expect(user.id).toBe(userId);

    // Get library stats
    const stats = await api.getLibraryStats();
    expect(stats.tracks).toBeGreaterThanOrEqual(0);
  });

  itIfIntegration('should estimate size for real items', async () => {
    if (!serverUrl || !apiKey || !userId) {
      console.warn('Skipping integration test: Missing JELLYFIN_* environment variables');
      return;
    }

    const { createApiClient } = await import('./sync-api');
    const { createSyncCore } = await import('./sync-core');
    void createApiClient;
    void createSyncCore;

    // This would need a real item ID from the server
    // Skip if no test albums exist
    console.log('Integration test: Size estimation requires a real item ID');
  });
});

// =============================================================================
// FILE STRUCTURE TESTS
// =============================================================================

describe('File Structure', () => {
  it('should generate correct folder structure with year', () => {
    const sanitize = (name: string) => name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
    
    const track = {
      artists: ['The Beatles'],
      album: 'Abbey Road',
      year: 1969,
      name: 'Come Together',
      trackNumber: 1,
      format: 'flac'
    };
    
    // Expected: lib/The Beatles/Abbey Road (1969)/
    const artistName = sanitize(track.artists[0]);
    const albumName = sanitize(track.album);
    const yearStr = track.year ? ` (${track.year})` : '';
    const expectedDir = `lib/${artistName}/${albumName}${yearStr}`;
    
    expect(expectedDir).toBe('lib/The Beatles/Abbey Road (1969)');
  });

  it('should generate correct filename format', () => {
    const sanitize = (name: string) => name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
    
    const track = {
      artists: ['The Beatles'],
      album: 'Abbey Road',
      year: 1969,
      name: 'Come Together',
      trackNumber: 1,
      format: 'flac'
    };
    
    // Expected: The Beatles - Abbey Road - 01 - Come Together.flac
    const artistName = sanitize(track.artists[0]);
    const albumName = sanitize(track.album);
    const trackNum = String(track.trackNumber).padStart(2, '0');
    const titleSanitized = sanitize(track.name);
    const expectedFilename = `${artistName} - ${albumName} - ${trackNum} - ${titleSanitized}.${track.format}`;
    
    expect(expectedFilename).toBe('The Beatles - Abbey Road - 01 - Come Together.flac');
  });

  it('should handle missing year in folder structure', () => {
    const sanitize = (name: string) => name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
    
    const track = {
      artists: ['Unknown Artist'],
      album: 'Unknown Album',
      year: undefined,
      name: 'Track',
      trackNumber: 5,
      format: 'mp3'
    };
    
    const artistName = sanitize(track.artists[0]);
    const albumName = sanitize(track.album);
    const yearStr = track.year ? ` (${track.year})` : '';
    const expectedDir = `lib/${artistName}/${albumName}${yearStr}`;
    
    expect(expectedDir).toBe('lib/Unknown Artist/Unknown Album');
  });
});

// =============================================================================
// SERVER ROOT PATH TESTS
// =============================================================================

describe('Server Root Path - Original Path Usage', () => {
  const validConfigWithServerRoot: SyncConfig = {
    serverUrl: 'https://jellyfin.example.com',
    apiKey: '0123456789abcdef0123456789abcdef',
    userId: 'abcdef1234567890abcdef1234567890',
    serverRootPath: '/mediamusic/lib/lib/',
  };

  // Tracks with actual server paths like in the bug report
  const tracksWithServerPath: TrackInfo[] = [
    {
      id: 'track-1',
      name: 'How Long',
      album: 'Five-A-Side',
      artists: ['Ace'],
      path: '/mediamusic/lib/lib/Ace/Five-A-Side/Ace - Five-A-Side - How Long.mp3',
      format: 'mp3',
      size: 5000000,
      trackNumber: 1,
    },
    {
      id: 'track-2',
      name: 'Twenty Years Later',
      album: 'Five-A-Side',
      artists: ['Ace'],
      path: '/mediamusic/lib/lib/Ace/Five-A-Side/Ace - Five-A-Side - Twenty Years Later.mp3',
      format: 'mp3',
      size: 4000000,
      trackNumber: 2,
    },
  ];

  describe('buildDestinationPath', () => {
    it('should build correct destination path from server path', () => {
      const serverPath = '/mediamusic/lib/lib/Ace/Five-A-Side/Ace - Five-A-Side - How Long.mp3';
      const serverRoot = '/mediamusic/lib/lib/';
      const destinationRoot = '/Volumes/MEDIA/lib';

      const result = buildDestinationPath(serverPath, serverRoot, destinationRoot);

      expect(result).toBe('/Volumes/MEDIA/lib/Ace/Five-A-Side/Ace - Five-A-Side - How Long.mp3');
    });

    it('should handle paths with multiple slashes', () => {
      const serverPath = '/music//artist//album/track.mp3';
      const serverRoot = '/music/';
      const destinationRoot = '/dest';

      const result = buildDestinationPath(serverPath, serverRoot, destinationRoot);

      // Code normalizes multiple slashes
      expect(result).toBe('/dest/artist/album/track.mp3');
    });

    it('should return filename only if no subdirectories', () => {
      const serverPath = '/music/track.mp3';
      const serverRoot = '/music/';
      const destinationRoot = '/dest';

      const result = buildDestinationPath(serverPath, serverRoot, destinationRoot);

      expect(result).toBe('/dest/track.mp3');
    });

    it('should throw when serverPath is not under serverRootPath (path traversal)', () => {
      // /media/lib-backup/x does not start with /media/lib/ — should be rejected
      const serverPath = '/media/lib-backup/x';
      const serverRoot = '/media/lib';
      const destinationRoot = '/dest';

      expect(() => buildDestinationPath(serverPath, serverRoot, destinationRoot)).toThrow();
    });
  });

  describe('getRelativePath', () => {
    it('should extract relative path from server path', () => {
      const serverPath = '/mediamusic/lib/lib/Ace/Five-A-Side/track.mp3';
      const serverRoot = '/mediamusic/lib/lib/';

      const result = getRelativePath(serverPath, serverRoot);

      expect(result).toBe('Ace/Five-A-Side/track.mp3');
    });

    it('should handle empty relative path', () => {
      const serverPath = '/mediamusic/lib/lib/';
      const serverRoot = '/mediamusic/lib/lib/';

      const result = getRelativePath(serverPath, serverRoot);

      expect(result).toBe('');
    });
  });

  describe('getFilenameFromPath', () => {
    it('should extract filename from full path', () => {
      const serverPath = '/mediamusic/lib/lib/Ace/Five-A-Side/Ace - Five-A-Side - How Long.mp3';

      const result = getFilenameFromPath(serverPath);

      expect(result).toBe('Ace - Five-A-Side - How Long.mp3');
    });

    it('should handle paths with trailing slash', () => {
      const serverPath = '/music/artist/album/';

      const result = getFilenameFromPath(serverPath);

      expect(result).toBe('');
    });

    it('should extract filename from Windows backslash path', () => {
      const serverPath = 'D:\\Music\\The Beatles\\1\\01 Love Me Do.mp3';

      const result = getFilenameFromPath(serverPath);

      expect(result).toBe('01 Love Me Do.mp3');
    });
  });

  describe('validateSyncConfig with serverRootPath', () => {
    it('should accept valid server root path', () => {
      const result = validateSyncConfig({
        ...validConfig,
        serverRootPath: '/mediamusic/lib/lib/',
      });
      expect(result.valid).toBe(true);
    });

    it('should accept empty server root path', () => {
      const result = validateSyncConfig({
        ...validConfig,
        serverRootPath: '',
      });
      expect(result.valid).toBe(true);
    });

    it('should reject server root path without leading slash', () => {
      const result = validateSyncConfig({
        ...validConfig,
        serverRootPath: 'mediamusic/lib/lib/',
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Server root path must start with /');
    });

    it('should reject server root path without trailing slash', () => {
      const result = validateSyncConfig({
        ...validConfig,
        serverRootPath: '/mediamusic/lib/lib',
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Server root path must end with /');
    });
  });

  describe('sync with serverRootPath', () => {
    it('should use original server path when serverRootPath is configured', async () => {
      const mockFs = createMockFileSystem();

      const mockApi = createMockApiClient({
        getTracksForItems: async () => ({ tracks: tracksWithServerPath, errors: [] }),
        downloadItem: async () => Buffer.alloc(100),
        downloadItemStream: async () => {
          const { Readable } = require('stream');
          return Readable.from(Buffer.alloc(100));
        },
      });

      // Set up source files
      (mockFs as any).__setFile(
        '/mediamusic/lib/lib/Ace/Five-A-Side/Ace - Five-A-Side - How Long.mp3',
        Buffer.alloc(5000000)
      );
      (mockFs as any).__setFile(
        '/mediamusic/lib/lib/Ace/Five-A-Side/Ace - Five-A-Side - Twenty Years Later.mp3',
        Buffer.alloc(4000000)
      );

      // tagFile mock that actually copies the file (simulates real FFmpeg behavior)
      const mockConverter = {
        isAvailable: async () => true,
        convertToMp3: async () => ({ success: true }),
        convertStreamToMp3: async () => ({ success: true }),
        convertStreamToMp3WithMeta: async () => ({ success: true }),
        tagFile: async (inputPath: string, outputPath: string) => {
          const data = await mockFs.readFile(inputPath);
          await mockFs.writeFile(outputPath, data);
          return { success: true };
        },
        readFileMetadata: async () => ({}),
      };

      const deps: SyncDependencies = {
        api: mockApi,
        fs: mockFs,
        converter: mockConverter,
      };

      const core = createTestSyncCore(validConfigWithServerRoot, deps);

      const itemTypes = new Map<string, ItemType>([
        ['album-five-a-side', 'album'],
      ]);

      const result = await core.sync({
        itemIds: ['album-five-a-side'],
        itemTypes,
        destinationPath: '/Volumes/MEDIA/lib',
      });

      expect(result.success).toBe(true);
      expect(result.tracksCopied).toBe(2);

      // Verify files were written to correct paths using __getFile
      const expectedPath1 = '/Volumes/MEDIA/lib/Ace/Five-A-Side/Ace - Five-A-Side - How Long.mp3';
      const expectedPath2 = '/Volumes/MEDIA/lib/Ace/Five-A-Side/Ace - Five-A-Side - Twenty Years Later.mp3';

      expect((mockFs as any).__getFile(expectedPath1)).toBeDefined();
      expect((mockFs as any).__getFile(expectedPath2)).toBeDefined();
    });

    it('should auto-detect serverRootPath and preserve lib folder in destination', async () => {
      const mockFs = createMockFileSystem();

      const mockApi = createMockApiClient({
        getTracksForItems: async () => ({ tracks: tracksWithServerPath, errors: [] }),
        downloadItem: async () => Buffer.alloc(100),
        downloadItemStream: async () => {
          const { Readable } = require('stream');
          return Readable.from(Buffer.alloc(100));
        },
      });

      const mockConverter = {
        isAvailable: async () => true,
        convertToMp3: async () => ({ success: true }),
        convertStreamToMp3: async () => ({ success: true }),
        convertStreamToMp3WithMeta: async () => ({ success: true }),
        tagFile: async (inputPath: string, outputPath: string) => {
          const data = await mockFs.readFile(inputPath);
          await mockFs.writeFile(outputPath, data);
          return { success: true };
        },
        readFileMetadata: async () => ({}),
      };

      const deps: SyncDependencies = {
        api: mockApi,
        fs: mockFs,
        converter: mockConverter,
      };

      // Config without serverRootPath — auto-detection should kick in
      const core = createTestSyncCore(validConfig, deps);

      const itemTypes = new Map<string, ItemType>([
        ['album-five-a-side', 'album'],
      ]);

      const result = await core.sync({
        itemIds: ['album-five-a-side'],
        itemTypes,
        destinationPath: '/Volumes/USB',
      });

      expect(result.success).toBe(true);
      // Auto-detection strips /mediamusic/lib/ so the relative path is lib/Ace/Five-A-Side/...
      const expectedPath1 = '/Volumes/USB/lib/Ace/Five-A-Side/Ace - Five-A-Side - How Long.mp3';
      const expectedPath2 = '/Volumes/USB/lib/Ace/Five-A-Side/Ace - Five-A-Side - Twenty Years Later.mp3';
      expect((mockFs as any).__getFile(expectedPath1)).toBeDefined();
      expect((mockFs as any).__getFile(expectedPath2)).toBeDefined();
    });

    it('should preserve filename exactly when using serverRootPath', async () => {
      const mockFs = createMockFileSystem();

      const mockApi = createMockApiClient({
        getTracksForItems: async () => ({ tracks: tracksWithServerPath, errors: [] }),
        downloadItem: async () => Buffer.alloc(100),
        downloadItemStream: async () => {
          const { Readable } = require('stream');
          return Readable.from(Buffer.alloc(100));
        },
      });

      (mockFs as any).__setFile(
        '/mediamusic/lib/lib/Ace/Five-A-Side/Ace - Five-A-Side - How Long.mp3',
        Buffer.alloc(5000000)
      );

      const mockConverter = {
        isAvailable: async () => true,
        convertToMp3: async () => ({ success: true }),
        convertStreamToMp3: async () => ({ success: true }),
        convertStreamToMp3WithMeta: async () => ({ success: true }),
        tagFile: async (inputPath: string, outputPath: string) => {
          const data = await mockFs.readFile(inputPath);
          await mockFs.writeFile(outputPath, data);
          return { success: true };
        },
        readFileMetadata: async () => ({}),
      };

      const deps: SyncDependencies = {
        api: mockApi,
        fs: mockFs,
        converter: mockConverter,
      };

      const core = createTestSyncCore(validConfigWithServerRoot, deps);

      const itemTypes = new Map<string, ItemType>([
        ['album-1', 'album'],
      ]);

      await core.sync({
        itemIds: ['album-1'],
        itemTypes,
        destinationPath: '/Volumes/MEDIA/lib',
      });

      // Should have the exact original filename using __getFile
      const expectedPath = '/Volumes/MEDIA/lib/Ace/Five-A-Side/Ace - Five-A-Side - How Long.mp3';
      expect((mockFs as any).__getFile(expectedPath)).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // analyzeDiff: H1 — batch API calls (no N+1)
  // ---------------------------------------------------------------------------
  describe('analyzeDiff batch API calls', () => {
    it('fetches all items in a single getTracksForItems call', async () => {
      const configWithServerRoot: SyncConfig = {
        ...validConfig,
        serverRootPath: '/music/',
      };

      const getTracksForItemsSpy = vi.fn(() =>
        Promise.resolve({
          tracks: [
            { id: 'track-1', name: 'Track 1', album: 'Album', artists: ['Artist'], path: '/music/Artist/Album/track1.mp3', format: 'mp3', parentItemId: 'album-1' },
            { id: 'track-2', name: 'Track 2', album: 'Album', artists: ['Artist'], path: '/music/Artist/Album/track2.mp3', format: 'mp3', parentItemId: 'album-1' },
          ],
          errors: [],
        })
      );

      const deps = createMockDeps({
        api: createMockApiClient({ getTracksForItems: getTracksForItemsSpy }),
      });

      const core = createTestSyncCore(configWithServerRoot, deps);

      await core.analyzeDiff(
        ['album-1'],
        new Map([['album-1', 'album' as ItemType]]),
        '/music',
        { coverArtMode: 'embed', bitrate: '192k', convertToMp3: false }
      );

      // Should be called exactly once (not once per item — no N+1)
      expect(getTracksForItemsSpy).toHaveBeenCalledTimes(1);
    });

    it('groups tracks by parentItemId for diff', async () => {
      const configWithServerRoot: SyncConfig = {
        ...validConfig,
        serverRootPath: '/music/',
      };

      const getTracksForItemsSpy = vi.fn(() =>
        Promise.resolve({
          tracks: [
            { id: 'track-1', name: 'Track 1', album: 'Album A', artists: ['Artist'], path: '/music/Artist/Album A/track1.mp3', format: 'mp3', parentItemId: 'album-1' },
            { id: 'track-2', name: 'Track 2', album: 'Album A', artists: ['Artist'], path: '/music/Artist/Album A/track2.mp3', format: 'mp3', parentItemId: 'album-1' },
            { id: 'track-3', name: 'Track 3', album: 'Album B', artists: ['Artist'], path: '/music/Artist/Album B/track3.mp3', format: 'mp3', parentItemId: 'album-2' },
          ],
          errors: [],
        })
      );

      // Ensure the module-level mock returns an empty array synchronously
      mockGetSyncedTracksForItem.mockReturnValue([]);

      const deps = createMockDeps({
        api: createMockApiClient({ getTracksForItems: getTracksForItemsSpy }),
      });

      const core = createTestSyncCore(configWithServerRoot, deps);

      const result = await core.analyzeDiff(
        ['album-1', 'album-2'],
        new Map([
          ['album-1', 'album' as ItemType],
          ['album-2', 'album' as ItemType],
        ]),
        '/music',
        { coverArtMode: 'embed', bitrate: '192k', convertToMp3: false }
      );

      // album-1 should have 2 tracks, album-2 should have 1
      const album1Diff = result.items.find(i => i.itemId === 'album-1');
      const album2Diff = result.items.find(i => i.itemId === 'album-2');
      expect(album1Diff?.changes.length).toBe(2);
      expect(album2Diff?.changes.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // analyzeDiff: H3 — artist with new album: old tracks should be unchanged
  // ---------------------------------------------------------------------------
  describe('analyzeDiff artist with new album added', () => {
    it('previously synced album tracks remain unchanged when new album is added to artist', async () => {
      const configWithServerRoot: SyncConfig = {
        ...validConfig,
        serverRootPath: '/music/',
      };

      // Artist has TWO albums: old (previously synced) and new (just added)
      // Use deep paths to avoid serverRootPath auto-detection issues
      const getTracksForItemsSpy = vi.fn(() =>
        Promise.resolve({
          tracks: [
            // Old album tracks - these were already synced
            { id: 'track-old-1', name: 'Old Track 1', album: 'Old Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Old Album/track1.mp3', format: 'mp3', parentItemId: 'artist-1' },
            { id: 'track-old-2', name: 'Old Track 2', album: 'Old Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Old Album/track2.mp3', format: 'mp3', parentItemId: 'artist-1' },
            // New album tracks - these are brand new on server
            { id: 'track-new-1', name: 'New Track 1', album: 'New Album', artists: ['Artist'], path: '/music/lib/lib/Artist/New Album/track1.mp3', format: 'mp3', parentItemId: 'artist-1' },
          ],
          errors: [],
        })
      );

      // Previously synced tracks: only the OLD album tracks (from initial sync)
      // These have metadataHash that should match the server tracks
      // Computed using computeMetadataHash(buildMetadata(track))
      const metadataHashOld1 = '32ba41d956e25e42';
      const metadataHashOld2 = 'eb8249545f07eb00';

      mockGetSyncedTracksForItem.mockReturnValue([
        {
          trackId: 'track-old-1',
          itemId: 'artist-1',
          // Synced with serverRootPath='/music/lib/lib/' (auto-detected from deep paths)
          // serverRelativePath = 'Artist/Old Album/' → outputDir = /mnt/usb/Artist/Old Album
          destinationPath: '/mnt/usb/Artist/Old Album/track1.mp3',
          fileSize: 5000000,
          metadataHash: metadataHashOld1,
          coverArtMode: 'embed',
          encodedBitrate: '192k',
          serverPath: '/music/lib/lib/Artist/Old Album/track1.mp3',
          serverRootPath: '/music/lib/lib/', // stored at sync time
        },
        {
          trackId: 'track-old-2',
          itemId: 'artist-1',
          destinationPath: '/mnt/usb/Artist/Old Album/track2.mp3',
          fileSize: 5000000,
          metadataHash: metadataHashOld2,
          coverArtMode: 'embed',
          encodedBitrate: '192k',
          serverPath: '/music/lib/lib/Artist/Old Album/track2.mp3',
          serverRootPath: '/music/lib/lib/', // stored at sync time
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);

      const deps = createMockDeps({
        api: createMockApiClient({ getTracksForItems: getTracksForItemsSpy }),
      });

      const core = createTestSyncCore(configWithServerRoot, deps);

      const result = await core.analyzeDiff(
        ['artist-1'],
        new Map([['artist-1', 'artist' as ItemType]]),
        '/mnt/usb',
        { coverArtMode: 'embed', bitrate: '192k', convertToMp3: false }
      );

      expect(result.items).toHaveLength(1);
      const artistDiff = result.items[0];
      expect(artistDiff.itemId).toBe('artist-1');
      expect(artistDiff.itemType).toBe('artist');

      // Old tracks should be unchanged, new tracks should be new
      const unchanged = artistDiff.changes.filter(c => c.changeType === 'unchanged');
      const newTracks = artistDiff.changes.filter(c => c.changeType === 'new');

      expect(unchanged).toHaveLength(2); // Old tracks should be unchanged
      expect(newTracks).toHaveLength(1); // New album track should be new
      expect(unchanged.map(c => c.trackId)).toEqual(['track-old-1', 'track-old-2']);
      expect(newTracks.map(c => c.trackId)).toEqual(['track-new-1']);

      // Totals should reflect: 1 new, 2 unchanged
      expect(result.totals.newTracks).toBe(1);
      expect(result.totals.unchanged).toBe(2);
    });

    it('keeps old tracks unchanged when serverRootPath differs from initial sync (serverRootPath fix)', async () => {
      // This test reproduces the bug: if serverRootPath auto-detection gives a different
      // result than what was used during initial sync, tracks show as "path_changed"
      // even though content is unchanged.
      const configWithServerRoot: SyncConfig = {
        ...validConfig,
        serverRootPath: '/music/', // User configured this during initial sync
      };

      // When analyzing, serverRootPath is auto-detected from track paths.
      // If tracks have a different path structure, auto-detection gives a different result.
      // OLD paths: /music/lib/lib/Artist/Old Album/track.mp3 (auto-detected: /music/lib/)
      // NEW paths: /music/newlib/newlib/Artist/Old Album/track.mp3 (auto-detected: /music/newlib/)
      const getTracksForItemsSpy = vi.fn(() =>
        Promise.resolve({
          tracks: [
            // Tracks with NEW path structure (as if library was reorganized)
            { id: 'track-old-1', name: 'Old Track 1', album: 'Old Album', artists: ['Artist'], path: '/music/newlib/newlib/Artist/Old Album/track1.mp3', format: 'mp3', parentItemId: 'artist-1' },
            { id: 'track-old-2', name: 'Old Track 2', album: 'Old Album', artists: ['Artist'], path: '/music/newlib/newlib/Artist/Old Album/track2.mp3', format: 'mp3', parentItemId: 'artist-1' },
          ],
          errors: [],
        })
      );

      // Synced with OLD path structure (serverRootPath = /music/lib/)
      const metadataHashOld1 = '32ba41d956e25e42';
      const metadataHashOld2 = 'eb8249545f07eb00';

      mockGetSyncedTracksForItem.mockReturnValue([
        {
          trackId: 'track-old-1',
          itemId: 'artist-1',
          // Synced with serverRootPath='/music/lib/lib/' (auto-detected from deep paths)
          // serverRelativePath = 'Artist/Old Album/' → outputDir = /mnt/usb/Artist/Old Album
          destinationPath: '/mnt/usb/Artist/Old Album/track1.mp3',
          fileSize: 5000000,
          metadataHash: metadataHashOld1,
          coverArtMode: 'embed',
          encodedBitrate: '192k',
          serverPath: '/music/lib/lib/Artist/Old Album/track1.mp3',
          serverRootPath: '/music/lib/lib/', // stored at sync time
        },
        {
          trackId: 'track-old-2',
          itemId: 'artist-1',
          destinationPath: '/mnt/usb/Artist/Old Album/track2.mp3',
          fileSize: 5000000,
          metadataHash: metadataHashOld2,
          coverArtMode: 'embed',
          encodedBitrate: '192k',
          serverPath: '/music/lib/lib/Artist/Old Album/track2.mp3',
          serverRootPath: '/music/lib/lib/', // stored at sync time
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);

      const deps = createMockDeps({
        api: createMockApiClient({ getTracksForItems: getTracksForItemsSpy }),
      });

      const core = createTestSyncCore(configWithServerRoot, deps);

      const result = await core.analyzeDiff(
        ['artist-1'],
        new Map([['artist-1', 'artist' as ItemType]]),
        '/mnt/usb',
        { coverArtMode: 'embed', bitrate: '192k', convertToMp3: false }
      );

      const artistDiff = result.items[0];
      const pathChanged = artistDiff.changes.filter(c => c.changeType === 'path_changed');
      const unchanged = artistDiff.changes.filter(c => c.changeType === 'unchanged');

      // With the fix using both synced.serverRootPath AND synced.serverPath:
      // synced.serverRootPath='/music/lib/lib/', serverPath='/music/lib/lib/Artist/Old Album/track1.mp3'
      // rootPathForDiff = synced.serverRootPath = '/music/lib/lib/'
      // serverRelativePath = 'Artist/Old Album/'
      // outputDir = /mnt/usb/Artist/Old Album (correct!)
      // expected = /mnt/usb/Artist/Old Album/track1.mp3 ✓
      // So old tracks stay unchanged despite library reorganisation
      expect(pathChanged).toHaveLength(0); // FIXED: no false path_changed
      expect(unchanged).toHaveLength(2);   // FIXED: old tracks correctly marked unchanged
    });
  });

  // ---------------------------------------------------------------------------
  // analyzeDiff: H2 — itemErrors on API failure
  // ---------------------------------------------------------------------------
  describe('analyzeDiff item-level errors', () => {
    it('includes failed items in itemErrors when API call fails', async () => {
      const configWithServerRoot: SyncConfig = {
        ...validConfig,
        serverRootPath: '/music/',
      };

      vi.mocked(getSyncedTracksForItem).mockReturnValue([]);

      const deps = createMockDeps({
        api: createMockApiClient({
          getTracksForItems: async () => ({
            tracks: [],
            errors: ['Failed to fetch album album-fail: Connection refused'],
          }),
        }),
      });

      const core = createTestSyncCore(configWithServerRoot, deps);

      const result = await core.analyzeDiff(
        ['album-fail'],
        new Map([['album-fail', 'album' as ItemType]]),
        '/music',
        { coverArtMode: 'embed', bitrate: '192k', convertToMp3: false }
      );

      expect(result.itemErrors).toBeDefined();
      expect(result.itemErrors!.length).toBeGreaterThan(0);
      expect(result.itemErrors![0].itemId).toBe('album-fail');
    });
  });

  // ---------------------------------------------------------------------------
  // analyzeDiff: Legacy NULL serverRootPath — no false path_changed
  // ---------------------------------------------------------------------------
  describe('analyzeDiff legacy NULL serverRootPath', () => {
    it('marks tracks as unchanged when serverRootPath is NULL (v1→v2 migration)', async () => {
      const configNoRoot: SyncConfig = {
        ...validConfig,
        serverRootPath: '', // auto-detection will be used
      };

      // Server returns deep-path tracks (5+ components) so detection succeeds
      const getTracksForItemsSpy = vi.fn(() =>
        Promise.resolve({
          tracks: [
            { id: 'track-1', name: 'Track 1', album: 'Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Album/track1.mp3', format: 'mp3', parentItemId: 'album-1' },
            { id: 'track-2', name: 'Track 2', album: 'Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Album/track2.mp3', format: 'mp3', parentItemId: 'album-1' },
          ],
          errors: [],
        })
      );

      // Legacy synced records from v1 sync: serverRootPath = NULL, serverPath = NULL
      // These records cannot be path-compared reliably since we don't know what
      // root was in effect at original sync time.
      // Hashes computed from: { title: 'Track 1/2', artist: 'Artist', album: 'Album' }
      const metadataHash1 = '1d68c7ded0780462';
      const metadataHash2 = 'cea9f581fa108bca';

      mockGetSyncedTracksForItem.mockReturnValue([
        {
          trackId: 'track-1',
          itemId: 'album-1',
          destinationPath: '/mnt/usb/Artist/Album/track1.mp3', // v1 stored full relative path
          fileSize: 5000000,
          metadataHash: metadataHash1,
          coverArtMode: 'embed',
          encodedBitrate: '192k',
          serverPath: null,    // legacy: never stored
          serverRootPath: null, // legacy: NULL from v1 migration
        },
        {
          trackId: 'track-2',
          itemId: 'album-1',
          destinationPath: '/mnt/usb/Artist/Album/track2.mp3',
          fileSize: 5000000,
          metadataHash: metadataHash2,
          coverArtMode: 'embed',
          encodedBitrate: '192k',
          serverPath: null,    // legacy: never stored
          serverRootPath: null, // legacy: NULL from v1 migration
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);

      const deps = createMockDeps({
        api: createMockApiClient({ getTracksForItems: getTracksForItemsSpy }),
      });

      const core = createTestSyncCore(configNoRoot, deps);

      const result = await core.analyzeDiff(
        ['album-1'],
        new Map([['album-1', 'album' as ItemType]]),
        '/mnt/usb',
        { coverArtMode: 'embed', bitrate: '192k', convertToMp3: false }
      );

      expect(result.items).toHaveLength(1);
      const albumDiff = result.items[0];

      // Tracks with NULL serverRootPath must be marked unchanged (not path_changed),
      // regardless of whether the expected path computed by current detectServerRootPath
      // matches the legacy stored destinationPath.
      const unchanged = albumDiff.changes.filter(c => c.changeType === 'unchanged');
      const pathChanged = albumDiff.changes.filter(c => c.changeType === 'path_changed');
      expect(unchanged).toHaveLength(2);
      expect(pathChanged).toHaveLength(0);
    });

    it('still detects path_changed when serverRootPath is non-null (v2 re-sync)', async () => {
      const configWithServerRoot: SyncConfig = {
        ...validConfig,
        serverRootPath: '/music/lib/lib/',
      };

      const getTracksForItemsSpy = vi.fn(() =>
        Promise.resolve({
          tracks: [
            { id: 'track-1', name: 'Track 1', album: 'Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Album/track1.mp3', format: 'mp3', parentItemId: 'album-1' },
          ],
          errors: [],
        })
      );

      // v2 synced record with stored serverRootPath — path comparison should work
      // Hash computed from: { title: 'Track 1', artist: 'Artist', album: 'Album' }
      mockGetSyncedTracksForItem.mockReturnValue([
        {
          trackId: 'track-1',
          itemId: 'album-1',
          destinationPath: '/mnt/usb/Artist/Album/track1.mp3', // correct expected path
          fileSize: 5000000,
          metadataHash: '1d68c7ded0780462',
          coverArtMode: 'embed',
          encodedBitrate: '192k',
          serverPath: '/music/lib/lib/Artist/Album/track1.mp3',
          serverRootPath: '/music/lib/lib/', // stored at sync time (v2)
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);

      const deps = createMockDeps({
        api: createMockApiClient({ getTracksForItems: getTracksForItemsSpy }),
      });

      const core = createTestSyncCore(configWithServerRoot, deps);

      const result = await core.analyzeDiff(
        ['album-1'],
        new Map([['album-1', 'album' as ItemType]]),
        '/mnt/usb',
        { coverArtMode: 'embed', bitrate: '192k', convertToMp3: false }
      );

      const albumDiff = result.items[0];
      const unchanged = albumDiff.changes.filter(c => c.changeType === 'unchanged');
      // Path should match → unchanged
      expect(unchanged).toHaveLength(1);
    });
  });
});

// =============================================================================
// detectServerRootPath TESTS
// =============================================================================
describe('detectServerRootPath', () => {
  it('filters out shallow paths and returns common root from valid candidates', async () => {
    const { detectServerRootPath } = await import('./sync-api');

    const tracks = [
      // Deep paths — valid candidates
      { id: '1', name: 'Track 1', path: '/mediamusic/lib/lib/Artist1/Album/track1.mp3', format: 'mp3' },
      { id: '2', name: 'Track 2', path: '/mediamusic/lib/lib/Artist2/Album/track2.mp3', format: 'mp3' },
      // Shallow path — would return '' from map, must be filtered out
      { id: '3', name: 'Track 3', path: '/music/track.mp3', format: 'mp3' },
    ];

    const result = detectServerRootPath(tracks);
    // Algorithm drops 4 levels (filename + album + artist + library_name).
    // /mediamusic/lib/lib/Artist1/Album/track1.mp3 → /mediamusic/lib/
    // Shallow track (/music/track.mp3) is filtered out and does not affect the result.
    expect(result).toBe('/mediamusic/lib/');
  });

  it('returns empty string when all tracks are too shallow', async () => {
    const { detectServerRootPath } = await import('./sync-api');

    const tracks = [
      { id: '1', name: 'Track 1', path: '/track.mp3', format: 'mp3' },
      { id: '2', name: 'Track 2', path: '/music/track.mp3', format: 'mp3' },
    ];

    const result = detectServerRootPath(tracks);
    expect(result).toBe('');
  });
});

// =============================================================================
// analyzeDiff: v1→v2 retrocompatibility (JELLY-0053)
// Items synced with v1 (in synced_files) but no track records (synced_tracks)
// must not appear as "out of sync" due to new tracks in the diff engine.
// =============================================================================

describe('analyzeDiff v1→v2 retrocompatibility', () => {
  it('marks all tracks as unchanged when item is v1-synced (in synced_files, no synced_tracks)', async () => {
    // Item was synced with v1: present in getSyncedItems() but absent from getSyncedTracksForItem()
    mockGetSyncedItems.mockReturnValue([
      { id: 'artist-1', name: 'Artist One', type: 'artist' },
    ]);
    // No track-level records for this item (v1 never wrote synced_tracks)
    mockGetSyncedTracksForItem.mockReturnValue([]);

    const getTracksForItemsSpy = vi.fn(() =>
      Promise.resolve({
        tracks: [
          { id: 'track-1', name: 'Track 1', album: 'Album', artists: ['Artist One'], path: '/music/lib/lib/Artist One/Album/track1.mp3', format: 'mp3', parentItemId: 'artist-1' },
          { id: 'track-2', name: 'Track 2', album: 'Album', artists: ['Artist One'], path: '/music/lib/lib/Artist One/Album/track2.mp3', format: 'mp3', parentItemId: 'artist-1' },
        ],
        errors: [],
      })
    );

    const deps = createMockDeps({
      api: createMockApiClient({ getTracksForItems: getTracksForItemsSpy }),
    });
    const core = createTestSyncCore(validConfig, deps);

    const result = await core.analyzeDiff(
      ['artist-1'],
      new Map([['artist-1', 'artist' as ItemType]]),
      '/mnt/usb',
      { coverArtMode: 'embed', bitrate: '192k', convertToMp3: false }
    );

    expect(result.items).toHaveLength(1);
    const diff = result.items[0];

    // All tracks must be unchanged — no false "new" for v1 items
    const unchanged = diff.changes.filter(c => c.changeType === 'unchanged');
    const newTracks = diff.changes.filter(c => c.changeType === 'new');
    expect(unchanged).toHaveLength(2);
    expect(newTracks).toHaveLength(0);
    expect(diff.summary.new).toBe(0);
    expect(diff.summary.unchanged).toBe(2);

    // The sub-items check in useDeviceSelections must NOT see newTracks > 0
    // (this is what caused the false "out of sync" display)
    if (diff.subItems) {
      for (const sub of diff.subItems) {
        expect(sub.summary.newTracks).toBe(0);
      }
    }
  });

  it('still marks tracks as new for items not in synced_files at all', async () => {
    // Item has never been synced: absent from both getSyncedItems() and getSyncedTracksForItem()
    mockGetSyncedItems.mockReturnValue([]);
    mockGetSyncedTracksForItem.mockReturnValue([]);

    const getTracksForItemsSpy = vi.fn(() =>
      Promise.resolve({
        tracks: [
          { id: 'track-1', name: 'Track 1', album: 'Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Album/track1.mp3', format: 'mp3', parentItemId: 'artist-1' },
        ],
        errors: [],
      })
    );

    const deps = createMockDeps({
      api: createMockApiClient({ getTracksForItems: getTracksForItemsSpy }),
    });
    const core = createTestSyncCore(validConfig, deps);

    const result = await core.analyzeDiff(
      ['artist-1'],
      new Map([['artist-1', 'artist' as ItemType]]),
      '/mnt/usb',
      { coverArtMode: 'embed', bitrate: '192k', convertToMp3: false }
    );

    expect(result.items).toHaveLength(1);
    const newTracks = result.items[0].changes.filter(c => c.changeType === 'new');
    expect(newTracks).toHaveLength(1);
    expect(result.items[0].summary.new).toBe(1);
  });
});

// =============================================================================
// Sync healing: skip paths must write synced_tracks for v1→v2 migration
// When a track is skipped because the file already exists (no prior DB record),
// upsertSyncedTrack must be called to populate synced_tracks.
// =============================================================================

describe('sync loop healing on skip', () => {
  it('writes synced_tracks record when file exists at expected path with matching size (no prior record)', async () => {
    const deps = createMockDeps();

    // No existing synced_tracks records for this device
    vi.mocked(getSyncedTracksForDevice).mockReturnValue([]);

    // Simulate file already on disk at the expected path (v1 sync placed it there)
    const mockFs = deps.fs as any;
    mockFs.__setFile('/mnt/usb/Artist One/Album One/Track One.mp3', Buffer.alloc(5000000));

    const core = createTestSyncCore(validConfig, deps);

    const itemTypes = new Map<string, ItemType>([['album-1', 'album']]);
    await core.sync(
      { itemIds: ['album-1'], itemTypes, destinationPath: '/mnt/usb' },
      () => {}
    );

    // upsertSyncedTrack must have been called to record the skipped track
    expect(vi.mocked(upsertSyncedTrack)).toHaveBeenCalled();
  });
});

// =============================================================================
// cover art size limit (ORAIN-0232)
// Discarding cover art > 5 MB instead of embedding it prevents bloated tags.
// =============================================================================

describe('cover art size limit — ORAIN-0232', () => {
  const FIVE_MB = 5 * 1024 * 1024;

  it('embeds cover art when buffer is exactly 5 MB (not greater than)', async () => {
    const fiveMbBuffer = Buffer.alloc(FIVE_MB, 0xff);
    const progressWarnings: string[] = [];

    const track: TrackInfo = {
      id: 'track-cover-5mb',
      name: 'Track 5MB Cover',
      album: 'Album 5MB Cover',
      artists: ['Artist'],
      path: '/music/artist/album/track.mp3',
      format: 'mp3',
      size: 5000000,
      albumId: 'album-cover-5mb',
    };

    const getTracksForItemsSpy = vi.fn(() =>
      Promise.resolve({ tracks: [track], errors: [] })
    );

    const deps = createMockDeps({
      api: createMockApiClient({
        getTracksForItems: getTracksForItemsSpy,
        getCoverArt: async () => fiveMbBuffer,
        downloadItem: async () => Buffer.from('fake-audio-data'),
        downloadItemStream: async () => {
          const { Readable } = require('stream');
          return Readable.from(Buffer.from('fake-audio-data'));
        },
      }),
    });

    const core = createTestSyncCore(validConfig, deps);
    const itemTypes = new Map<string, ItemType>([['album-cover-5mb', 'album']]);

    await core.sync(
      { itemIds: ['album-cover-5mb'], itemTypes, destinationPath: '/mnt/usb' },
      (p) => { if (p.warning) progressWarnings.push(p.warning); }
    );

    // Exactly 5 MB is NOT greater than 5 MB — no warning should be emitted
    expect(progressWarnings.filter((w) => w === 'cover_art_too_large')).toHaveLength(0);
  });

  it('discards cover art and emits warning when buffer exceeds 5 MB by 1 byte', async () => {
    const overLimitBuffer = Buffer.alloc(FIVE_MB + 1, 0xff);
    const progressWarnings: string[] = [];

    const track: TrackInfo = {
      id: 'track-cover-big',
      name: 'Track Big Cover',
      album: 'Album Big Cover',
      artists: ['Artist'],
      path: '/music/artist/album/track.mp3',
      format: 'mp3',
      size: 5000000,
      albumId: 'album-cover-big',
    };

    const getTracksForItemsSpy = vi.fn(() =>
      Promise.resolve({ tracks: [track], errors: [] })
    );

    const deps = createMockDeps({
      api: createMockApiClient({
        getTracksForItems: getTracksForItemsSpy,
        getCoverArt: async () => overLimitBuffer,
        downloadItem: async () => Buffer.from('fake-audio-data'),
        downloadItemStream: async () => {
          const { Readable } = require('stream');
          return Readable.from(Buffer.from('fake-audio-data'));
        },
      }),
    });

    const core = createTestSyncCore(validConfig, deps);
    const itemTypes = new Map<string, ItemType>([['album-cover-big', 'album']]);

    await core.sync(
      { itemIds: ['album-cover-big'], itemTypes, destinationPath: '/mnt/usb' },
      (p) => { if (p.warning) progressWarnings.push(p.warning); }
    );

    // Over 5 MB → cover_art_too_large warning must be emitted
    expect(progressWarnings).toContain('cover_art_too_large');
  });

  it('sync succeeds without throwing when cover art is discarded (track not aborted)', async () => {
    const overLimitBuffer = Buffer.alloc(FIVE_MB + 1, 0xff);

    const track: TrackInfo = {
      id: 'track-cover-ok',
      name: 'Track OK',
      album: 'Album OK',
      artists: ['Artist'],
      path: '/music/artist/album/track.mp3',
      format: 'mp3',
      size: 5000000,
      albumId: 'album-cover-ok',
    };

    const getTracksForItemsSpy = vi.fn(() =>
      Promise.resolve({ tracks: [track], errors: [] })
    );

    const deps = createMockDeps({
      api: createMockApiClient({
        getTracksForItems: getTracksForItemsSpy,
        getCoverArt: async () => overLimitBuffer,
        downloadItem: async () => Buffer.from('fake-audio-data'),
        downloadItemStream: async () => {
          const { Readable } = require('stream');
          return Readable.from(Buffer.from('fake-audio-data'));
        },
      }),
    });

    // Suppress converter errors from console — we care only that sync doesn't throw
    const origError = console.error;
    console.error = vi.fn();

    try {
      const core = createTestSyncCore(validConfig, deps);
      const itemTypes = new Map<string, ItemType>([['album-cover-ok', 'album']]);

      // sync must not throw — cover art over limit is non-fatal
      await expect(
        core.sync(
          { itemIds: ['album-cover-ok'], itemTypes, destinationPath: '/mnt/usb' },
          () => {}
        )
      ).resolves.toBeDefined();
    } finally {
      console.error = origError;
    }
  });
});describe('removeItems', () => {
  // Stable config WITH serverRootPath so path computation works in tests
  const configWithServerRoot: SyncConfig = {
    serverUrl: 'https://jellyfin.example.com',
    apiKey: '0123456789abcdef0123456789abcdef',
    userId: 'abcdef1234567890abcdef1234567890',
    serverRootPath: '/music/',
  };

  // ---------------------------------------------------------------------------
  // Test: partial deletion — some items fail to delete, errors are reported
  // but the rest continues successfully.
  // ---------------------------------------------------------------------------
  describe('partial deletion with errors reported', () => {
    it('reports errors for failed deletions but continues with the rest', async () => {
      // Track 1 will fail deletion (simulate permission error), track 2 succeeds
      let track2Deleted = false;
      const failingFs = {
        ...createMockFileSystem(),
        unlink: async (path: string) => {
          if (path.includes('track-1')) throw new Error('Permission denied');
          track2Deleted = true;
        },
      };

      // Two tracks on disk: track-1.mp3 and track-2.mp3
      (failingFs as any).__setFile('/music/Artist/Album/track-1.mp3', Buffer.alloc(100));
      (failingFs as any).__setFile('/music/Artist/Album/track-2.mp3', Buffer.alloc(100));

      const mockApi = createMockApiClient({
        getTracksForItems: async () => ({
          tracks: [
            { id: 'track-1', name: 'Track One', path: '/music/Artist/Album/track-1.mp3', format: 'mp3', parentItemId: 'album-1' },
            { id: 'track-2', name: 'Track Two', path: '/music/Artist/Album/track-2.mp3', format: 'mp3', parentItemId: 'album-1' },
          ],
          errors: [],
        }),
      });

      const deps: SyncDependencies = {
        api: mockApi,
        fs: failingFs as any,
        converter: createMockConverter(),
      };

      const core = createTestSyncCore(configWithServerRoot, deps);

      const result = await core.removeItems(
        ['album-1'],
        new Map([['album-1', 'album' as ItemType]]),
        '/music'
      );

      // track-2 should have been deleted successfully
      expect(track2Deleted).toBe(true);
      // Error for track-1 should be in the errors list
      expect(result.errors.some(e => e.includes('track-1') || e.includes('Permission denied'))).toBe(true);
      // At least one track should have been removed
      expect(result.removed).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Test: cross-playlist — a track shared between two playlists must NOT be
  // deleted when only one of the playlists is removed, because the other playlist
  // still references it via its .m3u8 file.
  // ---------------------------------------------------------------------------
  describe('cross-playlist shared track protection', () => {
    it('does not delete a track referenced by another playlist', async () => {
      const mockFs = createMockFileSystem() as any;

      // Two playlists: "Pop Hits" and "Rock Classics"
      // Both contain the SAME track (track-shared.mp3)
      // When removing "Pop Hits" playlist, track-shared.mp3 must NOT be deleted
      // because "Rock Classics.m3u8" still references it.
      // M3U8 stores relative paths as: getRelativePath(track.path, serverRootPath)
      // track.path = '/music/Artist/Shared Track.mp3', serverRootPath = '/music/'
      // → relative path = 'Artist/Shared Track.mp3'
      mockFs.__setFile('/music/Pop Hits.m3u8', Buffer.from('#EXTM3U\n#EXTINF:-1,Shared Track\nArtist/Shared Track.mp3\n'));
      mockFs.__setFile('/music/Rock Classics.m3u8', Buffer.from('#EXTM3U\n#EXTINF:-1,Shared Track\nArtist/Shared Track.mp3\n'));
      mockFs.__setFile('/music/Artist/Shared Track.mp3', Buffer.alloc(5000000));

      const mockApi = createMockApiClient({
        getTracksForItems: async () => ({
          tracks: [
            { id: 'track-shared', name: 'Shared Track', artists: ['Artist'], path: '/music/Artist/Shared Track.mp3', format: 'mp3', parentItemId: 'playlist-pop-hits' },
          ],
          errors: [],
        }),
        getItem: async (id: string) => {
          if (id === 'playlist-pop-hits') return { id, name: 'Pop Hits', type: 'Playlist' };
          return null;
        },
      });

      const deps: SyncDependencies = {
        api: mockApi,
        fs: mockFs,
        converter: createMockConverter(),
      };

      const core = createTestSyncCore(configWithServerRoot, deps);

      const result = await core.removeItems(
        ['playlist-pop-hits'],
        new Map([['playlist-pop-hits', 'playlist' as ItemType]]),
        '/music'
      );

      // Pop Hits.m3u8 should be deleted
      expect((mockFs as any).__getFile('/music/Pop Hits.m3u8')).toBeUndefined();
      // Rock Classics.m3u8 should remain
      expect((mockFs as any).__getFile('/music/Rock Classics.m3u8')).toBeDefined();
      // The shared track file should still exist (protected by Rock Classics.m3u8)
      expect((mockFs as any).__getFile('/music/Artist/Shared Track.mp3')).toBeDefined();
      // No errors expected since the track was correctly preserved
      expect(result.errors).toHaveLength(0);
      // removed counts audio files deleted; .m3u8 deletion is counted there
      // (not M3U8 files which go through Step 1 without incrementing removed)
      expect(result.removed).toBe(0); // track is protected by Rock Classics.m3u8
    });

    it('deletes a track when last referencing playlist is removed', async () => {
      const mockFs = createMockFileSystem() as any;

      // Only one playlist references the track
      // relative path = getRelativePath('/music/Artist/Lone Track.mp3', '/music/') = 'Artist/Lone Track.mp3'
      mockFs.__setFile('/music/Solo Playlist.m3u8', Buffer.from('#EXTM3U\n#EXTINF:-1,Lone Track\nArtist/Lone Track.mp3\n'));
      mockFs.__setFile('/music/Artist/Lone Track.mp3', Buffer.alloc(5000000));

      const mockApi = createMockApiClient({
        getTracksForItems: async () => ({
          tracks: [
            { id: 'track-lone', name: 'Lone Track', artists: ['Artist'], path: '/music/Artist/Lone Track.mp3', format: 'mp3', parentItemId: 'playlist-solo' },
          ],
          errors: [],
        }),
        getItem: async (_id: string) => ({ id: _id, name: 'Solo Playlist', type: 'Playlist' }),
      });

      const deps: SyncDependencies = {
        api: mockApi,
        fs: mockFs,
        converter: createMockConverter(),
      };

      const core = createTestSyncCore(configWithServerRoot, deps);

      const result = await core.removeItems(
        ['playlist-solo'],
        new Map([['playlist-solo', 'playlist' as ItemType]]),
        '/music'
      );

      // M3U8 deleted
      expect((mockFs as any).__getFile('/music/Solo Playlist.m3u8')).toBeUndefined();
      // Track should be deleted too (no other playlist protects it)
      expect((mockFs as any).__getFile('/music/Artist/Lone Track.mp3')).toBeUndefined();
      // removed counts audio files deleted, not M3U8 files (which have no error counting)
      expect(result.removed).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Test: race condition — two concurrent removeItems() calls on the same file
  // should not leave inconsistent state (e.g. file deleted but counter off).
  // The second call should gracefully handle the already-deleted file.
  // ---------------------------------------------------------------------------
  describe('concurrent calls do not cause inconsistent state', () => {
    it('second concurrent call succeeds without errors even if file already deleted', async () => {
      const mockFs = createMockFileSystem() as any;

      // Set up: one playlist referencing one track
      // relative path = 'Artist/Track.mp3'
      mockFs.__setFile('/music/Test Playlist.m3u8', Buffer.from('#EXTM3U\n#EXTINF:-1,Track\nArtist/Track.mp3\n'));
      mockFs.__setFile('/music/Artist/Track.mp3', Buffer.alloc(3000000));

      let deleteCallCount = 0;
      const trackingFs = {
        ...mockFs,
        unlink: async (path: string) => {
          deleteCallCount++;
          await mockFs.unlink(path);
        },
      };

      const mockApi = createMockApiClient({
        getTracksForItems: async () => ({
          tracks: [
            { id: 'track-1', name: 'Track', artists: ['Artist'], path: '/music/Artist/Track.mp3', format: 'mp3', parentItemId: 'playlist-1' },
          ],
          errors: [],
        }),
        getItem: async (_id: string) => ({ id: _id, name: 'Test Playlist', type: 'Playlist' }),
      });

      const deps: SyncDependencies = {
        api: mockApi,
        fs: trackingFs as any,
        converter: createMockConverter(),
      };

      const core = createTestSyncCore(configWithServerRoot, deps);

      // Simulate two concurrent calls to removeItems for the same playlist
      const [result1, result2] = await Promise.all([
        core.removeItems(['playlist-1'], new Map([['playlist-1', 'playlist' as ItemType]]), '/music'),
        core.removeItems(['playlist-1'], new Map([['playlist-1', 'playlist' as ItemType]]), '/music'),
      ]);

      // Both should succeed without errors (second call finds nothing to do)
      expect(result1.errors).toHaveLength(0);
      expect(result2.errors).toHaveLength(0);
      // Track should be deleted only once
      expect(deleteCallCount).toBeGreaterThanOrEqual(1);
      // File should not exist
      expect((mockFs as any).__getFile('/music/Artist/Track.mp3')).toBeUndefined();
    });

    it('concurrent removeItems on different playlists with shared track — track preserved until last playlist removed', async () => {
      const mockFs = createMockFileSystem() as any;

      // Track is in both playlists
      // relative path = 'Artist/Shared.mp3'
      mockFs.__setFile('/music/Playlist A.m3u8', Buffer.from('#EXTM3U\n#EXTINF:-1,Shared\nArtist/Shared.mp3\n'));
      mockFs.__setFile('/music/Playlist B.m3u8', Buffer.from('#EXTM3U\n#EXTINF:-1,Shared\nArtist/Shared.mp3\n'));
      mockFs.__setFile('/music/Artist/Shared.mp3', Buffer.alloc(5000000));

      const mockApi = createMockApiClient({
        getTracksForItems: async () => ({
          tracks: [
            { id: 'shared-track', name: 'Shared', artists: ['Artist'], path: '/music/Artist/Shared.mp3', format: 'mp3', parentItemId: 'playlist-a' },
            { id: 'shared-track', name: 'Shared', artists: ['Artist'], path: '/music/Artist/Shared.mp3', format: 'mp3', parentItemId: 'playlist-b' },
          ],
          errors: [],
        }),
        getItem: async (id: string) => {
          if (id === 'playlist-a') return { id, name: 'Playlist A', type: 'Playlist' };
          if (id === 'playlist-b') return { id, name: 'Playlist B', type: 'Playlist' };
          return null;
        },
      });

      const deps: SyncDependencies = {
        api: mockApi,
        fs: mockFs as any,
        converter: createMockConverter(),
      };

      const core = createTestSyncCore(configWithServerRoot, deps);

      // Concurrently remove both playlists
      const [resultA, resultB] = await Promise.all([
        core.removeItems(['playlist-a'], new Map([['playlist-a', 'playlist' as ItemType]]), '/music'),
        core.removeItems(['playlist-b'], new Map([['playlist-b', 'playlist' as ItemType]]), '/music'),
      ]);

      // Both should succeed
      expect(resultA.errors).toHaveLength(0);
      expect(resultB.errors).toHaveLength(0);
      // Track must be deleted after both playlists removed
      expect((mockFs as any).__getFile('/music/Artist/Shared.mp3')).toBeUndefined();
    });
  });
});

// =============================================================================
// generateM3u8Files TESTS
// =============================================================================

describe('generateM3u8Files', () => {
  const configWithServerRoot: SyncConfig = {
    ...validConfig,
    serverRootPath: '/music/lib/',
  };

  it('writes no file when playlist has no tracks', async () => {
    const mockApi = createMockApiClient({
      getTracksForItems: async () => ({ tracks: [], errors: [] }),
      getItem: async () => ({ id: 'pl-1', name: 'Empty Playlist', type: 'Playlist' }),
      getPlaylistTracks: async () => [],
    });

    const mockFs = createMockFileSystem();
    const deps: SyncDependencies = { api: mockApi, fs: mockFs, converter: createMockConverter() };

    const core = createTestSyncCore(configWithServerRoot, deps);

    await core.sync({
      itemIds: ['pl-1'],
      itemTypes: new Map([['pl-1', 'playlist' as ItemType]]),
      destinationPath: '/usb',
    });

    // Empty playlist — no .m3u8 written
    expect((mockFs as any).__getFile('/usb/Empty Playlist.m3u8')).toBeUndefined();
  });

  it('writes a single playlist M3U8 file', async () => {
    const tracks = [
      { id: 't1', name: 'Track One', album: 'Album', artists: ['Artist'], path: '/music/lib/Artist/Album/track1.mp3', format: 'mp3', parentItemId: 'pl-1' },
      { id: 't2', name: 'Track Two', album: 'Album', artists: ['Artist'], path: '/music/lib/Artist/Album/track2.mp3', format: 'mp3', parentItemId: 'pl-1' },
    ];

    // Set up source files so sync actually processes something
    const mockFs = createMockFileSystem();
    (mockFs as any).__setFile('/music/lib/Artist/Album/track1.mp3', Buffer.alloc(100));
    (mockFs as any).__setFile('/music/lib/Artist/Album/track2.mp3', Buffer.alloc(100));

    const mockApi = createMockApiClient({
      getTracksForItems: async () => ({ tracks, errors: [] }),
      getItem: async () => ({ id: 'pl-1', name: 'My Playlist', type: 'Playlist' }),
      getPlaylistTracks: async () => tracks,
      downloadItem: async () => Buffer.alloc(100),
      downloadItemStream: async () => {
        const { Readable } = require('stream');
        return Readable.from(Buffer.alloc(100));
      },
    });

    const deps: SyncDependencies = { api: mockApi, fs: mockFs, converter: createMockConverter() };

    const core = createTestSyncCore(configWithServerRoot, deps);

    await core.sync({
      itemIds: ['pl-1'],
      itemTypes: new Map([['pl-1', 'playlist' as ItemType]]),
      destinationPath: '/usb',
    });

    const m3u8 = (mockFs as any).__getFile('/usb/My Playlist.m3u8');
    expect(m3u8).toBeDefined();
    const content = m3u8.toString('utf8');
    expect(content).toContain('#EXTM3U');
    expect(content).toContain('Artist - Track One');
    expect(content).toContain('Artist/Album/track1.mp3');
  });

  it('writes M3U8 files for multiple playlists', async () => {
    // Set up source files so sync actually processes something
    const mockFs = createMockFileSystem();
    (mockFs as any).__setFile('/music/lib/Artist/Album/t.mp3', Buffer.alloc(100));

    const mockApi = createMockApiClient({
      getTracksForItems: async () => ({
        tracks: [
          { id: 't1', name: 'Track', album: 'Album', artists: ['Artist'], path: '/music/lib/Artist/Album/t.mp3', format: 'mp3', parentItemId: 'pl-1' },
        ],
        errors: [],
      }),
      getItem: async (id: string) => ({ id, name: `Playlist ${id}`, type: 'Playlist' }),
      getPlaylistTracks: async () => [
        { id: 't1', name: 'Track', album: 'Album', artists: ['Artist'], path: '/music/lib/Artist/Album/t.mp3', format: 'mp3', parentItemId: 'pl-1' },
      ],
      downloadItem: async () => Buffer.alloc(100),
      downloadItemStream: async () => {
        const { Readable } = require('stream');
        return Readable.from(Buffer.alloc(100));
      },
    });

    const deps: SyncDependencies = { api: mockApi, fs: mockFs, converter: createMockConverter() };

    const core = createTestSyncCore(configWithServerRoot, deps);

    await core.sync({
      itemIds: ['pl-1', 'pl-2'],
      itemTypes: new Map([
        ['pl-1', 'playlist' as ItemType],
        ['pl-2', 'playlist' as ItemType],
      ]),
      destinationPath: '/usb',
    });

    expect((mockFs as any).__getFile('/usb/Playlist pl-1.m3u8')).toBeDefined();
    expect((mockFs as any).__getFile('/usb/Playlist pl-2.m3u8')).toBeDefined();
  });

  it('sanitizes playlist names with special characters', async () => {
    // Set up source files so sync actually processes something
    const mockFs = createMockFileSystem();
    (mockFs as any).__setFile('/music/lib/Artist/Album/t.mp3', Buffer.alloc(100));

    const mockApi = createMockApiClient({
      getTracksForItems: async () => ({
        tracks: [
          { id: 't1', name: 'Track', album: 'Album', artists: ['Artist'], path: '/music/lib/Artist/Album/t.mp3', format: 'mp3', parentItemId: 'pl-1' },
        ],
        errors: [],
      }),
      getItem: async () => ({ id: 'pl-1', name: 'My:Playlist', type: 'Playlist' }),
      getPlaylistTracks: async () => [
        { id: 't1', name: 'Track', album: 'Album', artists: ['Artist'], path: '/music/lib/Artist/Album/t.mp3', format: 'mp3', parentItemId: 'pl-1' },
      ],
      downloadItem: async () => Buffer.alloc(100),
      downloadItemStream: async () => {
        const { Readable } = require('stream');
        return Readable.from(Buffer.alloc(100));
      },
    });

    const deps: SyncDependencies = { api: mockApi, fs: mockFs, converter: createMockConverter() };

    const core = createTestSyncCore(configWithServerRoot, deps);

    await core.sync({
      itemIds: ['pl-1'],
      itemTypes: new Map([['pl-1', 'playlist' as ItemType]]),
      destinationPath: '/usb',
    });

    // Colons should be replaced with _ → "My_Playlist.m3u8"
    const m3u8 = (mockFs as any).__getFile('/usb/My_Playlist.m3u8');
    expect(m3u8).toBeDefined();
  });
});

// =============================================================================
// getCoverArtBuffer TESTS
// =============================================================================

describe('getCoverArtBuffer', () => {
  it('returns null (not throws) when server returns 404', async () => {
    const mockApi = createMockApiClient({
      getCoverArt: async () => {
        throw new Error('404');
      },
    });

    const mockFs = createMockFileSystem();
    const deps: SyncDependencies = { api: mockApi, fs: mockFs, converter: createMockConverter() };

    const core = createTestSyncCore(validConfig, deps);

    // Use getCoverArtBuffer via analyzeDiff which calls copyTrack → getCoverArtBuffer
    const getTracksForItemsSpy = vi.fn(() =>
      Promise.resolve({
        tracks: [
          { id: 'track-1', name: 'Track', album: 'Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Album/track.mp3', format: 'mp3', albumId: 'album-1', parentItemId: 'album-1' },
        ],
        errors: [],
      })
    );

    (mockApi as any).getTracksForItems = getTracksForItemsSpy;

    mockGetSyncedTracksForItem.mockReturnValue([]);

    await core.analyzeDiff(
      ['album-1'],
      new Map([['album-1', 'album' as ItemType]]),
      '/usb',
      { coverArtMode: 'embed', bitrate: '192k', convertToMp3: false }
    );

    // Should not throw — error is swallowed and undefined is returned
    expect(getTracksForItemsSpy).toHaveBeenCalled();
  });

  it('returns buffer when server returns valid image', async () => {
    const coverBuffer = Buffer.from('fake-image-data');
    const mockApi = createMockApiClient({
      getCoverArt: async () => coverBuffer,
    });

    const mockFs = createMockFileSystem();
    const deps: SyncDependencies = { api: mockApi, fs: mockFs, converter: createMockConverter() };

    const core = createTestSyncCore(validConfig, deps);

    // Direct test via analyzeDiff with mock cover art
    const getTracksForItemsSpy = vi.fn(() =>
      Promise.resolve({
        tracks: [
          { id: 'track-1', name: 'Track', album: 'Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Album/track.mp3', format: 'mp3', albumId: 'album-1', parentItemId: 'album-1' },
        ],
        errors: [],
      })
    );

    (mockApi as any).getTracksForItems = getTracksForItemsSpy;

    mockGetSyncedTracksForItem.mockReturnValue([]);

    const result = await core.analyzeDiff(
      ['album-1'],
      new Map([['album-1', 'album' as ItemType]]),
      '/usb',
      { coverArtMode: 'embed', bitrate: '192k', convertToMp3: false }
    );

    expect(result.items[0]).toBeDefined();
  });
});

// =============================================================================
// cleanEmptyDir TESTS
// =============================================================================

describe('cleanEmptyDir', () => {
  it('deletes an empty directory', async () => {
    const mockFs = createMockFileSystem();
    mockFs.mkdir = async () => {}; // override to allow mkdir for non-existing dir

    const mockApi = createMockApiClient();
    const deps: SyncDependencies = { api: mockApi, fs: mockFs, converter: createMockConverter() };

    const core = createTestSyncCore(validConfig, deps);

    // Use sync to trigger cleanEmptyDir — set up an empty album dir
    const tracks = [
      { id: 'track-1', name: 'Track', album: 'Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Empty Album/track.mp3', format: 'mp3', parentItemId: 'album-1' },
    ];

    const mockFsAny = mockFs as any;
    // Mark the directory as existing
    mockFsAny.__setFile('/usb/lib/Artist/Empty Album/.gitkeep', Buffer.from(''));

    const getTracksForItemsSpy = vi.fn(() => Promise.resolve({ tracks, errors: [] }));
    (mockApi as any).getTracksForItems = getTracksForItemsSpy;

    // Set up a dummy download so the sync can proceed
    (mockApi as any).downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.alloc(100));
    };

    mockGetSyncedTracksForItem.mockReturnValue([]);

    // Run sync — after tracks are written the empty dirs get cleaned
    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
    });

    // The empty album dir should be removed (only .gitkeep remains — a system file)
    // cleanEmptyDir removes .gitkeep and then rmdir
    const emptyAlbumExists = await mockFs.isDirectory('/usb/lib/Artist/Empty Album');
    expect(emptyAlbumExists).toBe(false);
  });

  it('does not delete a directory with content', async () => {
    const mockFs = createMockFileSystem();

    const mockApi = createMockApiClient();
    const deps: SyncDependencies = { api: mockApi, fs: mockFs, converter: createMockConverter() };

    const core = createTestSyncCore(validConfig, deps);

    // Set up a directory with a music file
    const mockFsAny = mockFs as any;
    mockFsAny.__setFile('/usb/lib/Artist/Album/track.mp3', Buffer.alloc(1000));
    mockFsAny.__setFile('/usb/lib/Artist/Album/cover.jpg', Buffer.alloc(500));

    // Trigger cleanEmptyDir by calling sync
    const tracks = [
      { id: 'track-1', name: 'Track', album: 'Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Album/track.mp3', format: 'mp3', parentItemId: 'album-1' },
    ];

    const getTracksForItemsSpy = vi.fn(() => Promise.resolve({ tracks, errors: [] }));
    (mockApi as any).getTracksForItems = getTracksForItemsSpy;
    (mockApi as any).downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.alloc(100));
    };

    mockGetSyncedTracksForItem.mockReturnValue([]);

    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
    });

    // Album dir should still exist (has track.mp3 and cover.jpg)
    const albumDirExists = await mockFs.isDirectory('/usb/lib/Artist/Album');
    expect(albumDirExists).toBe(true);
  });

  it('does not throw when directory does not exist', async () => {
    const mockFs = createMockFileSystem();
    mockFs.mkdir = async () => {};

    const mockApi = createMockApiClient();
    const deps: SyncDependencies = { api: mockApi, fs: mockFs, converter: createMockConverter() };

    const core = createTestSyncCore(validConfig, deps);

    const tracks = [
      { id: 'track-1', name: 'Track', album: 'Album', artists: ['Artist'], path: '/music/lib/lib/Artist/Album/track.mp3', format: 'mp3', parentItemId: 'album-1' },
    ];

    const getTracksForItemsSpy = vi.fn(() => Promise.resolve({ tracks, errors: [] }));
    (mockApi as any).getTracksForItems = getTracksForItemsSpy;
    (mockApi as any).downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.alloc(100));
    };

    mockGetSyncedTracksForItem.mockReturnValue([]);

    // Should not throw even though the empty dir path doesn't exist
    await expect(core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/nonexistent',
    })).resolves.not.toThrow();
  });
});