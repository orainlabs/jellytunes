/**
 * ORAIN-0738 — single output-size estimator shared by storage bar and progress
 *
 * Bug: storage bar and progress bar showed different totals. The storage bar
 * (`estimateSize`) re-derived its own conversion rule and ignored covers; the
 * progress bar (`totalBytesEstimate`) summed `track.size` blindly. Neither
 * reflected the destination size.
 *
 * Fix: a single `estimateOutputBytes(track, options)` per-track function used
 * by both `estimateSize()` and the progress numerator. It calls
 * `needsConversion()` instead of reimplementing it, and adds the bounded
 * cover constant (COVER_MAX_BYTES) once per track in `embed` mode and once
 * per album in `companion` mode. The progress numerator advances for every
 * outcome — copied, converted, skipped, failed — so the bar finishes at the
 * total regardless of what happened to each track.
 */
import { describe, it, expect } from 'vitest';
import type { SyncConfig, TrackInfo, ItemType } from './types';
import { createTestSyncCore, type SyncDependencies } from './sync-core';
import { estimateOutputBytes } from './sync-core';
import { COVER_MAX_BYTES } from './cover-image';
import { createMockApiClient } from './sync-api';
import { createMockFileSystem } from './sync-files';
import { createMockConverter } from './sync-files';

const validConfig: SyncConfig = {
  serverUrl: 'https://jellyfin.example.com',
  apiKey: '0123456789abcdef0123456789abcdef',
  userId: 'abcdef1234567890abcdef1234567890',
};

function createMockDeps(overrides?: Partial<SyncDependencies>): SyncDependencies {
  return {
    api: createMockApiClient({
      getTracksForItems: async () => ({ tracks: [], errors: [] }),
    }),
    fs: createMockFileSystem(),
    converter: createMockConverter(),
    ...overrides,
  };
}

// =============================================================================
// Unit-level: estimateOutputBytes (the pure estimator)
// =============================================================================

describe('ORAIN-0738 — estimateOutputBytes (single per-track estimator)', () => {
  const baseOpts = {
    convertToMp3: false,
    bitrate: '192k' as const,
    targetBitrateKbps: 192,
    coverArtMode: 'off' as const,
    addCover: false,
  };

  it('returns track.size for an MP3 when no conversion is requested', () => {
    const result = estimateOutputBytes(
      { format: 'mp3', size: 5_000_000, bitrate: 320_000 },
      baseOpts,
    );
    expect(result).toBe(5_000_000);
  });

  it('estimates MP3→MP3 320k→128k as 128/320 of the source audio (AC3, ±10%)', () => {
    // AC3: ratio 128/320 = 0.4 of the audio bytes.
    const result = estimateOutputBytes(
      { format: 'mp3', size: 10_000_000, bitrate: 320_000 },
      { ...baseOpts, convertToMp3: true, targetBitrateKbps: 128 },
    );
    expect(result).toBeGreaterThanOrEqual(3_600_000);
    expect(result).toBeLessThanOrEqual(4_400_000);
  });

  it('estimates a FLAC track as MP3 using needsConversion() (non-MP3 always converts)', () => {
    // FLAC at 900 kbps effective fallback. 30 MB × 192/900 ≈ 6.4 MB.
    const result = estimateOutputBytes(
      { format: 'flac', size: 30_000_000 },
      { ...baseOpts, convertToMp3: true, targetBitrateKbps: 192 },
    );
    expect(result).toBeGreaterThanOrEqual(5_760_000);
    expect(result).toBeLessThanOrEqual(7_040_000);
  });

  it('MP3 with unknown bitrate estimates to track.size (no conversion, copy as-is) — AC4', () => {
    // AC4: "un MP3 sin track.bitrate se estima a tamaño original, igual que
    // el sync lo copia". needsConversion() returns false for MP3 with no
    // bitrate, so the estimator must NOT divide by targetBitrateKbps.
    const result = estimateOutputBytes(
      { format: 'mp3', size: 5_000_000 /* no bitrate */ },
      { ...baseOpts, convertToMp3: true, targetBitrateKbps: 128 },
    );
    expect(result).toBe(5_000_000);
  });

  it('MP3 at 192kbps with target 192k does not convert (bitrate not strictly greater) — AC4', () => {
    // needsConversion() requires source bitrate STRICTLY greater than target.
    // Equal → no convert → returns track.size unchanged.
    const result = estimateOutputBytes(
      { format: 'mp3', size: 5_000_000, bitrate: 192_000 },
      { ...baseOpts, convertToMp3: true, targetBitrateKbps: 192 },
    );
    expect(result).toBe(5_000_000);
  });

  it('track without size falls back to 0 audio (not NaN)', () => {
    const result = estimateOutputBytes({ format: 'mp3' /* no size, no bitrate */ }, baseOpts);
    expect(result).toBe(0);
  });

  it('adds COVER_MAX_BYTES once per track in embed mode', () => {
    const result = estimateOutputBytes(
      { format: 'mp3', size: 5_000_000, bitrate: 192_000 },
      { ...baseOpts, coverArtMode: 'embed', addCover: true },
    );
    expect(result).toBe(5_000_000 + COVER_MAX_BYTES);
  });

  it('does not add cover when coverArtMode=off even if addCover=true', () => {
    const result = estimateOutputBytes(
      { format: 'mp3', size: 5_000_000 },
      { ...baseOpts, coverArtMode: 'off', addCover: true },
    );
    expect(result).toBe(5_000_000);
  });

  it('adds COVER_MAX_BYTES in companion mode only when the caller says so (per album)', () => {
    // The estimator itself can't know whether THIS track is the first of
    // its album — the caller decides via addCover.
    const withCover = estimateOutputBytes(
      { format: 'mp3', size: 5_000_000 },
      { ...baseOpts, coverArtMode: 'companion', addCover: true },
    );
    expect(withCover).toBe(5_000_000 + COVER_MAX_BYTES);

    const withoutCover = estimateOutputBytes(
      { format: 'mp3', size: 5_000_000 },
      { ...baseOpts, coverArtMode: 'companion', addCover: false },
    );
    expect(withoutCover).toBe(5_000_000);
  });
});

// =============================================================================
// End-to-end through SyncCore: the progress bar must reach the total
// =============================================================================

/** Build a SyncCore with the given tracks and a working mock FS. */
function buildCore(
  tracks: TrackInfo[],
  overrides?: {
    convertToMp3?: boolean;
    downloadThrows?: (id: string) => boolean;
    preExisting?: Array<{ path: string; size: number }>;
    hasCover?: boolean;
  },
) {
  const mockFs = createMockFileSystem();
  for (const t of tracks) {
    if (t.path) (mockFs as any).__setFile(t.path, Buffer.alloc(t.size ?? 0));
  }
  for (const pre of overrides?.preExisting ?? []) {
    (mockFs as any).__setFile(pre.path, Buffer.alloc(pre.size));
  }

  const deps = createMockDeps({
    api: createMockApiClient({
      getTracksForItems: async () => ({ tracks, errors: [] }),
      getCoverArt: async () =>
        // hasCover === false → mock returns an empty buffer to signal "no
        // cover" while keeping the API contract (Promise<Buffer>).
        overrides?.hasCover === false ? Buffer.alloc(0) : Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      downloadItem: async (id) => {
        if (overrides?.downloadThrows?.(id)) {
          throw new Error(`download-fail-${id}`);
        }
        const t = tracks.find((tr) => tr.id === id);
        return Buffer.alloc(t?.size ?? 0);
      },
    }),
    fs: mockFs,
  });
  const config: SyncConfig = { ...validConfig, serverRootPath: '/' };
  const core = createTestSyncCore(config, deps);
  return { core, mockFs };
}

function makeTrack(overrides: Partial<TrackInfo> = {}): TrackInfo {
  return {
    id: 't',
    name: 'Track',
    album: 'Album',
    artists: ['Artist'],
    path: '/Artist/Album/Track.mp3',
    format: 'mp3',
    size: 1_000_000,
    bitrate: 192_000,
    albumId: 'album-1',
    trackNumber: 1,
    ...overrides,
  };
}

/** Find the last 'copying' event in the list (excluding the empty 'copying'
 *  emits from startCopying). */
function lastCopyingEvent(events: any[]): any | undefined {
  return [...events].reverse().find((e) => e.phase === 'copying' && e.total > 0);
}

describe('ORAIN-0738 — progress bar numerator reaches the total (AC2)', () => {
  it('all-converted: numerator === total at the end', async () => {
    // 3 FLAC tracks, convertToMp3 + embed cover.
    const tracks = [
      makeTrack({ id: '1', path: '/A/1.flac', format: 'flac', size: 10_000_000 }),
      makeTrack({ id: '2', path: '/A/2.flac', format: 'flac', size: 10_000_000 }),
      makeTrack({ id: '3', path: '/A/3.flac', format: 'flac', size: 10_000_000 }),
    ];
    const { core } = buildCore(tracks);

    const events: any[] = [];
    await core.sync(
      {
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/dest',
        options: { convertToMp3: true, bitrate: '192k', coverArtMode: 'embed' },
      },
      (progress) => events.push(progress),
    );

    const lastCopying = lastCopyingEvent(events);
    expect(lastCopying).toBeDefined();
    expect(lastCopying.bytesProcessed).toBe(lastCopying.totalBytes);
    expect(lastCopying.totalBytes).toBeGreaterThan(0);
  });

  it('mixed: copy + convert + skip + fail — numerator still reaches total (AC2)', async () => {
    const tracks = [
      // copy: MP3 at 128 kbps, target 192k → needsConversion false
      makeTrack({
        id: 'copy',
        name: 'Copy',
        path: '/A/copy.mp3',
        format: 'mp3',
        size: 2_000_000,
        bitrate: 128_000,
      }),
      // convert: FLAC → MP3 192k (no bitrate → 900 kbps fallback)
      makeTrack({
        id: 'convert',
        name: 'Convert',
        path: '/A/convert.flac',
        format: 'flac',
        size: 10_000_000,
        bitrate: undefined,
      }),
      // skip: pre-existing file at destination with matching size
      makeTrack({
        id: 'skip',
        name: 'Skip',
        path: '/A/skip.mp3',
        format: 'mp3',
        size: 3_000_000,
        bitrate: 128_000,
      }),
      // fail: downloadItem throws for this id
      makeTrack({
        id: 'fail',
        name: 'Fail',
        path: '/A/fail.mp3',
        format: 'mp3',
        size: 1_500_000,
        bitrate: 128_000,
      }),
    ];

    const { core } = buildCore(tracks, {
      hasCover: false,
      downloadThrows: (id) => id === 'fail',
      preExisting: [{ path: '/dest/A/skip.mp3', size: 3_000_000 }],
    });

    const events: any[] = [];
    const result = await core.sync(
      {
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/dest',
        options: { convertToMp3: true, bitrate: '192k', coverArtMode: 'off' },
      },
      (progress) => events.push(progress),
    );

    // 'fail' must be reported as failed (the path through copyOrConvertTrack
    // catches and reports it).
    expect(result.tracksFailed).toContain('fail');

    const lastCopying = lastCopyingEvent(events);
    expect(lastCopying).toBeDefined();
    expect(lastCopying.bytesProcessed).toBe(lastCopying.totalBytes);
    // 4 tracks' worth of audio bytes: copy(2M) + convert(10M*192/900≈2.13M)
    // + skip(3M) + fail(1.5M) ≈ 8.63M, no cover (off mode).
    expect(lastCopying.totalBytes).toBeGreaterThan(8_000_000);
    expect(lastCopying.totalBytes).toBeLessThan(9_200_000);
  });

  it('tracks without track.size: numerator still reaches total (AC2)', async () => {
    const tracks = [
      // Override size to undefined explicitly so the estimator falls back to 0.
      makeTrack({
        id: 'a',
        name: 'A',
        path: '/A/a.mp3',
        format: 'mp3',
        size: undefined,
        bitrate: undefined,
      }),
      makeTrack({
        id: 'b',
        name: 'B',
        path: '/A/b.flac',
        format: 'flac',
        size: 5_000_000,
        bitrate: undefined,
      }),
    ];
    const { core } = buildCore(tracks, { hasCover: false });

    const events: any[] = [];
    await core.sync(
      {
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/dest',
        options: { coverArtMode: 'off' },
      },
      (progress) => events.push(progress),
    );

    const lastCopying = lastCopyingEvent(events);
    expect(lastCopying).toBeDefined();
    // Track 'a' has no size → 0. Track 'b' has size 5M. Total=5M.
    expect(lastCopying.totalBytes).toBe(5_000_000);
    expect(lastCopying.bytesProcessed).toBe(5_000_000);
  });

  it('storage bar total (estimateSize) === progress bar total (SyncCore sync) — AC1', async () => {
    const tracks = [
      makeTrack({
        id: '1',
        path: '/A/1.mp3',
        format: 'mp3',
        size: 4_000_000,
        bitrate: 192_000,
      }),
      makeTrack({
        id: '2',
        path: '/A/2.flac',
        format: 'flac',
        size: 12_000_000,
      }),
    ];
    const { core } = buildCore(tracks, { hasCover: true });

    const syncOptions = {
      convertToMp3: true,
      bitrate: '192k' as const,
      coverArtMode: 'embed' as const,
    };

    // 1. Storage bar = preview estimate with same options
    const preview = await core.estimateSize(
      ['album-1'],
      new Map([['album-1', 'album' as ItemType]]),
      syncOptions,
    );

    // 2. Run the actual sync with the same options
    const events: any[] = [];
    await core.sync(
      {
        itemIds: ['album-1'],
        itemTypes: new Map([['album-1', 'album' as ItemType]]),
        destinationPath: '/dest',
        options: syncOptions,
      },
      (progress) => events.push(progress),
    );
    const lastCopying = lastCopyingEvent(events);

    // AC1: same total when both use the same options.
    expect(lastCopying.totalBytes).toBe(preview.totalBytes);
  });
});
