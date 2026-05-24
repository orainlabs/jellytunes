/**
 * Tests for artist and albumArtist metadata tagging.
 * Verifies AC: "Tests unitarios cubren el mapeo Jellyfin → tags por formato"
 *
 * Tests cover:
 * 1. albumArtist field flows from Jellyfin API through to converter metadata
 * 2. Metadata hash computation includes albumArtist
 * 3. Conditional writing: albumArtist only written when present
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSyncCore, type SyncDependencies } from './sync-core';
import { createMockApiClient } from './sync-api';
import { createMockFileSystem, type AudioConverter } from './sync-files';
import type { SyncConfig, TrackInfo, TrackMetadata, ItemType } from './types';

// Hoisted mocks for database
const mockUpsertSyncedTrack = vi.hoisted(() => vi.fn());
const mockGetSyncedTracksForDevice = vi.hoisted(() => vi.fn(() => []));

// Mock database module
vi.mock('../main/database', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  upsertSyncedTrack: mockUpsertSyncedTrack,
  getSyncedTracksForDevice: mockGetSyncedTracksForDevice,
  getSyncedTracksForItem: vi.fn(() => []),
  getSyncedItems: vi.fn(() => []),
  removeSyncedTracksForItem: vi.fn(),
  removeSyncedTrack: vi.fn(),
}));

// Helper to create converter with spying
function createConverterWithSpy(overrides: Partial<AudioConverter> = {}): AudioConverter {
  return {
    convertToMp3: vi.fn().mockResolvedValue({ success: true }),
    convertStreamToMp3: vi.fn().mockResolvedValue({ success: true }),
    convertStreamToMp3WithMeta: vi.fn().mockResolvedValue({ success: true }),
    tagFile: vi.fn().mockResolvedValue({ success: true }),
    readFileMetadata: vi.fn().mockResolvedValue({}),
    isAvailable: vi.fn().mockResolvedValue(true),
    embedLyrics: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

describe('Artist and AlbumArtist metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSyncedTracksForDevice.mockReturnValue([]);
    mockUpsertSyncedTrack.mockResolvedValue(undefined);
  });

  const validConfig: SyncConfig = {
    serverUrl: 'https://jellyfin.example.com',
    apiKey: '0123456789abcdef0123456789abcdef',
    userId: 'abcdef1234567890abcdef1234567890',
  };

  function makeTrack(overrides: Partial<TrackInfo> = {}): TrackInfo {
    return {
      id: 'track-1',
      name: 'Track One',
      album: 'Album One',
      artists: ['Artist'],
      path: '/music/Artist/Album/track.mp3',
      format: 'mp3',
      size: 5_000_000,
      bitrate: 320_000, // 320 kbps - above 192k target so conversion is needed
      trackNumber: 1,
      ...overrides,
    };
  }

  describe('albumArtist field flow to converter', () => {
    it('passes albumArtist to convertStreamToMp3WithMeta when present', async () => {
      const convertStreamToMp3WithMetaSpy = vi.fn().mockResolvedValue({ success: true });

      const track = makeTrack({
        albumArtist: 'Album Artist Name',
      });

      const deps: SyncDependencies = {
        api: createMockApiClient({
          getTracksForItems: async () => ({ tracks: [track], errors: [] }),
        }),
        fs: createMockFileSystem(),
        converter: createConverterWithSpy({
          convertStreamToMp3WithMeta: convertStreamToMp3WithMetaSpy,
        }),
      };

      const core = createSyncCore(validConfig, deps);

      await core.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/usb',
        options: { convertToMp3: true, bitrate: '192k' },
      });

      // Verify convertStreamToMp3WithMeta was called
      expect(convertStreamToMp3WithMetaSpy).toHaveBeenCalled();

      // Extract the metadata argument (4th parameter: input, output, bitrate, metadata, cover)
      const callArgs = convertStreamToMp3WithMetaSpy.mock.calls[0];
      const metadata: TrackMetadata = callArgs[3];

      // Verify albumArtist is present and correct
      expect(metadata.albumArtist).toBe('Album Artist Name');
    });

    it('passes only artist to convertStreamToMp3WithMeta when albumArtist is undefined', async () => {
      const convertStreamToMp3WithMetaSpy = vi.fn().mockResolvedValue({ success: true });

      const track = makeTrack({
        // albumArtist not set
        artists: ['Track Artist'],
      });

      const deps: SyncDependencies = {
        api: createMockApiClient({
          getTracksForItems: async () => ({ tracks: [track], errors: [] }),
        }),
        fs: createMockFileSystem(),
        converter: createConverterWithSpy({
          convertStreamToMp3WithMeta: convertStreamToMp3WithMetaSpy,
        }),
      };

      const core = createSyncCore(validConfig, deps);

      await core.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/usb',
        options: { convertToMp3: true, bitrate: '192k' },
      });

      expect(convertStreamToMp3WithMetaSpy).toHaveBeenCalled();

      const callArgs = convertStreamToMp3WithMetaSpy.mock.calls[0];
      const metadata: TrackMetadata = callArgs[3];

      // albumArtist should be undefined when not provided by Jellyfin
      expect(metadata.albumArtist ?? undefined).toBeUndefined();
    });

    it('passes artist and albumArtist to tagFile for non-MP3 formats', async () => {
      const tagFileSpy = vi.fn().mockResolvedValue({ success: true });

      const track = makeTrack({
        id: 'flac-track',
        format: 'flac',
        path: '/music/Artist/Album/track.flac',
        albumArtist: 'Album Artist Name',
      });

      const deps: SyncDependencies = {
        api: createMockApiClient({
          getTracksForItems: async () => ({ tracks: [track], errors: [] }),
        }),
        fs: createMockFileSystem(),
        converter: createConverterWithSpy({
          tagFile: tagFileSpy,
        }),
      };

      const core = createSyncCore(validConfig, deps);

      await core.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/usb',
        options: { convertToMp3: false }, // Don't convert, just copy and tag
      });

      expect(tagFileSpy).toHaveBeenCalled();

      const callArgs = tagFileSpy.mock.calls[0];
      const metadata: TrackMetadata = callArgs[2];

      expect(metadata.artist).toBe('Artist');
      expect(metadata.albumArtist).toBe('Album Artist Name');
    });
  });

  describe('conditional albumArtist writing', () => {
    it('does not write albumArtist when empty string', async () => {
      const tagFileSpy = vi.fn().mockResolvedValue({ success: true });

      const track = makeTrack({
        albumArtist: '',
      });

      const deps: SyncDependencies = {
        api: createMockApiClient({
          getTracksForItems: async () => ({ tracks: [track], errors: [] }),
        }),
        fs: createMockFileSystem(),
        converter: createConverterWithSpy({
          tagFile: tagFileSpy,
        }),
      };

      const core = createSyncCore(validConfig, deps);

      await core.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/usb',
        options: { convertToMp3: false },
      });

      expect(tagFileSpy).toHaveBeenCalled();
      const callArgs = tagFileSpy.mock.calls[0];
      const metadata: TrackMetadata = callArgs[2];

      // Empty string is falsy - should not be present in metadata
      expect(metadata.albumArtist ?? undefined).toBeUndefined();
    });
  });

  describe('metadata hash includes albumArtist', () => {
    it('produces different hash when albumArtist differs', async () => {
      const track1 = makeTrack({ albumArtist: 'Album Artist A' });
      const track2 = makeTrack({ albumArtist: 'Album Artist B' });

      // Mock existing synced records
      mockGetSyncedTracksForDevice
        .mockResolvedValueOnce([]) // First sync call
        .mockResolvedValueOnce([]); // Second sync call

      const deps1: SyncDependencies = {
        api: createMockApiClient({
          getTracksForItems: async () => ({ tracks: [track1], errors: [] }),
        }),
        fs: createMockFileSystem(),
        converter: createConverterWithSpy(),
      };

      const deps2: SyncDependencies = {
        api: createMockApiClient({
          getTracksForItems: async () => ({ tracks: [track2], errors: [] }),
        }),
        fs: createMockFileSystem(),
        converter: createConverterWithSpy(),
      };

      const core1 = createSyncCore(validConfig, deps1);
      const core2 = createSyncCore(validConfig, deps2);

      await core1.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/usb',
        options: { convertToMp3: false },
      });

      await core2.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/usb',
        options: { convertToMp3: false },
      });

      // Get metadataHash from upsertSyncedTrack calls
      const calls = mockUpsertSyncedTrack.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);

      const hash1 = calls[0][5]; // metadataHash is 6th parameter
      const hash2 = calls[1][5];

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('artist vs albumArtist distinction', () => {
    it('passes both artist (track artists) and albumArtist separately', async () => {
      const convertStreamToMp3WithMetaSpy = vi.fn().mockResolvedValue({ success: true });

      const track = makeTrack({
        artists: ['Track Artist 1', 'Track Artist 2'],
        albumArtist: 'Album Artist',
      });

      const deps: SyncDependencies = {
        api: createMockApiClient({
          getTracksForItems: async () => ({ tracks: [track], errors: [] }),
        }),
        fs: createMockFileSystem(),
        converter: createConverterWithSpy({
          convertStreamToMp3WithMeta: convertStreamToMp3WithMetaSpy,
        }),
      };

      const core = createSyncCore(validConfig, deps);

      await core.sync({
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/usb',
        options: { convertToMp3: true, bitrate: '192k' },
      });

      expect(convertStreamToMp3WithMetaSpy).toHaveBeenCalled();
      const callArgs = convertStreamToMp3WithMetaSpy.mock.calls[0];
      const metadata: TrackMetadata = callArgs[3];

      // artist should be track artists joined
      expect(metadata.artist).toBe('Track Artist 1; Track Artist 2');
      // albumArtist should be separate
      expect(metadata.albumArtist).toBe('Album Artist');
    });
  });
});
