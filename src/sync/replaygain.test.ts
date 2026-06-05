/**
 * ReplayGain Unit Tests
 * Tests for fetching ReplayGain data from Jellyfin and embedding tags into audio files.
 *
 * TDD RED phase: tests written first, implementation follows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockApiClient } from './sync-api';
import { createMockConverter, createMockFileSystem } from './sync-files';
import { createTestSyncCore, type SyncDependencies } from './sync-core';
import type { SyncConfig, TrackInfo, ItemType } from './types';

const mockGetSyncedTracksForDevice = vi.hoisted(() => vi.fn(() => []));

vi.mock('../main/database', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  upsertSyncedTrack: vi.fn(),
  getSyncedTracksForDevice: mockGetSyncedTracksForDevice,
  getSyncedTracksForItem: mockGetSyncedTracksForDevice,
  removeSyncedTracksForItem: vi.fn(),
  removeSyncedTrack: vi.fn(),
}));

beforeEach(() => {
  mockGetSyncedTracksForDevice.mockReset();
  mockGetSyncedTracksForDevice.mockReturnValue([]);
});

const validConfig: SyncConfig = {
  serverUrl: 'https://jellyfin.example.com',
  apiKey: '0123456789abcdef0123456789abcdef',
  userId: 'abcdef1234567890abcdef1234567890',
};

function createTestDeps(overrides?: Partial<SyncDependencies>) {
  return {
    api: createMockApiClient(),
    fs: createMockFileSystem(),
    converter: createMockConverter(),
    ...overrides,
  };
}

// ─── AC-1: Jellyfin API returns ReplayGain data ───────────────────────────────

describe('fetchReplayGain from Jellyfin API', () => {
  it('AC-1: fetchReplayGain returns trackGain and trackPeak when available', async () => {
    const { createApiClient } = await import('./sync-api');

    function makeMockResponse(
      overrides: Partial<Response> & { ok: boolean; status: number; statusText: string },
    ): Response {
      return {
        headers: new Headers(),
        redirected: false,
        type: 'basic',
        url: 'https://jellyfin.example.com/Items/track-1',
        clone: () => ({}) as any,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => '',
        json: async () => ({}),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        bodyUsed: false,
        body: null,
        ...overrides,
      } as unknown as Response;
    }

    const api = createApiClient({
      baseUrl: 'https://jellyfin.example.com',
      apiKey: '0123456789abcdef0123456789abcdef',
      userId: 'abcdef1234567890abcdef1234567890',
      timeout: 5000,
      fetch: async () =>
        makeMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            Id: 'track-1',
            Name: 'Test Track',
            MediaSources: [
              {
                Path: '/music/Artist/Album/track.mp3',
                Container: 'mp3',
                Size: 5000000,
                Bitrate: 320000,
                // Jellyfin stores ReplayGain in MediaSource metadata when audio analysis is enabled
                // Values in dB (e.g., -6.0 dB) and as ratio for peak (e.g., 0.501187)
                Metadata: {
                  '@replaygain_track_gain': '-6.0 dB',
                  '@replaygain_track_peak': '0.501187',
                },
              },
            ],
          }),
        }),
    });

    const result = await api.fetchReplayGain('track-1');
    expect(result).toBeDefined();
    expect(result?.trackGain).toBe('-6.0 dB');
    expect(result?.trackPeak).toBe('0.501187');
  });

  it('AC-1: fetchReplayGain returns null when MediaSources has no ReplayGain metadata', async () => {
    const { createApiClient } = await import('./sync-api');

    function makeMockResponse(
      overrides: Partial<Response> & { ok: boolean; status: number; statusText: string },
    ): Response {
      return {
        headers: new Headers(),
        redirected: false,
        type: 'basic',
        url: 'https://jellyfin.example.com/Items/track-1',
        clone: () => ({}) as any,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => '',
        json: async () => ({}),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        bodyUsed: false,
        body: null,
        ...overrides,
      } as unknown as Response;
    }

    const api = createApiClient({
      baseUrl: 'https://jellyfin.example.com',
      apiKey: '0123456789abcdef0123456789abcdef',
      userId: 'abcdef1234567890abcdef1234567890',
      timeout: 5000,
      fetch: async () =>
        makeMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            Id: 'track-1',
            Name: 'Test Track',
            MediaSources: [
              {
                Path: '/music/Artist/Album/track.mp3',
                Container: 'mp3',
                Size: 5000000,
                Bitrate: 320000,
                // No Metadata field — track was never analyzed
              },
            ],
          }),
        }),
    });

    const result = await api.fetchReplayGain('track-1');
    expect(result).toBeNull();
  });

  it('AC-1: fetchReplayGain returns null on HTTP 404', async () => {
    const { createApiClient } = await import('./sync-api');

    function makeMockResponse(
      overrides: Partial<Response> & { ok: boolean; status: number; statusText: string },
    ): Response {
      return {
        headers: new Headers(),
        redirected: false,
        type: 'basic',
        url: 'https://jellyfin.example.com/Items/track-1',
        clone: () => ({}) as any,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => '',
        json: async () => ({}),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        bodyUsed: false,
        body: null,
        ...overrides,
      } as unknown as Response;
    }

    const api = createApiClient({
      baseUrl: 'https://jellyfin.example.com',
      apiKey: '0123456789abcdef0123456789abcdef',
      userId: 'abcdef1234567890abcdef1234567890',
      timeout: 5000,
      fetch: async () =>
        makeMockResponse({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          body: null,
        }),
    });

    const result = await api.fetchReplayGain('track-1');
    expect(result).toBeNull();
  });

  it('AC-1: fetchReplayGain returns null when MediaSources is empty', async () => {
    const { createApiClient } = await import('./sync-api');

    function makeMockResponse(
      overrides: Partial<Response> & { ok: boolean; status: number; statusText: string },
    ): Response {
      return {
        headers: new Headers(),
        redirected: false,
        type: 'basic',
        url: 'https://jellyfin.example.com/Items/track-1',
        clone: () => ({}) as any,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => '',
        json: async () => ({}),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        bodyUsed: false,
        body: null,
        ...overrides,
      } as unknown as Response;
    }

    const api = createApiClient({
      baseUrl: 'https://jellyfin.example.com',
      apiKey: '0123456789abcdef0123456789abcdef',
      userId: 'abcdef1234567890abcdef1234567890',
      timeout: 5000,
      fetch: async () =>
        makeMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            Id: 'track-1',
            Name: 'Test Track',
            MediaSources: [],
          }),
        }),
    });

    const result = await api.fetchReplayGain('track-1');
    expect(result).toBeNull();
  });

  it('AC-1: fetchReplayGain uses user-scoped /Users/{userId}/Items/{itemId}?Fields=MediaSources endpoint', async () => {
    const { createApiClient } = await import('./sync-api');

    function makeMockResponse(
      overrides: Partial<Response> & { ok: boolean; status: number; statusText: string },
    ): Response {
      return {
        headers: new Headers(),
        redirected: false,
        type: 'basic',
        url: 'https://jellyfin.example.com/Users/abcdef1234567890abcdef1234567890/Items/track-1?Fields=MediaSources',
        clone: () => ({}) as any,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => '',
        json: async () => ({}),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        bodyUsed: false,
        body: null,
        ...overrides,
      } as unknown as Response;
    }

    const userId = 'abcdef1234567890abcdef1234567890';
    const itemId = 'track-1';
    const expectedUrl = `https://jellyfin.example.com/Users/${userId}/Items/${itemId}?Fields=MediaSources`;
    let capturedUrl = '';

    const api = createApiClient({
      baseUrl: 'https://jellyfin.example.com',
      apiKey: '0123456789abcdef0123456789abcdef',
      userId,
      timeout: 5000,
      fetch: async (input) => {
        capturedUrl = typeof input === 'string' ? input : input.toString();
        return makeMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            Id: itemId,
            Name: 'Test Track',
            MediaSources: [
              {
                Path: '/music/Artist/Album/track.mp3',
                Container: 'mp3',
                Metadata: {
                  '@replaygain_track_gain': '-6.0 dB',
                  '@replaygain_track_peak': '0.501187',
                },
              },
            ],
          }),
        });
      },
    });

    await api.fetchReplayGain(itemId);

    // The URL must include the userId and request MediaSources fields
    expect(capturedUrl).toBe(expectedUrl);
    expect(capturedUrl).toContain(`/Users/${userId}/Items/${itemId}`);
    expect(capturedUrl).toContain('Fields=MediaSources');
    // It must NOT use the admin-only /Items/{itemId} endpoint
    expect(capturedUrl).not.toMatch(/\/Items\/[^?]*$/);
  });
});

// ─── AC-2: FFmpeg embeds ReplayGain tags by format ───────────────────────────

describe('embedReplayGain FFmpeg integration', () => {
  it('AC-2: embedReplayGain for MP3 writes REPLAYGAIN_TRACK_GAIN and REPLAYGAIN_TRACK_PEAK via -metadata', async () => {
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
      await converter.embedReplayGain(
        '/input.mp3',
        '/output.mp3',
        { trackGain: '-6.0 dB', trackPeak: '0.501187' },
        'mp3',
      );

      const ffmpegCall = spawnArgs.find(
        (args) => args.includes('-i') && args.includes('/input.mp3'),
      );
      expect(ffmpegCall).toBeDefined();

      // Verify REPLAYGAIN_TRACK_GAIN tag
      const gainArg = ffmpegCall!.find((arg) => arg.startsWith('REPLAYGAIN_TRACK_GAIN='));
      expect(gainArg).toBeDefined();
      expect(gainArg).toBe('REPLAYGAIN_TRACK_GAIN=-6.0 dB');

      // Verify REPLAYGAIN_TRACK_PEAK tag
      const peakArg = ffmpegCall!.find((arg) => arg.startsWith('REPLAYGAIN_TRACK_PEAK='));
      expect(peakArg).toBeDefined();
      expect(peakArg).toBe('REPLAYGAIN_TRACK_PEAK=0.501187');
    } finally {
      childProcess.spawn = originalSpawn;
    }
  });

  it('AC-2: embedReplayGain for FLAC writes REPLAYGAIN_TRACK_GAIN and REPLAYGAIN_TRACK_PEAK via -metadata', async () => {
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
      await converter.embedReplayGain(
        '/input.flac',
        '/output.flac',
        { trackGain: '-3.5 dB', trackPeak: '0.707946' },
        'flac',
      );

      const ffmpegCall = spawnArgs.find(
        (args) => args.includes('-i') && args.includes('/input.flac'),
      );
      expect(ffmpegCall).toBeDefined();

      const gainArg = ffmpegCall!.find((arg) => arg.startsWith('REPLAYGAIN_TRACK_GAIN='));
      expect(gainArg).toBe('REPLAYGAIN_TRACK_GAIN=-3.5 dB');

      const peakArg = ffmpegCall!.find((arg) => arg.startsWith('REPLAYGAIN_TRACK_PEAK='));
      expect(peakArg).toBe('REPLAYGAIN_TRACK_PEAK=0.707946');
    } finally {
      childProcess.spawn = originalSpawn;
    }
  });

  it('AC-2: embedReplayGain for M4A writes REPLAYGAIN_TRACK_GAIN and REPLAYGAIN_TRACK_PEAK via -metadata', async () => {
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
      await converter.embedReplayGain(
        '/input.m4a',
        '/output.m4a',
        { trackGain: '-9.0 dB', trackPeak: '0.251189' },
        'm4a',
      );

      const ffmpegCall = spawnArgs.find(
        (args) => args.includes('-i') && args.includes('/input.m4a'),
      );
      expect(ffmpegCall).toBeDefined();

      const gainArg = ffmpegCall!.find((arg) => arg.startsWith('REPLAYGAIN_TRACK_GAIN='));
      expect(gainArg).toBe('REPLAYGAIN_TRACK_GAIN=-9.0 dB');

      const peakArg = ffmpegCall!.find((arg) => arg.startsWith('REPLAYGAIN_TRACK_PEAK='));
      expect(peakArg).toBe('REPLAYGAIN_TRACK_PEAK=0.251189');
    } finally {
      childProcess.spawn = originalSpawn;
    }
  });

  it('AC-2: embedReplayGain uses temp file when inputPath === outputPath', async () => {
    const { createFFmpegConverter } = await import('./sync-files');
    const converter = createFFmpegConverter();

    const childProcess = require('child_process');
    const spawnCalls: { args: string[] }[] = [];
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = function (_cmd: string, args: string[], _opts: any) {
      spawnCalls.push({ args });
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

    const fs = require('fs');
    const os = require('os');
    const tmpInput = `${os.tmpdir()}/jt-test-replaygain-${Date.now()}.mp3`;
    fs.writeFileSync(tmpInput, Buffer.from('fake mp3 data'));

    try {
      await converter.embedReplayGain(
        tmpInput,
        tmpInput,
        { trackGain: '-6.0 dB', trackPeak: '0.501187' },
        'mp3',
      );

      const lastCall = spawnCalls[spawnCalls.length - 1];
      const outputArg = lastCall.args[lastCall.args.length - 1];

      // Output should be a temp file, not the same as input
      expect(outputArg).toMatch(/^.*jt-replaygain-.*\.mp3$/);
      expect(outputArg).not.toBe(tmpInput);
    } finally {
      childProcess.spawn = originalSpawn;
      try {
        fs.unlinkSync(tmpInput);
      } catch {
        /* ignore */
      }
    }
  });

  it('AC-2: mock converter supports embedReplayGain', async () => {
    const mock = createMockConverter();
    const result = await mock.embedReplayGain?.(
      '/input.mp3',
      '/output.mp3',
      { trackGain: '-6.0 dB', trackPeak: '0.501187' },
      'mp3',
    );
    expect(result?.success).toBe(true);
  });
});

// ─── AC-3: Silent skip when no ReplayGain data ────────────────────────────────

describe('AC-3: silent skip when no ReplayGain data', () => {
  function makeTrack(overrides?: Partial<TrackInfo>): TrackInfo {
    return {
      id: 'track-replaygain-1',
      name: 'Track',
      album: 'Album',
      artists: ['Artist'],
      path: '/music/lib/lib/Artist/Album/track.mp3',
      format: 'mp3',
      size: 5_000_000,
      ...overrides,
    };
  }

  it('AC-3: sync completes without error when fetchReplayGain returns null', async () => {
    const mockApi = createMockApiClient();
    const fetchReplayGainSpy = vi.fn().mockResolvedValue(null);
    mockApi.fetchReplayGain = fetchReplayGainSpy;
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({
      tracks: [makeTrack()],
      errors: [],
    });
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
      options: {},
    });

    // Sync completes successfully — no error about missing ReplayGain
    expect(result.success).toBe(true);
    // fetchReplayGain was called (feature is active)
    expect(fetchReplayGainSpy).toHaveBeenCalledWith('track-replaygain-1');
  });

  it('AC-3: embedReplayGain is NOT called when fetchReplayGain returns null', async () => {
    const mockApi = createMockApiClient();
    mockApi.fetchReplayGain = vi.fn().mockResolvedValue(null);
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({
      tracks: [makeTrack()],
      errors: [],
    });
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from('fake audio'));
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const embedReplayGainSpy = vi.fn().mockResolvedValue({ success: true });
    const mockConverter = createMockConverter();
    mockConverter.embedReplayGain = embedReplayGainSpy;

    const deps = createTestDeps({ api: mockApi, converter: mockConverter });
    const core = createTestSyncCore(validConfig, deps);

    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: {},
    });

    // embedReplayGain should NOT be called when there's no ReplayGain data
    expect(embedReplayGainSpy).not.toHaveBeenCalled();
  });

  it('AC-3: embedReplayGain IS called when fetchReplayGain returns data', async () => {
    const mockApi = createMockApiClient();
    mockApi.fetchReplayGain = vi.fn().mockResolvedValue({
      trackGain: '-6.0 dB',
      trackPeak: '0.501187',
    });
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({
      tracks: [makeTrack()],
      errors: [],
    });
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(Buffer.from('fake audio'));
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const embedReplayGainSpy = vi.fn().mockResolvedValue({ success: true });
    const mockConverter = createMockConverter();
    mockConverter.embedReplayGain = embedReplayGainSpy;

    const deps = createTestDeps({ api: mockApi, converter: mockConverter });
    const core = createTestSyncCore(validConfig, deps);

    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: {},
    });

    // embedReplayGain SHOULD be called with the ReplayGain data
    expect(embedReplayGainSpy).toHaveBeenCalledOnce();
    const [, , replayGainData] = embedReplayGainSpy.mock.calls[0];
    expect(replayGainData).toEqual({ trackGain: '-6.0 dB', trackPeak: '0.501187' });
  });
});

// ─── AC-4: Unit tests cover Jellyfin → ReplayGain mapping per format ───────────

describe('AC-4: Jellyfin → ReplayGain mapping by format', () => {
  it('AC-4: ReplayGain data flows from API fetch to track object', async () => {
    const { createApiClient } = await import('./sync-api');

    function makeMockResponse(
      overrides: Partial<Response> & { ok: boolean; status: number; statusText: string },
    ): Response {
      return {
        headers: new Headers(),
        redirected: false,
        type: 'basic',
        url: 'https://jellyfin.example.com/Items/track-1',
        clone: () => ({}) as any,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => '',
        json: async () => ({}),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        bodyUsed: false,
        body: null,
        ...overrides,
      } as unknown as Response;
    }

    const api = createApiClient({
      baseUrl: 'https://jellyfin.example.com',
      apiKey: '0123456789abcdef0123456789abcdef',
      userId: 'abcdef1234567890abcdef1234567890',
      timeout: 5000,
      fetch: async () =>
        makeMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            Id: 'track-1',
            Name: 'Test Track',
            MediaSources: [
              {
                Path: '/music/Artist/Album/track.flac',
                Container: 'flac',
                Size: 30_000_000,
                Bitrate: 1411000,
                Metadata: {
                  '@replaygain_track_gain': '-4.2 dB',
                  '@replaygain_track_peak': '0.630957',
                },
              },
            ],
          }),
        }),
    });

    const result = await api.fetchReplayGain('track-1');
    expect(result).toEqual({
      trackGain: '-4.2 dB',
      trackPeak: '0.630957',
    });
  });

  it('AC-4: ReplayGain data parsed correctly for FLAC format', async () => {
    const { createApiClient } = await import('./sync-api');

    function makeMockResponse(
      overrides: Partial<Response> & { ok: boolean; status: number; statusText: string },
    ): Response {
      return {
        headers: new Headers(),
        redirected: false,
        type: 'basic',
        url: 'https://jellyfin.example.com/Items/track-flac',
        clone: () => ({}) as any,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => '',
        json: async () => ({}),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        bodyUsed: false,
        body: null,
        ...overrides,
      } as unknown as Response;
    }

    const api = createApiClient({
      baseUrl: 'https://jellyfin.example.com',
      apiKey: '0123456789abcdef0123456789abcdef',
      userId: 'abcdef1234567890abcdef1234567890',
      timeout: 5000,
      fetch: async () =>
        makeMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            Id: 'track-flac',
            Name: 'FLAC Track',
            MediaSources: [
              {
                Path: '/music/Artist/Album/track.flac',
                Container: 'flac',
                Metadata: {
                  '@replaygain_track_gain': '-8.0 dB',
                  '@replaygain_track_peak': '0.398107',
                },
              },
            ],
          }),
        }),
    });

    const result = await api.fetchReplayGain('track-flac');
    expect(result).toEqual({
      trackGain: '-8.0 dB',
      trackPeak: '0.398107',
    });
  });

  it('AC-4: ReplayGain data parsed correctly for M4A format', async () => {
    const { createApiClient } = await import('./sync-api');

    function makeMockResponse(
      overrides: Partial<Response> & { ok: boolean; status: number; statusText: string },
    ): Response {
      return {
        headers: new Headers(),
        redirected: false,
        type: 'basic',
        url: 'https://jellyfin.example.com/Items/track-m4a',
        clone: () => ({}) as any,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => '',
        json: async () => ({}),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        bodyUsed: false,
        body: null,
        ...overrides,
      } as unknown as Response;
    }

    const api = createApiClient({
      baseUrl: 'https://jellyfin.example.com',
      apiKey: '0123456789abcdef0123456789abcdef',
      userId: 'abcdef1234567890abcdef1234567890',
      timeout: 5000,
      fetch: async () =>
        makeMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            Id: 'track-m4a',
            Name: 'M4A Track',
            MediaSources: [
              {
                Path: '/music/Artist/Album/track.m4a',
                Container: 'm4a',
                Metadata: {
                  '@replaygain_track_gain': '-12.0 dB',
                  '@replaygain_track_peak': '0.251189',
                },
              },
            ],
          }),
        }),
    });

    const result = await api.fetchReplayGain('track-m4a');
    expect(result).toEqual({
      trackGain: '-12.0 dB',
      trackPeak: '0.251189',
    });
  });
});
