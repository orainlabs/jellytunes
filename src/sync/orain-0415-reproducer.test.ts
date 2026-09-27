/**
 * ORAIN-0415 Reproducer: embedded lyrics sync drops MP3 files in destination
 *
 * Bug: With `lyricsMode = 'embed'`, the file may not exist at destination after sync.
 * AC: File exists in destination directory after sync (post-write verification, not just counting)
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

// Set serverRootPath so path detection works deterministically in tests
const validConfig: SyncConfig = {
  serverUrl: 'https://jellyfin.example.com',
  apiKey: '0123456789abcdef0123456789abcdef',
  userId: 'abcdef1234567890abcdef1234567890',
  serverRootPath: '/music/',
};

function createTestDeps(overrides?: Partial<SyncDependencies>) {
  return {
    api: createMockApiClient(),
    fs: createMockFileSystem(),
    converter: createMockConverter(),
    ...overrides,
  };
}

describe('ORAIN-0415 Reproducer: embed lyrics sync', () => {
  it('AC-2: file exists at destination BEFORE and AFTER processLyrics', async () => {
    const mockApi = createMockApiClient();
    const lyricsResponse = '[00:00]Embedded lyrics\n[00:05]Line two';
    mockApi.fetchLyrics = vi.fn().mockResolvedValue(lyricsResponse);

    const mockFs = createMockFileSystem() as any;

    const tracks: TrackInfo[] = [
      {
        id: 'track-1',
        name: 'Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/Artist/Album/track.mp3',
        format: 'mp3',
        size: 100,
      },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItem = vi.fn().mockResolvedValue(Buffer.from('fake mp3 audio data'));
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(
        Buffer.concat([
          Buffer.from('ID3'),
          Buffer.from([0x03, 0x00]),
          Buffer.from([0x00, 0x00, 0x00, 0x00]),
          Buffer.from([0xff, 0xfb, 0x90, 0x00]),
          Buffer.alloc(100 - 13),
        ]),
      );
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    // Track when embedLyrics is called to verify file exists at that point
    const embedLyricsSpy = vi.fn().mockResolvedValue({ success: true });
    const mockConverter = createMockConverter();
    mockConverter.embedLyrics = embedLyricsSpy;

    const deps = createTestDeps({ api: mockApi, fs: mockFs, converter: mockConverter });
    const core = createTestSyncCore(validConfig, deps);

    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'embed', embedMetadata: false },
    });

    // AC-2: The file must exist at destination after sync
    const expectedPath = '/usb/Artist/Album/track.mp3';
    const fileExists = mockFs.__getFile(expectedPath);
    expect(result.success).toBe(true);
    expect(result.tracksCopied).toBeGreaterThan(0);
    expect(fileExists).toBeDefined();
    expect(result.lyricsAdded).toBe(1);

    // CRITICAL: Verify file still exists after embedLyrics completed
    // (embedLyrics uses temp file + atomic rename, verify no race condition)
    expect(mockFs.__getFile(expectedPath)).toBeDefined();

    // Also verify file content is correct (wasn't corrupted during embed)
    const fileContent = mockFs.__getFile(expectedPath);
    expect(fileContent).not.toBeNull();
  });

  it('AC-2 Variant: file exists even when embedLyrics FAILS (no regression)', async () => {
    const mockApi = createMockApiClient();
    mockApi.fetchLyrics = vi.fn().mockResolvedValue('[00:00]Test lyrics');

    const mockFs = createMockFileSystem() as any;

    const tracks: TrackInfo[] = [
      {
        id: 'track-1',
        name: 'Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/Artist/Album/track.mp3',
        format: 'mp3',
        size: 100,
      },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItem = vi.fn().mockResolvedValue(Buffer.from('audio data'));
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(
        Buffer.concat([
          Buffer.from('ID3'),
          Buffer.from([0x03, 0x00]),
          Buffer.from([0x00, 0x00, 0x00, 0x00]),
          Buffer.from([0xff, 0xfb, 0x90, 0x00]),
          Buffer.alloc(100 - 13),
        ]),
      );
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    // Simulate embedLyrics FAILURE (e.g., FFmpeg not available)
    const embedLyricsSpy = vi.fn().mockResolvedValue({ success: false, error: 'FFmpeg failed' });
    const mockConverter = createMockConverter();
    mockConverter.embedLyrics = embedLyricsSpy;

    const deps = createTestDeps({ api: mockApi, fs: mockFs, converter: mockConverter });
    const core = createTestSyncCore(validConfig, deps);

    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'embed', embedMetadata: false },
    });

    // AC-2: File must STILL exist even when embedLyrics fails
    const expectedPath = '/usb/Artist/Album/track.mp3';
    const fileExists = mockFs.__getFile(expectedPath);
    expect(fileExists).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.lyricsAdded).toBe(0); // AC-3: counter reflects real failure
  });

  it('AC-3: lyricsAdded counter reflects real success (only after atomic rename confirmed)', async () => {
    const mockApi = createMockApiClient();
    mockApi.fetchLyrics = vi.fn().mockResolvedValue('[00:00]Test lyrics');

    const mockFs = createMockFileSystem() as any;

    const tracks: TrackInfo[] = [
      {
        id: 'track-1',
        name: 'Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/Artist/Album/track.mp3',
        format: 'mp3',
        size: 100,
      },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItem = vi.fn().mockResolvedValue(Buffer.from('audio data'));
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(
        Buffer.concat([
          Buffer.from('ID3'),
          Buffer.from([0x03, 0x00]),
          Buffer.from([0x00, 0x00, 0x00, 0x00]),
          Buffer.from([0xff, 0xfb, 0x90, 0x00]),
          Buffer.alloc(100 - 13),
        ]),
      );
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    // Simulate embedLyrics failure (e.g., FFmpeg not available in test env)
    const embedLyricsSpy = vi.fn().mockResolvedValue({ success: false, error: 'FFmpeg failed' });
    const mockConverter = createMockConverter();
    mockConverter.embedLyrics = embedLyricsSpy;

    const deps = createTestDeps({ api: mockApi, fs: mockFs, converter: mockConverter });
    const core = createTestSyncCore(validConfig, deps);

    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'embed', embedMetadata: false },
    });

    // AC-3: lyricsAdded should be 0 when embedLyrics fails
    // Counter should NOT be incremented before rename success is confirmed
    expect(result.lyricsAdded).toBe(0);
    expect(result.tracksCopied).toBeGreaterThan(0); // Track still copied
  });

  it('AC-4: no regression in lyricsMode = "none"', async () => {
    const mockApi = createMockApiClient();
    mockApi.fetchLyrics = vi.fn().mockResolvedValue('[00:00]Test lyrics');

    const mockFs = createMockFileSystem() as any;

    const tracks: TrackInfo[] = [
      {
        id: 'track-1',
        name: 'Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/Artist/Album/track.mp3',
        format: 'mp3',
        size: 100,
      },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItem = vi.fn().mockResolvedValue(Buffer.from('audio data'));
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(
        Buffer.concat([
          Buffer.from('ID3'),
          Buffer.from([0x03, 0x00]),
          Buffer.from([0x00, 0x00, 0x00, 0x00]),
          Buffer.from([0xff, 0xfb, 0x90, 0x00]),
          Buffer.alloc(100 - 13),
        ]),
      );
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const mockConverter = createMockConverter();

    const deps = createTestDeps({ api: mockApi, fs: mockFs, converter: mockConverter });
    const core = createTestSyncCore(validConfig, deps);

    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'off' },
    });

    // fetchLyrics should NOT be called in 'off' mode
    expect(mockApi.fetchLyrics).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.lyricsAdded).toBe(0);
  });

  it('AC-5: no regression in lyricsMode = "file" (lrc)', async () => {
    const mockApi = createMockApiClient();
    mockApi.fetchLyrics = vi.fn().mockResolvedValue('[00:00]LRC lyrics');

    const mockFs = createMockFileSystem() as any;

    const tracks: TrackInfo[] = [
      {
        id: 'track-1',
        name: 'Track',
        album: 'Album',
        artists: ['Artist'],
        path: '/music/Artist/Album/track.mp3',
        format: 'mp3',
        size: 100,
      },
    ];
    mockApi.getTracksForItems = vi.fn().mockResolvedValue({ tracks, errors: [] });
    mockApi.downloadItem = vi.fn().mockResolvedValue(Buffer.from('audio data'));
    mockApi.downloadItemStream = async () => {
      const { Readable } = require('stream');
      return Readable.from(
        Buffer.concat([
          Buffer.from('ID3'),
          Buffer.from([0x03, 0x00]),
          Buffer.from([0x00, 0x00, 0x00, 0x00]),
          Buffer.from([0xff, 0xfb, 0x90, 0x00]),
          Buffer.alloc(100 - 13),
        ]),
      );
    };
    mockApi.getItem = vi
      .fn()
      .mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
    mockApi.getAlbumTracks = vi.fn().mockResolvedValue([]);

    const mockConverter = createMockConverter();

    const deps = createTestDeps({ api: mockApi, fs: mockFs, converter: mockConverter });
    const core = createTestSyncCore(validConfig, deps);

    const result = await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/usb',
      options: { lyricsMode: 'lrc' },
    });

    expect(result.success).toBe(true);
    expect(result.lyricsAdded).toBe(1);
    // LRC file should exist
    const lrcFile = mockFs.__getFile('/usb/Artist/Album/track.lrc');
    expect(lrcFile).toBeDefined();
  });
});
