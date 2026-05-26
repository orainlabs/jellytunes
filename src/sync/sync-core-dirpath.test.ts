/**
 * dirPath extraction regression test (ORAIN-0390)
 *
 * Tests that buildStaleCoverPaths uses path.dirname() instead of
 * lastIndexOf('/') to extract the directory from a track path.
 *
 * The old brittle approach:
 *   destPath.substring(0, destPath.lastIndexOf('/'))
 *
 * If destPath contains no '/', lastIndexOf returns -1 and
 * substring(0, -1) returns '' (empty string), making cover.jpg
 * a relative path that resolves to the CWD — silently corrupting cleanup.
 *
 * The fix: path.dirname() handles this case correctly and is cross-platform.
 */
import { describe, it, expect } from 'vitest';
import type { SyncConfig } from './types';
import type { SyncDependencies } from './sync-core';
import { createSyncCore } from './sync-core';
import { createMockApiClient } from './sync-api';
import { createMockFileSystem } from './sync-files';
import { createMockConverter } from './sync-files';
import type { ItemType } from './types';

// Reuse the same config used across the cleanCoverFilesForNonCompanionMode tests
const configWithServerRoot: SyncConfig = {
  serverUrl: 'https://jellyfin.example.com',
  apiKey: '0123456789abcdef0123456789abcdef',
  userId: 'abcdef1234567890abcdef1234567890',
  serverRootPath: '/music/',
};

describe('ORAIN-0390: dirPath extraction uses path.dirname', () => {
  /**
   * Path with no forward slash (edge case that trips lastIndexOf).
   * On Unix this would be a bare filename not a path — we model what would
   * happen if lastIndexOf returned -1 and substring(0,-1) collapsed to ''.
   *
   * cover.jpg would resolve relative to CWD instead of the intended dir.
   * With path.dirname() it is handled correctly.
   */
  it('resolves cover path correctly when track basename has no slashes (AC-E1)', async () => {
    const mockFs = createMockFileSystem() as any;

    // Simulate a destPath that would have collapsed with lastIndexOf.
    // path.dirname('track.mp3') → '.' (current dir) NOT ''
    // We need to confirm that when dirname returns '.' we still form a
    // valid relative cover path, rather than an empty-string failure.
    mockFs.__setFile('./track.mp3', Buffer.alloc(100));
    mockFs.__setFile('./cover.jpg', Buffer.alloc(5000));

    const mockApi = createMockApiClient({
      getTracksForItems: async () => ({
        tracks: [
          {
            id: 'track-1',
            name: 'Track',
            album: 'Album',
            artists: ['Artist'],
            // server path still has structure so serverRootPath logic works
            path: '/music/Artist/Album/track.mp3',
            format: 'mp3',
            parentItemId: 'album-1',
          },
        ],
        errors: [],
      }),
    });

    // DB record with companion mode — sync will try to clean stale cover
    const mockDb = {
      getSyncedTracksForDevice: (_mountPoint: string) => [
        {
          id: 1,
          deviceId: 1,
          itemId: 'album-1',
          trackId: 'track-1',
          // Use a path whose dirname is '.' — the old lastIndexOf approach
          // would have produced '' instead of '.'
          destinationPath: 'track.mp3',
          fileSize: 100,
          metadataHash: null,
          coverArtMode: 'companion' as const,
          encodedBitrate: '192k',
          serverPath: '/music/Artist/Album/track.mp3',
          serverRootPath: '/music/',
          syncedAt: new Date().toISOString(),
        },
      ],
    };

    const deps: SyncDependencies = {
      api: mockApi,
      fs: mockFs,
      converter: createMockConverter(),
      db: mockDb as any,
    };

    const core = createSyncCore(configWithServerRoot, deps);

    // Switch to embed — should attempt to clean stale companion cover
    // With the old brittle code, dirPath = '' and the cleanup path
    // resolves incorrectly. With path.dirname(), dirname('track.mp3') = '.'
    // and the constructed path is './cover.jpg' which the mock FS resolves.
    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/mnt/usb',
      options: { coverArtMode: 'embed' },
    });

    // cover.jpg must be removed even when destinationPath has no slashes
    // (no spurious error, no incorrect relative path resolution)
    expect(mockFs.__getFile('./cover.jpg')).toBeUndefined();
  });

  /**
   * path.dirname normalizes the output — 'foo/bar' → 'foo', 'x/y/z' → 'x/y'.
   * Verify that directory extraction is consistent for nested paths.
   */
  it('resolves cover path correctly for deeply nested destPath (AC-E2)', async () => {
    const mockFs = createMockFileSystem() as any;

    mockFs.__setFile('/mnt/usb/Artist/Album/SubDir/track.mp3', Buffer.alloc(100));
    mockFs.__setFile('/mnt/usb/Artist/Album/SubDir/cover.jpg', Buffer.alloc(5000));

    const mockApi = createMockApiClient({
      getTracksForItems: async () => ({
        tracks: [
          {
            id: 'track-1',
            name: 'Track',
            album: 'Album',
            artists: ['Artist'],
            path: '/music/Artist/Album/track.mp3',
            format: 'mp3',
            parentItemId: 'album-1',
          },
        ],
        errors: [],
      }),
    });

    const mockDb = {
      getSyncedTracksForDevice: (_mountPoint: string) => [
        {
          id: 1,
          deviceId: 1,
          itemId: 'album-1',
          trackId: 'track-1',
          destinationPath: '/mnt/usb/Artist/Album/SubDir/track.mp3',
          fileSize: 100,
          metadataHash: null,
          coverArtMode: 'companion' as const,
          encodedBitrate: '192k',
          serverPath: '/music/Artist/Album/track.mp3',
          serverRootPath: '/music/',
          syncedAt: new Date().toISOString(),
        },
      ],
    };

    const deps: SyncDependencies = {
      api: mockApi,
      fs: mockFs,
      converter: createMockConverter(),
      db: mockDb as any,
    };

    const core = createSyncCore(configWithServerRoot, deps);

    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map([['album-1', 'album' as ItemType]]),
      destinationPath: '/mnt/usb',
      options: { coverArtMode: 'embed' },
    });

    // cover.jpg in the correct nested directory must be removed
    expect(mockFs.__getFile('/mnt/usb/Artist/Album/SubDir/cover.jpg')).toBeUndefined();
  });
});
