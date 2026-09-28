/**
 * ORAIN-0740 — cycle 2 (MEDIUM) regression: paths in debug/warn log lines
 * emitted by sync-core.ts MUST NOT contain the user's home directory.
 *
 * AC5 in the spec is explicit: "No line contains the user's home directory;
 * every path under the home is written as `~/…`". The cycle-2
 * remediation missed 16 sites in sync-core.ts that interpolate file
 * paths into log messages without scrubbing. Two of those sites use
 * `log.warn` and are emitted at the default info level; the rest are
 * `log.debug` and only appear with verbose logging — but a user pasting
 * a verbose log into a public issue is in scope per the spec.
 *
 * Strategy: drive a sync that fires at least one of the path-bearing
 * debug sites — the lyrics embed success path at sync-core.ts:2916
 * (`Lyrics embedded in: ${outputPath}`) — with a destination under the
 * mocked `os.homedir()`. Capture every debug line; assert the outputPath
 * is rendered as `~/...`, not the home directory literal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import { Readable } from 'node:stream';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof os>('node:os');
  return { ...actual, homedir: vi.fn() };
});

import { createTestSyncCore, type SyncDependencies } from './sync-core';
import type { SyncLogger, TrackInfo, ItemType } from './types';
import { createMockApiClient } from './sync-api';
import { createMockFileSystem, createMockConverter } from './sync-files';

const mockGetSyncedTracksForItem = vi.hoisted(() => vi.fn(() => []));
const mockGetSyncedItems = vi.hoisted(() =>
  vi.fn<() => Array<{ id: string; name: string; type: string }>>(() => []),
);

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

const FAKE_HOME = '/Users/alice';
const FAKE_DEST = `${FAKE_HOME}/Music/USB`;

beforeEach(() => {
  vi.mocked(os.homedir).mockReturnValue(FAKE_HOME);
  mockGetSyncedTracksForItem.mockReset();
  mockGetSyncedTracksForItem.mockReturnValue([]);
  mockGetSyncedItems.mockReset();
  mockGetSyncedItems.mockReturnValue([]);
});

const FAKE_MP3 = Buffer.concat([
  Buffer.from('ID3'),
  Buffer.from([0x03, 0x00]),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0xff, 0xfb, 0x90, 0x00]),
  Buffer.alloc(1024),
]);

function makeCapturingLogger() {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  const debug: string[] = [];
  const trackFailed: string[] = [];
  const logger: SyncLogger = {
    info: (m) => info.push(m),
    warn: (m) => warn.push(m),
    error: (m) => error.push(m),
    debug: (m) => debug.push(m),
    trackFailed: (m) => trackFailed.push(m),
  };
  return { logger, info, warn, error, debug, trackFailed };
}

function makeDepsWithSuccessfulEmbedLyrics(): SyncDependencies {
  const api = createMockApiClient();
  const tracks: TrackInfo[] = [
    {
      id: 'track-1',
      name: 'Track',
      album: 'Album',
      artists: ['Artist'],
      path: '/music/lib/Artist/Album/track.mp3',
      format: 'mp3',
      size: 100,
    },
  ];
  api.getTracksForItems = vi.fn(async () => ({ tracks, errors: [] }));
  api.downloadItemStream = async () => Readable.from(Buffer.from(FAKE_MP3));
  // Lyrics fetch returns content + embedLyrics succeeds → debug line at
  // sync-core.ts:2916 ("Lyrics embedded in: ${outputPath}") fires.
  api.fetchLyrics = vi.fn(async () => 'These are the song lyrics\nwith two lines');
  api.fetchReplayGain = vi.fn(async () => null);
  api.getCoverArt = vi.fn(async () => Buffer.alloc(0));
  api.getItem = vi.fn().mockResolvedValue({ id: 'album-1', name: 'Album', type: 'MusicAlbum' });
  api.getAlbumTracks = vi.fn(async () => []);

  const fs = createMockFileSystem();
  fs.isDirectory = async () => true;

  const converter = createMockConverter();
  converter.embedLyrics = vi.fn(async () => ({ success: true }));

  return { api, fs, converter };
}

describe('ORAIN-0740 cycle 2 — debug/warn path scrubbing in sync-core', () => {
  it('Lyrics embedded debug line scrubs outputPath home prefix', async () => {
    const { logger, debug } = makeCapturingLogger();
    const deps = makeDepsWithSuccessfulEmbedLyrics();

    const core = createTestSyncCore(
      {
        serverUrl: 'https://jellyfin.example.com',
        apiKey: '0123456789abcdef0123456789abcdef',
        userId: 'abcdef1234567890abcdef1234567890',
      },
      deps,
    );
    (core as unknown as { log: SyncLogger }).log = logger;

    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map<string, ItemType>([['album-1', 'album']]),
      destinationPath: FAKE_DEST,
      options: { lyricsMode: 'embed', embedMetadata: false },
      syncId: 'home-scrub-embed',
    });

    const embedDebug = debug.filter((m) => m.includes('Lyrics embedded in'));
    expect(embedDebug).toHaveLength(1);
    expect(embedDebug[0], `home leaked into debug line: ${embedDebug[0]}`).not.toContain(FAKE_HOME);
    expect(embedDebug[0]).toMatch(/Lyrics embedded in: ~\//);
  }, 30_000);

  it('no captured debug or warn line across a sync with lyrics embed contains the home directory', async () => {
    const { logger, debug, warn } = makeCapturingLogger();
    const deps = makeDepsWithSuccessfulEmbedLyrics();

    const core = createTestSyncCore(
      {
        serverUrl: 'https://jellyfin.example.com',
        apiKey: '0123456789abcdef0123456789abcdef',
        userId: 'abcdef1234567890abcdef1234567890',
      },
      deps,
    );
    (core as unknown as { log: SyncLogger }).log = logger;

    await core.sync({
      itemIds: ['album-1'],
      itemTypes: new Map<string, ItemType>([['album-1', 'album']]),
      destinationPath: FAKE_DEST,
      options: { lyricsMode: 'embed', embedMetadata: false },
      syncId: 'home-scrub-broad',
    });

    for (const m of [...debug, ...warn]) {
      expect(m, `message contained home: ${m}`).not.toContain(FAKE_HOME);
    }
  }, 30_000);
});
