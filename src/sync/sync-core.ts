/**
 * Sync Core Module
 *
 * Main orchestration module that coordinates API calls,
 * file operations, and progress reporting.
 */

import type {
  SyncConfig,
  SyncInput,
  SyncResult,
  SyncPhase,
  ProgressCallback,
  SizeEstimate,
  ItemType,
  DestinationValidation,
  SyncLogger,
  TrackInfo,
  TrackMetadata,
  CoverArtMode,
  TrackChange,
  ItemDiff,
  SyncDiffResult,
  FilesystemType,
  LyricsMode,
  SyncError,
} from './types';

import path from 'path';
import { randomUUID } from 'node:crypto';

import { ALL_AUDIO_EXTENSIONS, CONVERT_CONCURRENCY, COPY_CONCURRENCY } from './audio-formats';
import { buildConvertTempPath, buildCopyTrackTempPath } from './temp-path';
import { formatTrackFailed } from '../main/log-scrub';
import { COVER_MAX_BYTES } from './cover-image';
import { validateAudioBody, validateDownloadSize, MAX_DOWNLOAD_BYTES } from './download-validation';

import {
  validateSyncConfig,
  resolveSyncOptions,
  getRelativePath,
  getFilenameFromPath,
  sanitizePathComponent,
  hasTraversalSegment,
} from './sync-config';
import {
  upsertSyncedTrack,
  getSyncedTracksForDevice,
  getSyncedTracksForItem,
  getSyncedItems,
  type SyncedTrackRecord,
} from '../main/database';

import { createApiClient, ApiError, type SyncApi, detectServerRootPath } from './sync-api';

import {
  createNodeFileSystem,
  createFFmpegConverter,
  validateDestination,
  ensureDirectory,
  type FileSystem,
  type AudioConverter,
  mergeMetadata,
} from './sync-files';

import {
  createProgressEmitter,
  createCancellationController,
  createProgressStats,
  PhaseManager,
  type ProgressEmitter,
  type CancellationController,
  SyncCancelledError,
} from './sync-progress';

/**
 * Validate that a path stays within allowed boundaries (prevent path traversal)
 */
function validatePathTraversal(basePath: string, relativePath: string): void {
  if (hasTraversalSegment(relativePath)) {
    throw new Error(
      `Path traversal attempt detected: "${relativePath}" would escape "${basePath}"`,
    );
  }

  // Normalize and verify the final path is still within base
  const normalizedBase = basePath.replace(/\/+$/, '');
  const normalizedFull = `${normalizedBase}/${relativePath}`.replace(/\/+/g, '/');

  if (!normalizedFull.startsWith(normalizedBase + '/') && normalizedFull !== normalizedBase) {
    throw new Error(
      `Path traversal attempt detected: final path "${normalizedFull}" escapes base "${basePath}"`,
    );
  }
}

// ─── Sync engine constants ───────────────────────────────────────────────────
/** Number of hex characters to keep from the metadata hash for change detection */
const METADATA_HASH_LENGTH = 16;

// ─── Sync engine helpers ─────────────────────────────────────────────────────

/**
 * Compute a truncated SHA-256 hash of normalized metadata fields.
 * Used to detect metadata changes without storing full metadata.
 * Hash is truncated to 16 chars — sufficient for change detection.
 */
function computeMetadataHash(meta: TrackMetadata): string {
  // Use Node's crypto module (available in Electron main process)

  const { createHash } = require('crypto');
  const normalized = JSON.stringify({
    title: meta.title ?? '',
    artist: meta.artist ?? '',
    albumArtist: meta.albumArtist ?? '',
    album: meta.album ?? '',
    year: meta.year ?? '',
    trackNumber: meta.trackNumber ?? '',
    discNumber: meta.discNumber ?? '',
    genres: (meta.genres ?? []).sort().join(','),
  });
  return createHash('sha256').update(normalized).digest('hex').slice(0, METADATA_HASH_LENGTH);
}

/**
 * Run `fn` over `items` with at most `concurrency` tasks in-flight at once.
 * Safe for single-threaded JS: index increment and queue pop are synchronous
 * between awaits, so no actual race conditions occur.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  async function worker(): Promise<void> {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/**
 * Returns true when a track should be run through FFmpeg conversion.
 *
 * Rules:
 * - Non-MP3 lossless/incompatible formats → always convert
 * - Other non-MP3 formats (m4a, aac, ogg, opus, wma) → always convert
 * - MP3 → only convert if the source bitrate is KNOWN and exceeds the target
 *   (unknown bitrate = safe default: copy as-is to avoid unnecessary re-encoding)
 */
function needsConversion(
  track: { format: string; bitrate?: number },
  targetBitrateKbps: number,
): boolean {
  const fmt = track.format.toLowerCase();
  if (fmt === 'mp3') {
    // Re-encode only when we know the source is higher than the target
    return track.bitrate !== undefined && track.bitrate > targetBitrateKbps * 1000;
  }
  return true; // all non-MP3 formats need conversion
}

/** Parse bitrate option string to kbps number (e.g. '192k' → 192) */
function bitrateStringToKbps(bitrate: '128k' | '192k' | '320k'): number {
  return parseInt(bitrate, 10);
}

/**
 * Estimate MP3 size after re-encoding.
 * Uses ratio of target/source bitrate as size estimator.
 * Falls back to assuming 900kbps for lossless sources.
 */
function estimatedMp3Size(
  originalBytes: number,
  sourceBitrateKbps: number,
  targetBitrateKbps: number,
): number {
  const effectiveSource = sourceBitrateKbps > 0 ? sourceBitrateKbps : 900;
  return Math.floor(originalBytes * (targetBitrateKbps / effectiveSource));
}

/** Parse arbitrary bitrate string to kbps (e.g. '192k' → 192, '320k' → 320) */
function parseBitrateKbps(bitrate: string): number {
  return parseInt(bitrate.replace(/k$/i, ''), 10) || 192;
}

/**
 * ORAIN-0738: single per-track output-size estimator shared by the storage
 * bar (`estimateSize`) and the progress bar's numerator.
 *
 * Replaces the two previous ad-hoc calculations:
 *  - `totalBytesEstimate` summed `track.size` blindly (sync-core.ts:599),
 *    ignoring conversion AND the cover contribution.
 *  - `estimateSize` re-implemented `needsConversion` (sync-core.ts:1122) and
 *    ignored covers entirely.
 *
 * The conversion rule defers to {@link needsConversion}: an MP3 without
 * `track.bitrate` returns false, so the estimator falls through to
 * `track.size` — matching what the copy path does for that track. The
 * cover contribution is the caller's responsibility (`addCover`) because
 * "embed" applies per-track and "companion" applies once per album — the
 * caller has the album-grouping context.
 *
 * The total can deviate up to ~10 % from the bytes actually written
 * (cover bytes vary, bitrate-ratio is a coarse estimator); the real
 * destination size is reported separately at `[sync-end]` (ORAIN-0740).
 */
export function estimateOutputBytes(
  track: { format: string; size?: number; bitrate?: number },
  options: {
    convertToMp3: boolean;
    bitrate: '128k' | '192k' | '320k';
    targetBitrateKbps: number;
    coverArtMode: CoverArtMode;
    addCover: boolean;
  },
): number {
  const audioSize =
    options.convertToMp3 && needsConversion(track, options.targetBitrateKbps)
      ? estimatedMp3Size(track.size ?? 0, (track.bitrate ?? 0) / 1000, options.targetBitrateKbps)
      : (track.size ?? 0);
  const coverSize = options.coverArtMode !== 'off' && options.addCover ? COVER_MAX_BYTES : 0;
  return audioSize + coverSize;
}

/** No-op logger used when no logger is injected (keeps module testable) */
const noopLogger: SyncLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * ORAIN-0739 AC7: typed phase-tagged error raised from the download /
 * validation pipeline. `copyOrConvertTrack` catches it, reads `phase`, and
 * emits a structured `SyncError` with the same `message`. Non-sync errors
 * (FFmpeg, tag, write) bubble up as plain `Error` and the existing catch
 * block fills `phase: 'conversion' | 'tagging' | 'write'` based on the
 * failing method (kept by convention, no extra signal needed).
 */
export class SyncPhaseError extends Error {
  readonly phase: 'download' | 'validation';
  constructor(phase: 'download' | 'validation', message: string) {
    super(message);
    this.name = 'SyncPhaseError';
    this.phase = phase;
  }
}

/**
 * ORAIN-0739 rework: dedicated error class for stall-aborted downloads.
 * The previous implementation tagged the stall via a `stallTimeout`
 * boolean field on a plain `Error` set/read through unsafe casts
 * (`(err as Error & { stallTimeout?: boolean }).stallTimeout = true`).
 * That was fragile: any future `Error` with a truthy `stallTimeout`
 * field would trip the branch. `instanceof DownloadStalledError` makes
 * the classification exact and lets TS prove the relationship.
 *
 * This commit only adds the class. A follow-up commit wires the stall
 * timer to throw it and the catch block to recognise it via instanceof.
 */
export class DownloadStalledError extends Error {
  readonly stallTimeoutMs: number;
  constructor(stallTimeoutMs: number) {
    super(`Sin datos del servidor durante ${stallTimeoutMs / 1000} s`);
    this.name = 'DownloadStalledError';
    this.stallTimeoutMs = stallTimeoutMs;
  }
}

// ORAIN-0739 AC4: retry delays in milliseconds between download attempts
// (after the first). 2 retries → wait 1 s, then 3 s before re-issuing.
const DOWNLOAD_RETRY_DELAYS_MS = [1000, 3000] as const;
// ORAIN-0739 AC5: abort a download that sits idle for this long. The
// timeout fires from the LAST data event on the stream, so a slow track
// that consistently trickles bytes is unaffected; a stalled connection is
// killed promptly. The abort tears down the stream pipe and bubbles into
// the existing error handling.
const DOWNLOAD_STALL_TIMEOUT_MS = 30_000;

// ORAIN-0709: deduplicate tracks by id. When the selection contains overlapping
// items (e.g. artist + albumArtist + album + playlist), the same track.id appears
// once per originating item. Consumers count each appearance separately — inflating
// tracksCopied, tracksRetagged, totalSizeBytes, and estimate.totalBytes.
// Keeping the first occurrence preserves parentItemId for analyzeDiff grouping.
/**
 * Deduplicates tracks by `track.id`, returning a new array with only the first
 * occurrence of each unique ID kept. Subsequent occurrences with the same ID are
 * dropped (first-occurrence-wins for `parentItemId`).
 *
 * Used by ORAIN-0709 to prevent inflated counts when the user selection overlaps
 * (e.g. artist + albumArtist + album + playlist all resolve to the same pool of
 * tracks — without dedup, tracksCopied / tracksRetagged would be N × multiplicity).
 *
 * @param tracks - Array of tracks, possibly containing duplicate `id` values.
 * @returns New array with duplicate `id` entries removed (preserves order).
 */
function deduplicateTracks(tracks: TrackInfo[]): TrackInfo[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if (seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
}

/**
 * Mock database interface for testing.
 */
interface MockDatabase {
  getSyncedTracksForDevice: (mountPoint: string) => SyncedTrackRecord[];
}

/**
 * Dependencies container (for dependency injection).
 */
export interface SyncDependencies {
  api: SyncApi;
  fs: FileSystem;
  converter: AudioConverter;
  logger?: SyncLogger;
  /**
   * Override for `process.platform`. Used by tests to inject `win32` /
   * `linux` / `darwin` without monkey-patching the global. Defaults to
   * `process.platform` at construction time. ORAIN-0725: the path sanitizer
   * gates on platform, so the platform the SyncCore runs under matters.
   */
  platform?: NodeJS.Platform;
  /** Mock database for testing. If provided, overrides getSyncedTracksForDevice. */
  db?: MockDatabase;
  /**
   * Test-only hook: if provided, `saveSyncedRecord` calls this instead of the real
   * `upsertSyncedTrack`. Allows tests to intercept and record DB writes so that a
   * second sync() call can read back what the first call wrote.
   */
  mockUpsert?: (
    mountPoint: string,
    itemId: string,
    trackId: string,
    destPath: string,
    fileSize: number | null,
    metadataHash: string | null,
    coverArtMode: string,
    encodedBitrate: string | null,
    serverPath: string | null,
    serverRootPath: string | null,
    lyricsMode: string,
  ) => void;
}

/**
 * Default dependencies factory
 */
function createDefaultDependencies(config: SyncConfig, logger?: SyncLogger): SyncDependencies {
  return {
    api: createApiClient({
      baseUrl: config.serverUrl,
      apiKey: config.apiKey,
      userId: config.userId,
      logger,
    }),
    fs: createNodeFileSystem(),
    converter: createFFmpegConverter(logger),
  };
}

/**
 * SyncCore implementation
 */

/**
 * MEDIUM-4: extracted named interface to keep the return signature of
 * `_downloadWithValidation` readable and reusable across both
 * `copyTrackFile` and `convertAndCopy` call sites.
 */
interface DownloadValidationResult {
  tmpPath: string;
  receivedBytes: number;
  contentLength: number | undefined;
  contentEncoding: string | undefined;
  contentType: string | undefined;
  declaredSize: number | undefined;
}

class SyncCoreImpl {
  private deps: SyncDependencies;
  private log: SyncLogger;
  private progressEmitter: ProgressEmitter;
  private cancellation: CancellationController;
  private serverRootPath: string;
  /**
   * Target platform — drives whether the path sanitizer runs on segments
   * even when `filesystemType` is `'unknown'`. ORAIN-0725: Windows 11 24H2+
   * removed the pre-24H2 Windows volume binary, so filesystem detection
   * on Win32 can return `'unknown'`
   * while the volume still rejects `<>:"/\|?*`. Injected so tests don't read
   * `process.platform` at test time.
   */
  private platform: NodeJS.Platform;
  private currentPhase: SyncPhase = 'fetching';
  /** Tracks album directories that have already received a cover.jpg (for companion mode dedup) */
  private processedCoverDirs = new Set<string>();
  /** Cover art cache keyed by Jellyfin album ID — avoids N HTTP requests for the same album's cover */
  private coverArtCache = new Map<string, Buffer>();
  /** Session-level counter for cover art fetch failures — used to emit a single UI warning */
  private coverArtFailCount = 0;

  /**
   * Persists a synced-track record to the database.
   * Delegates to `mockUpsert` when provided (testing override), otherwise calls
   * the real `upsertSyncedTrack`. Centralised here so tests can intercept writes
   * and have phase 2 of a two-phase sync() re-sync see phase 1's records.
   */
  private saveSyncedRecord(
    mountPoint: string,
    itemId: string,
    trackId: string,
    destPath: string,
    fileSize: number | null,
    metadataHash: string | null,
    coverArtMode: string,
    encodedBitrate: string | null,
    serverPath: string | null,
    serverRootPath: string | null,
    lyricsMode: string = 'off',
  ): void {
    const fn = this.deps.mockUpsert;
    if (fn) {
      fn(
        mountPoint,
        itemId,
        trackId,
        destPath,
        fileSize,
        metadataHash,
        coverArtMode,
        encodedBitrate,
        serverPath,
        serverRootPath,
        lyricsMode,
      );
    } else {
      upsertSyncedTrack(
        mountPoint,
        itemId,
        trackId,
        destPath,
        fileSize,
        metadataHash,
        coverArtMode,
        encodedBitrate,
        serverPath,
        serverRootPath,
        lyricsMode,
      );
    }
  }

  constructor(config: SyncConfig, deps?: Partial<SyncDependencies>) {
    // Validate config
    const validation = validateSyncConfig(config);
    if (!validation.valid) {
      throw new Error(`Invalid config: ${validation.errors.join(', ')}`);
    }

    // Resolve logger first so we can pass it to createApiClient for debug logging
    const logger = deps?.logger ?? noopLogger;
    const defaults = createDefaultDependencies(config, logger);
    this.deps = {
      api: deps?.api ?? defaults.api,
      fs: deps?.fs ?? defaults.fs,
      converter: deps?.converter ?? defaults.converter,
      logger,
      db: deps?.db,
      mockUpsert: deps?.mockUpsert,
    };
    this.log = logger;
    this.progressEmitter = createProgressEmitter();
    this.cancellation = createCancellationController();
    // Default server root path if not provided
    this.serverRootPath = config.serverRootPath ?? '';
    // Default platform from process.platform — overridable through deps for tests.
    this.platform = (deps?.platform as NodeJS.Platform | undefined) ?? process.platform;
  }

  /**
   * Subscribe to progress updates
   */
  onProgress(callback: ProgressCallback): () => void {
    return this.progressEmitter.subscribe(callback);
  }

  /**
   * Cancel ongoing sync operation
   */
  cancel(): void {
    this.cancellation.cancel();
  }

  /**
   * Execute sync operation
   */
  async sync(input: SyncInput, onProgress?: ProgressCallback): Promise<SyncResult> {
    const startTime = Date.now();
    const stats = createProgressStats();
    stats.startTime = startTime;

    // ORAIN-0740: use caller's syncId if provided, otherwise mint a short
    // random id. Same pattern as index.ts (`v2SyncId = randomUUID().slice(0, 8)`).
    const syncId = input.syncId ?? randomUUID().slice(0, 8);

    const unsubscribe = onProgress ? this.progressEmitter.subscribe(onProgress) : () => {};

    const phaseManager = new PhaseManager(this.progressEmitter);
    const errors: SyncError[] = [];
    const tracksFailed: string[] = [];
    let totalTracks = 0;
    let lyricsAdded = 0;

    try {
      this.cancellation.reset();

      // AC-1: Snapshot companion directories BEFORE sync loop mutates DB records.
      // Query at sync start captures the pre-sync state of coverArtMode.
      // This prevents the race condition where runCopyPhase updates all records to
      // the new mode before cleanup can find the old companion records.
      const companionDirsSnapshot = new Set<string>();
      try {
        const getTracks = this.deps.db?.getSyncedTracksForDevice ?? getSyncedTracksForDevice;
        const preSyncRecords = await Promise.resolve(getTracks(input.destinationPath));
        for (const rec of preSyncRecords) {
          if (rec.coverArtMode === 'companion') {
            companionDirsSnapshot.add(path.dirname(rec.destinationPath));
          }
        }
      } catch (_e) {
        this.log.warn('Failed to load pre-sync companion records');
      }

      // Phase 1: Validation
      const destValidation = await this.runValidationPhase(input.destinationPath);
      if (!destValidation.valid) {
        return this.buildFailureResult(
          startTime,
          destValidation.errors.map((message) => ({ trackName: '', message })),
          stats,
        );
      }

      // Phase 2: Fetch
      const fetchResult = await this.runFetchPhase(input.itemIds, input.itemTypes, phaseManager);
      errors.push(...fetchResult.errors.map((message) => ({ trackName: '', message })));
      totalTracks = fetchResult.tracks.length;

      if (totalTracks === 0) {
        return this.buildFailureResult(
          startTime,
          [{ trackName: '', message: 'No tracks found for selected items' }, ...errors],
          stats,
        );
      }

      // Phase 3: Copy
      const options = resolveSyncOptions(input.options);
      await ensureDirectory(input.destinationPath, this.deps.fs);

      const copyResult = await this.runCopyPhase(
        input.destinationPath,
        input.itemTypes,
        fetchResult.tracks,
        options,
        phaseManager,
        tracksFailed,
        errors,
        stats,
        syncId,
      );
      lyricsAdded = copyResult.lyricsAdded;

      // Phase 4: Cleanup
      await this.runCleanupPhase(input.itemIds, input.itemTypes, input.destinationPath, options);

      // AC-1: When switching FROM companion mode, remove stale cover.jpg files.
      // Uses companionDirsSnapshot captured before the sync loop mutated DB records.
      const currentCoverMode = options.coverArtMode ?? 'embed';
      if (currentCoverMode !== 'companion' && companionDirsSnapshot.size > 0) {
        const staleCoverPaths = [...companionDirsSnapshot].map((dir) => `${dir}/cover.jpg`);
        await this.cleanCoverFilesForNonCompanionMode(input.destinationPath, staleCoverPaths);
      }

      // AC-2: When lyricsMode is embed, clean up stale .lrc files from prior syncs
      // Also includes tracks previously synced with lrc mode (from DB)
      if (options.lyricsMode === 'embed') {
        const syncedBasenames = new Set(copyResult.syncedBasenames ?? []);

        // Add basenames of tracks previously synced with 'lrc' mode (from DB)
        const getTracks = this.deps.db?.getSyncedTracksForDevice ?? getSyncedTracksForDevice;
        const dbRecords = await Promise.resolve(getTracks(input.destinationPath));
        for (const rec of dbRecords) {
          if (rec.lyricsMode === 'lrc') {
            const baseName = getFilenameFromPath(rec.destinationPath).replace(/\.[^.]+$/, '');
            syncedBasenames.add(baseName);
          }
        }
        await this.cleanLrcFilesForEmbedMode(input.destinationPath, syncedBasenames);
      }

      phaseManager.complete(stats);

      return {
        success: errors.length === 0,
        tracksCopied: stats.itemsProcessed,
        tracksSkipped: stats.itemsSkipped,
        tracksRetagged: copyResult.statsRetagged,
        tracksMoved: copyResult.statsMoved,
        tracksRemoved: 0,
        lyricsAdded,
        tracksFailed,
        errors,
        totalSizeBytes: stats.bytesTransferred,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      if (error instanceof SyncCancelledError) {
        phaseManager.cancelled(stats.itemsProcessed, totalTracks || input.itemIds.length);
        return {
          success: false,
          tracksCopied: stats.itemsProcessed,
          tracksSkipped: stats.itemsSkipped,
          tracksRetagged: 0,
          tracksMoved: 0,
          tracksRemoved: 0,
          lyricsAdded: 0,
          tracksFailed: [],
          errors: [{ trackName: '', message: 'Sync was cancelled by user' }],
          totalSizeBytes: stats.bytesTransferred,
          durationMs: Date.now() - startTime,
          cancelled: true,
        };
      }

      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      phaseManager.error(errorMsg);

      return {
        success: false,
        tracksCopied: stats.itemsProcessed,
        tracksSkipped: stats.itemsSkipped,
        tracksRetagged: 0,
        tracksMoved: 0,
        tracksRemoved: 0,
        lyricsAdded,
        tracksFailed,
        errors: [...errors, { trackName: '', message: errorMsg }],
        totalSizeBytes: stats.bytesTransferred,
        durationMs: Date.now() - startTime,
      };
    } finally {
      unsubscribe();
    }
  }

  // ─── Sync phases ────────────────────────────────────────────────────────────

  private async runValidationPhase(destinationPath: string): Promise<DestinationValidation> {
    this.currentPhase = 'fetching';
    return validateDestination(destinationPath, this.deps.fs);
  }

  private async runFetchPhase(
    itemIds: string[],
    itemTypes: Map<string, ItemType>,
    phaseManager: PhaseManager,
  ): Promise<{ tracks: TrackInfo[]; errors: string[] }> {
    this.cancellation.throwIfCancelled();
    phaseManager.updateFetching(1, 3);

    const { tracks: rawTracks, errors } = await this.deps.api.getTracksForItems(itemIds, itemTypes);
    const tracks = deduplicateTracks(rawTracks);

    if (!this.serverRootPath && tracks.length > 0) {
      const detectedPath = detectServerRootPath(tracks);
      if (detectedPath) {
        this.serverRootPath = detectedPath;
        this.log.info(`Detected server root path: ${detectedPath}`);
      }
    }

    return { tracks, errors };
  }

  private async runCopyPhase(
    destinationPath: string,
    itemTypes: Map<string, ItemType>,
    tracks: TrackInfo[],
    options: ReturnType<typeof resolveSyncOptions>,
    phaseManager: PhaseManager,
    tracksFailed: string[],
    errors: SyncError[],
    stats: ReturnType<typeof createProgressStats>,
    syncId: string,
  ): Promise<{
    statsRetagged: number;
    statsMoved: number;
    lyricsAdded: number;
    syncedBasenames: string[];
  }> {
    this.currentPhase = 'copying';
    phaseManager.startCopying(tracks.length);

    const targetBitrateKbps = bitrateStringToKbps(options.bitrate ?? '192k');
    const anyWillConvert =
      options.convertToMp3 === true && tracks.some((t) => needsConversion(t, targetBitrateKbps));
    const concurrency = anyWillConvert ? CONVERT_CONCURRENCY : COPY_CONCURRENCY;

    // ORAIN-0738: storage and progress bars must share a single total —
    // the per-track destination-size estimate. We compute the same totals
    // for `totalBytesEstimate` (denominator) and per-track bumps
    // (numerator, inside the loop) by reusing `estimateOutputBytes` and
    // the same per-album companion-cover rule.
    const coverArtMode = options.coverArtMode ?? 'embed';
    const convertToMp3 = options.convertToMp3 === true;
    // Track which albumIds we've already counted a companion cover for, in
    // iteration order. Mirrors `processedCoverDirs` in writeCompanionCover
    // (the actual cover.jpg write dedupes by output dir; this Set mirrors
    // the per-track accounting). For the TOTAL it's only the unique
    // albumIds; for the numerator we want the same "first track of album
    // wins" rule so the two stay in sync.
    const companionCoverAlbumIds = new Set<string>();

    /** Does THIS track's destination estimate include a cover contribution? */
    const shouldAddCover = (track: TrackInfo): boolean => {
      if (coverArtMode === 'off') return false;
      if (coverArtMode === 'embed') return true;
      // companion: only the first track of each album contributes.
      if (!track.albumId) return false;
      if (companionCoverAlbumIds.has(track.albumId)) return false;
      companionCoverAlbumIds.add(track.albumId);
      return true;
    };

    let totalBytesEstimate = 0;
    for (const track of tracks) {
      totalBytesEstimate += estimateOutputBytes(track, {
        convertToMp3,
        bitrate: options.bitrate ?? '192k',
        targetBitrateKbps,
        coverArtMode,
        addCover: shouldAddCover(track),
      });
    }

    let completed = 0;
    let statsRetagged = 0;
    let statsMoved = 0;
    let lyricsAdded = 0;
    const syncedBasenames: string[] = [];

    let allSyncedRecords: SyncedTrackRecord[] = [];
    try {
      const getTracks = this.deps.db?.getSyncedTracksForDevice ?? getSyncedTracksForDevice;
      allSyncedRecords = await Promise.resolve(getTracks(destinationPath));
    } catch (_e) {
      this.log.warn('Failed to load synced records, treating all tracks as new');
    }
    const syncedByTrackId = new Map<string, SyncedTrackRecord>();
    for (const rec of allSyncedRecords) {
      syncedByTrackId.set(rec.trackId, rec);
    }

    await runWithConcurrency(tracks, concurrency, async (track) => {
      if (this.cancellation.isCancelled()) return;

      try {
        const result = await this.processTrack(
          track,
          destinationPath,
          itemTypes,
          options,
          targetBitrateKbps,
          syncedByTrackId,
        );
        if (result.processed) {
          stats.itemsProcessed++;
        }
        statsRetagged += result.retagged ? 1 : 0;
        statsMoved += result.moved ? 1 : 0;
        lyricsAdded += result.lyricsAdded ?? 0;

        if (result.error) {
          errors.push({
            trackName: track.name,
            message: result.error,
            phase: result.errorPhase,
          });
          tracksFailed.push(track.id);

          // ORAIN-0740 AC3: one [track-failed] line per failed track,
          // scoped by syncId. The wrapper scrubs the cause string so a
          // thrown ApiError's body/headers can't leak through to main.log.
          const hasImage = this.coverArtCache.has(track.albumId ?? track.id);
          const failedLine = formatTrackFailed({
            syncId,
            trackId: track.id,
            trackName: track.name,
            phase: result.errorPhase ?? 'download',
            cause: result.error,
            format: track.format,
            bitrate: track.bitrate,
            declaredSize: track.size,
            hasImage,
          });
          this.log.trackFailed?.(failedLine);
        }

        // ORAIN-0738 AC2: bump the numerator for EVERY outcome (copied,
        // converted, skipped, failed, retagged). The estimate matches what
        // would actually be on disk for this track — same number used in
        // `totalBytesEstimate` above, so the bar lands on the total at the
        // end of the sync regardless of which paths fired.
        stats.bytesTransferred += estimateOutputBytes(track, {
          convertToMp3,
          bitrate: options.bitrate ?? '192k',
          targetBitrateKbps,
          coverArtMode,
          addCover: shouldAddCover(track),
        });

        // Collect basenames for embed-mode LRC cleanup
        // Add for both processed and skipped tracks (skipped tracks still sync lyrics)
        if (result.processed || result.skipped) {
          const basename = getFilenameFromPath(track.path ?? track.id).replace(/\.[^.]+$/, '');
          syncedBasenames.push(basename);
        }
      } finally {
        completed++;
        phaseManager.updateCopying(
          completed,
          tracks.length,
          track.name,
          totalBytesEstimate,
          stats.bytesTransferred,
        );
      }
    });

    this.cancellation.throwIfCancelled();
    return { statsRetagged, statsMoved, lyricsAdded, syncedBasenames };
  }

  private async runCleanupPhase(
    itemIds: string[],
    itemTypes: Map<string, ItemType>,
    destinationPath: string,
    options: ReturnType<typeof resolveSyncOptions>,
  ): Promise<void> {
    const playlistIds = itemIds.filter((id) => itemTypes.get(id) === 'playlist');
    if (playlistIds.length > 0 && this.serverRootPath) {
      await this.generateM3u8Files(playlistIds, destinationPath, options);
    }
  }

  private buildFailureResult(
    startTime: number,
    errors: SyncError[],
    stats: ReturnType<typeof createProgressStats>,
  ): SyncResult {
    return {
      success: false,
      tracksCopied: stats.itemsProcessed,
      tracksSkipped: stats.itemsSkipped,
      tracksRetagged: 0,
      tracksMoved: 0,
      tracksRemoved: 0,
      lyricsAdded: 0,
      tracksFailed: [],
      errors,
      totalSizeBytes: stats.bytesTransferred,
      durationMs: Date.now() - startTime,
    };
  }

  private async processTrack(
    track: TrackInfo,
    destinationPath: string,
    _itemTypes: Map<string, ItemType>,
    options: ReturnType<typeof resolveSyncOptions>,
    targetBitrateKbps: number,
    syncedByTrackId: Map<string, SyncedTrackRecord>,
  ): Promise<{
    retagged: boolean;
    moved: boolean;
    processed: boolean;
    skipped: boolean;
    lyricsAdded: number;
    error?: string;
    /** ORAIN-0739 AC7: passed through from copyOrConvertTrack so the
     * outer loop can fill `SyncError.phase`. */
    errorPhase?: SyncError['phase'];
  }> {
    const outputDir = this.getOutputDir(
      track,
      destinationPath,
      options.preserveStructure ?? true,
      options.filesystemType ?? 'unknown',
    );
    await ensureDirectory(outputDir, this.deps.fs);

    const willConvert = options.convertToMp3 === true && needsConversion(track, targetBitrateKbps);
    const coverArtMode = options.coverArtMode ?? 'embed';
    const outputFilename = this.resolveCanonicalFilename(track, options);
    const outputPath = `${outputDir}/${outputFilename}`;
    const trackMeta = this.buildMetadata(track);
    const currentHash = computeMetadataHash(trackMeta);
    const encodedBitrate = willConvert ? (options.bitrate ?? '192k') : null;
    const itemId = track.parentItemId ?? '';

    const syncedRecord = syncedByTrackId.get(track.id);

    if (syncedRecord) {
      return this.handleSyncedRecord(
        syncedRecord,
        track,
        outputPath,
        itemId,
        currentHash,
        coverArtMode,
        encodedBitrate,
        destinationPath,
        trackMeta,
        options,
      );
    }

    return this.copyOrConvertTrack(
      track,
      outputDir,
      outputPath,
      outputFilename,
      willConvert,
      coverArtMode,
      itemId,
      currentHash,
      encodedBitrate,
      destinationPath,
      trackMeta,
      options,
    );
  }

  private async handleSyncedRecord(
    syncedRecord: SyncedTrackRecord,
    track: TrackInfo,
    outputPath: string,
    itemId: string,
    currentHash: string,
    coverArtMode: CoverArtMode,
    encodedBitrate: string | null,
    destinationPath: string,
    trackMeta: TrackMetadata,
    options: ReturnType<typeof resolveSyncOptions>,
  ): Promise<{
    retagged: boolean;
    moved: boolean;
    processed: boolean;
    skipped: boolean;
    lyricsAdded: number;
    error?: string;
  }> {
    const metadataChanged = syncedRecord.metadataHash !== currentHash;
    const bitrateChanged =
      encodedBitrate !== null && syncedRecord.encodedBitrate !== encodedBitrate;
    const coverArtChanged = syncedRecord.coverArtMode !== coverArtMode;
    const pathChanged = syncedRecord.destinationPath !== outputPath;

    if (!metadataChanged && !bitrateChanged && !coverArtChanged) {
      if (pathChanged) {
        this.saveSyncedRecord(
          destinationPath,
          itemId,
          track.id,
          outputPath,
          track.size ?? null,
          currentHash,
          coverArtMode,
          encodedBitrate,
          track.path ?? null,
          this.serverRootPath || null,
          options.lyricsMode ?? 'off',
        );
        const lyricsResult = await this.processLyrics(
          track,
          outputPath,
          options.lyricsMode ?? 'off',
        );
        await this.processReplayGain(track, outputPath);
        return {
          retagged: false,
          moved: true,
          processed: true,
          skipped: false,
          lyricsAdded: lyricsResult,
        };
      }

      // Truly unchanged — but still process lyrics if lyricsMode is not 'off'
      const lyricsResult = await this.processLyrics(
        track,
        syncedRecord.destinationPath,
        options.lyricsMode ?? 'off',
      );
      await this.processReplayGain(track, outputPath);
      return {
        retagged: false,
        moved: false,
        processed: false,
        skipped: true,
        lyricsAdded: lyricsResult,
      };
    }

    if (!pathChanged && (metadataChanged || bitrateChanged || coverArtChanged)) {
      // AC-2: Strip embedded cover when switching from embed to companion mode
      if (
        coverArtChanged &&
        syncedRecord.coverArtMode === 'embed' &&
        coverArtMode === 'companion'
      ) {
        await this.stripCoverFromTrack(syncedRecord.destinationPath, syncedRecord.destinationPath);
      }

      const embedCover =
        coverArtMode === 'embed'
          ? await this.getCoverArtBuffer(track.id, track.albumId, coverArtMode)
          : undefined;
      const tagResult = await this.deps.converter.tagFile(
        syncedRecord.destinationPath,
        syncedRecord.destinationPath,
        trackMeta,
        embedCover,
      );
      if (tagResult.success) {
        this.saveSyncedRecord(
          destinationPath,
          itemId,
          track.id,
          syncedRecord.destinationPath,
          track.size ?? null,
          currentHash,
          coverArtMode,
          encodedBitrate,
          track.path ?? null,
          this.serverRootPath || null,
          options.lyricsMode ?? 'off',
        );
        const outputDir = path.dirname(syncedRecord.destinationPath);
        if (coverArtMode === 'companion') {
          const coverBuffer = await this.getCoverArtBuffer(track.id, track.albumId, coverArtMode);
          if (coverBuffer) await this.writeCompanionCover(outputDir, coverBuffer);
        }
        const lyricsResult = await this.processLyrics(
          track,
          syncedRecord.destinationPath,
          options.lyricsMode ?? 'off',
        );
        await this.processReplayGain(track, outputPath);
        return {
          retagged: true,
          moved: false,
          processed: false,
          skipped: false,
          lyricsAdded: lyricsResult,
        };
      }
      this.log.warn(`Re-tag failed for ${track.name}, falling back to re-download`);
    }

    // Fall through to copy/conversion — but mark as processed:false since retag failures
    // don't increment itemsProcessed in the original (they fall through but don't re-download)
    const copyResult = await this.copyOrConvertTrack(
      track,
      this.getOutputDir(
        track,
        destinationPath,
        options.preserveStructure ?? true,
        options.filesystemType ?? 'unknown',
      ),
      outputPath,
      this.resolveCanonicalFilename(track, options),
      encodedBitrate !== null,
      coverArtMode,
      itemId,
      currentHash,
      encodedBitrate,
      destinationPath,
      trackMeta,
      options,
    );
    return {
      ...copyResult,
      // ORAIN-0739 AC7: errorPhase is already on the spread.
    };
  }

  private async copyOrConvertTrack(
    track: TrackInfo,
    outputDir: string,
    outputPath: string,
    outputFilename: string,
    willConvert: boolean,
    coverArtMode: CoverArtMode,
    itemId: string,
    currentHash: string,
    encodedBitrate: string | null,
    destinationPath: string,
    trackMeta: TrackMetadata,
    options: ReturnType<typeof resolveSyncOptions>,
  ): Promise<{
    retagged: boolean;
    moved: boolean;
    processed: boolean;
    skipped: boolean;
    lyricsAdded: number;
    error?: string;
    /** ORAIN-0739 AC7: phase where the error originated, used by the
     * outer loop to fill `SyncError.phase`. Defaults are inferred from
     * the calling path so non-download errors still carry a phase. */
    errorPhase?: SyncError['phase'];
  }> {
    try {
      // Handle existing file at output path
      if (await this.deps.fs.exists(outputPath)) {
        if (willConvert) {
          // Cross-format: can't compare sizes meaningfully
          const existingSize = (await this.deps.fs.stat(outputPath)).size;
          this.saveSyncedRecord(
            destinationPath,
            itemId,
            track.id,
            outputPath,
            existingSize,
            currentHash,
            coverArtMode,
            encodedBitrate,
            track.path ?? null,
            this.serverRootPath || null,
            options.lyricsMode ?? 'off',
          );
          return { retagged: false, moved: false, processed: true, skipped: true, lyricsAdded: 0 };
        }
        if (track.size && (await this.deps.fs.stat(outputPath)).size === track.size) {
          this.saveSyncedRecord(
            destinationPath,
            itemId,
            track.id,
            outputPath,
            track.size,
            currentHash,
            coverArtMode,
            encodedBitrate,
            track.path ?? null,
            this.serverRootPath || null,
            options.lyricsMode ?? 'off',
          );
          return { retagged: false, moved: false, processed: true, skipped: true, lyricsAdded: 0 };
        }
      }

      await this.deleteAlternateFormats(outputDir, outputFilename);

      if (willConvert) {
        await this.convertAndCopy(
          track,
          outputPath,
          options.bitrate ?? '192k',
          options.embedMetadata !== false,
          coverArtMode,
        );
        if (coverArtMode === 'companion') {
          const coverBuffer = await this.getCoverArtBuffer(track.id, track.albumId, coverArtMode);
          if (coverBuffer) await this.writeCompanionCover(outputDir, coverBuffer);
        }
      } else {
        await this.copyTrackFile(track, outputDir, outputPath, coverArtMode, trackMeta, options);
        // ORAIN-0738: bytesTransferred is now bumped once per track in
        // runCopyPhase (using estimateOutputBytes), uniformly for every
        // outcome — including conversion and skipped/failed tracks.
      }

      this.saveSyncedRecord(
        destinationPath,
        itemId,
        track.id,
        outputPath,
        track.size ?? null,
        currentHash,
        coverArtMode,
        encodedBitrate,
        track.path ?? null,
        this.serverRootPath || null,
        options.lyricsMode ?? 'off',
      );

      // Handle lyrics (after file is written/copied)
      const lyricsResult = await this.processLyrics(track, outputPath, options.lyricsMode ?? 'off');
      await this.processReplayGain(track, outputPath);

      return {
        retagged: false,
        moved: false,
        processed: true,
        skipped: false,
        lyricsAdded: lyricsResult,
      };
    } catch (error) {
      // ORAIN-0739 AC7: read the typed phase off `SyncPhaseError` so the
      // outer loop can fill `SyncError.phase`. For everything else
      // (FFmpeg stderr, tagger rejection, write error) we fall back to a
      // sensible phase inferred from which step threw.
      let errorPhase: SyncError['phase'];
      if (error instanceof SyncPhaseError) {
        errorPhase = error.phase;
      } else if (willConvert) {
        // Either FFmpeg rejected the body, FFmpeg itself crashed, or
        // something blew up while reading the temp file for metadata.
        // All three originate inside the conversion step.
        errorPhase = 'conversion';
      } else if (options.embedMetadata !== false) {
        // The copy+tag path runs `readFileMetadata` + `tagFile` after the
        // download; both throw plain `Error`s, neither carries a phase.
        errorPhase = 'tagging';
      } else {
        errorPhase = 'write';
      }
      const errorMsg = `Failed to sync "${track.name}": ${error instanceof Error ? error.message : 'Unknown error'}`;
      return {
        retagged: false,
        moved: false,
        processed: false,
        skipped: false,
        lyricsAdded: 0,
        error: errorMsg,
        errorPhase,
      };
    }
  }

  /**
   * ORAIN-0739 — single post-download validation point shared by
   * `copyTrackFile` (no conversion) and `convertAndCopy` (FFmpeg path).
   * The unit of work is: download a track to a temp file under
   * `os.tmpdir()`, retry on transient transport failures, watch for stalls
   * mid-stream, then verify the buffered body fingerprint and length
   * before any consumer (FFmpeg, tagger, raw copy) ever touches it.
   *
   * Returns `{ tmpPath, receivedBytes, contentLength, contentEncoding,
   * contentType, declaredSize }` on success. Throws `SyncPhaseError`
   * (carrying `phase: 'download' | 'validation'`) on failure. The caller
   * is responsible for `unlink(tmpPath)` in a `finally`.
   *
   * AC1: empty / textual / unknown-signature bodies are rejected at the
   * body-validation step (FFmpeg never sees them).
   * AC2/AC6: size check runs on the raw buffered body, honouring
   * Content-Length, encoding and the declared-size stability rule.
   * AC4: 1 s + 3 s between attempts (max 2 retries); cancellation does
   * not retry.
   * AC5: a stream that goes silent for 30 s is aborted and counted as a
   * download failure (so the retry loop catches it).
   */
  private async _downloadWithValidation(
    track: TrackInfo,
    tmpPath: string,
  ): Promise<DownloadValidationResult> {
    const declaredSize =
      typeof track.size === 'number' && Number.isFinite(track.size) && track.size > 0
        ? track.size
        : undefined;

    const maxAttempts = DOWNLOAD_RETRY_DELAYS_MS.length + 1; // 3 attempts total
    let previousReceivedBytes: number | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Cancellation is global — do not retry once the user has asked to
      // stop. Throwing SyncCancelledError preserves the existing cancel
      // contract; the outer catch handles it before the structured-error
      // pipeline.
      this.cancellation.throwIfCancelled();

      let phaseError: SyncPhaseError | null = null;
      let attemptReceivedBytes: number | undefined;
      // MEDIUM-3: declared outside the try so the catch block can capture
      // partial bytes when the stream errors mid-flight.
      let receivedBytesLocal = 0;

      try {
        // HIGH-S1 / AC6 pre-pipe guard (declaredSize): if Jellyfin's
        // `track.size` already exceeds the 2 GiB cap, refuse the request
        // before issuing it. Saves the IO of a download we will never
        // accept.
        if (declaredSize !== undefined && BigInt(declaredSize) > MAX_DOWNLOAD_BYTES) {
          throw new SyncPhaseError('download', 'Archivo demasiado grande (>2 GiB)');
        }

        const stream = await this.deps.api.downloadItemStream(track.id);
        const streamMeta = stream as NodeJS.ReadableStream & {
          contentType?: string;
          contentLength?: number;
          contentEncoding?: string;
        };
        const contentType = streamMeta.contentType;
        const contentLength = streamMeta.contentLength;
        const contentEncoding = streamMeta.contentEncoding;

        // HIGH-S1 / AC6 pre-pipe guard (Content-Length): same shape, but
        // triggered by the proxy's own Content-Length header. Runs after
        // `downloadItemStream` returns the stream object so we have access
        // to the parsed header, but BEFORE `createWriteStream` /
        // `stream.pipe(writeStream)` so we never write past the cap.
        if (
          typeof contentLength === 'number' &&
          Number.isFinite(contentLength) &&
          BigInt(contentLength) > MAX_DOWNLOAD_BYTES
        ) {
          throw new SyncPhaseError('download', 'Archivo demasiado grande (>2 GiB)');
        }

        // AC4/AC5: open with 'wx' (refuse stale temp from prior crash)
        // and pipe, watching for stalls. The timer resets on every
        // 'data' event; if it fires we abort the stream and let the
        // outer catch classify the failure as a download error so the
        // retry loop runs.
        //
        // `deps.fs.createWriteStream` returns `NodeJS.WritableStream`
        // in the DI interface, but the real implementation returns
        // `fs.WriteStream`, which exposes `destroy(err?)`. Intersect
        // the type so the stall-abort path can call `destroy` without
        // casting through `unknown`.
        const writeStreamRaw = await this.deps.fs.createWriteStream(tmpPath, { flags: 'wx' });
        const writeStream = writeStreamRaw as NodeJS.WritableStream & {
          destroy: (e?: Error) => void;
        };

        let stallTimer: NodeJS.Timeout | null = null;
        let stallFired = false;
        let done = false;

        const armStallTimer = () => {
          if (done) return;
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            stallFired = true;
            // Build a dedicated `DownloadStalledError` so the catch
            // block can recognise stalls via `instanceof`.
            const err = new DownloadStalledError(DOWNLOAD_STALL_TIMEOUT_MS);
            (stream as unknown as { destroy: (e?: Error) => void }).destroy(err);
            (writeStream as unknown as { destroy: (e?: Error) => void }).destroy(err);
          }, DOWNLOAD_STALL_TIMEOUT_MS);
        };

        try {
          await new Promise<void>((resolve, reject) => {
            // CR-2: `cleanup` is re-entry safe. Pipe destroy can
            // re-emit `error` after the first reject, and `finish` may
            // arrive after `error` once the writeStream flushes its
            // remaining buffer. Without the `done` guard a second
            // `cleanup()` would `resolve()` a promise that already
            // rejected, hiding the failure from the awaiting catch.
            const cleanup = (err?: Error) => {
              if (done) return;
              done = true;
              // CR-3: kill the stall timer immediately so a late
              // 'data' (which can fire from buffered bytes even after
              // destroy) cannot re-arm it. The 30 s timeout would
              // otherwise keep the event loop alive after we settle.
              if (stallTimer) {
                clearTimeout(stallTimer);
                stallTimer = null;
              }
              if (err) reject(err);
              else resolve();
            };
            stream.on('data', (chunk: Buffer | string) => {
              // CR-3: gate byte counting + stall re-arm on `done` so
              // buffered bytes emitted after destroy do not extend the
              // session. `done` is also set inside `cleanup`, so a
              // 'close' re-emit cannot re-arm the timer either.
              if (done) return;
              receivedBytesLocal += Buffer.isBuffer(chunk)
                ? chunk.length
                : Buffer.byteLength(chunk);
              // HIGH-S1 / AC6 in-pipe guard: servers without Content-Length
              // (or lying about it) bypassed the pre-pipe checks. Cap the
              // stream at 2 GiB so a hostile / misconfigured proxy cannot
              // fill `os.tmpdir()`. AC4: `cleanup` runs `unlink(tmpPath)`
              // through the retry-loop teardown.
              if (BigInt(receivedBytesLocal) > MAX_DOWNLOAD_BYTES) {
                const err = new SyncPhaseError('download', 'Archivo demasiado grande (>2 GiB)');
                // Destroy both ends; the write side may flush whatever is
                // already in its internal buffer before it sees the error.
                (stream as unknown as { destroy: (e?: Error) => void }).destroy(err);
                (writeStream as unknown as { destroy: (e?: Error) => void }).destroy(err);
                cleanup(err);
                return;
              }
              armStallTimer();
            });
            stream.on('error', (err: Error) => cleanup(err));
            writeStream.on('error', (err: Error) => cleanup(err));
            writeStream.on('finish', () => cleanup());
            // CR-3: listen for 'close' as well — it always fires (even
            // after `destroy()`) and is the only event guaranteed to
            // settle the promise if `error` is suppressed by Node
            // (a stream already in error state does not re-emit
            // `'error'`). The `done` guard makes both 'close' and
            // 'finish' safe to call in any order.
            stream.on('close', () => cleanup());
            writeStream.on('close', () => cleanup());
            armStallTimer();
            stream.pipe(writeStream);
          });
        } finally {
          if (stallTimer) {
            clearTimeout(stallTimer);
            stallTimer = null;
          }
        }

        attemptReceivedBytes = receivedBytesLocal;

        if (stallFired) {
          // Stream was torn down by the stall timer. Surface as a
          // download-phase error so the retry loop catches it.
          phaseError = new SyncPhaseError(
            'download',
            `Sin datos del servidor durante ${DOWNLOAD_STALL_TIMEOUT_MS / 1000} s`,
          );
        } else {
          // AC2: size check on the raw buffered body. AC2(c) compares
          // against the previous attempt's byte count — every failed
          // attempt feeds its size into the next call so the stability
          // rule can accept a stable different size.
          const sizeResult = validateDownloadSize({
            contentLength,
            contentEncoding,
            declaredSize,
            receivedBytes: receivedBytesLocal,
            previousReceivedBytes,
          });
          if (!sizeResult.ok) {
            const _reason: string = (sizeResult as { ok: false; reason: string }).reason;
            phaseError = new SyncPhaseError('download', _reason);
          } else {
            if (sizeResult.warning) {
              this.log.warn(`[download-validation] ${track.name}: ${sizeResult.warning}`);
            }
            // AC3: body fingerprint. Use a fixed 8KB header buffer to
            // validate magic bytes without loading the entire file into
            // memory. AC6 enforces a 2 GiB cap, but files approaching
            // that size could cause OOM if fully buffered. The fix is
            // streaming: open the temp file via `createReadStream`,
            // accumulate chunks until we hold HEADER_READ_BYTES (or the
            // stream ends), then stop reading and validate. The
            // `subarray` pattern from earlier cycles returned a *view*
            // into a full-file buffer that was already loaded into
            // heap — it did not free memory, only narrowed the window
            // the validator saw. With streaming, the FS read itself
            // stops at 8 KB for files large enough to make the
            // difference meaningful.
            const HEADER_READ_BYTES = 8 * 1024; // 8 KB
            const header = await readHeaderBytes(this.deps.fs, tmpPath, HEADER_READ_BYTES);
            const bodyResult = validateAudioBody(header);
            if (!bodyResult.ok) {
              const _reason: string = (bodyResult as { ok: false; reason: string }).reason;
              phaseError = new SyncPhaseError('validation', _reason);
            } else {
              // SUCCESS
              return {
                tmpPath,
                receivedBytes: receivedBytesLocal,
                contentLength,
                contentEncoding,
                contentType,
                declaredSize,
              };
            }
          }
        }
      } catch (error) {
        // MEDIUM-3: capture partial bytes from a failed download so
        // AC2(c)'s stability check sees the same byte count on retry
        // even when the failure was a network error, not a size/body
        // mismatch.
        attemptReceivedBytes = receivedBytesLocal;
        // Cancellation bubbles up untouched — the user has asked us to
        // stop and we do not retry that. `instanceof SyncCancelledError`
        // is exact; the previous `error.name === 'SyncCancelledError'`
        // string match was fragile if the class name ever changed or
        // another error happened to share it.
        if (error instanceof SyncCancelledError || this.cancellation.isCancelled()) {
          await this.deps.fs.unlink(tmpPath).catch(() => {});
          throw error;
        }
        if (error instanceof SyncPhaseError) {
          phaseError = error;
        } else {
          // Any other error from the pipe layer (RST, terminated,
          // network reset, ApiError from the HTTP layer). Surface as a
          // download-phase error so the UI sees one consistent shape.
          // Stalls get their own `DownloadStalledError` class, so
          // `instanceof` provides exact classification.
          if (error instanceof DownloadStalledError) {
            phaseError = new SyncPhaseError(
              'download',
              `Sin datos del servidor durante ${DOWNLOAD_STALL_TIMEOUT_MS / 1000} s`,
            );
          } else {
            const rawMessage = error instanceof Error ? error.message : String(error);
            // MEDIUM-1 + M-S2: scrub filesystem paths and credentials from
            // the user-visible error message. The full `rawMessage` may
            // contain local paths surfaced by the HTTP/IO layer; AC8
            // forbids exposing them. Match POSIX (`/…`), Windows
            // (`C:\…`, `C:/…`), and UNC (`\\server\share`) styles. The
            // `\\` case is the POSIX-escape interpretation; in the regex
            // it must be unescaped to `\\` to match a literal backslash.
            const sanitizedMessage = rawMessage
              .replace(/(?:[a-zA-Z]:)?[\\/][^\s:'"]+/g, '<path>')
              .slice(0, 200);
            phaseError = new SyncPhaseError('download', `Descarga fallida: ${sanitizedMessage}`);
          }
        }
      }

      // If we got here, phaseError is set. Capture the attempt's measured
      // size BEFORE unlinking so AC2(c) can compare it on the next
      // attempt (same body, same fingerprint, just different byte count).
      if (typeof attemptReceivedBytes === 'number') {
        previousReceivedBytes = attemptReceivedBytes;
      }
      // HIGH-3: wrap unlink in try/finally so the temp file is removed
      // even if the retry path or the final throw aborts unexpectedly.
      // The catch inside `delay`/`unlink` swallows IO errors that have
      // nothing to do with the download outcome.
      try {
        await this.deps.fs.unlink(tmpPath);
      } catch {
        // Best-effort cleanup; a missing temp file should not mask the
        // real failure surfaced via phaseError.
      }
      if (attempt < maxAttempts) {
        await this.delay(DOWNLOAD_RETRY_DELAYS_MS[attempt - 1]!);
        continue;
      }
      // Exhausted retries — throw the last phase error. The fallback
      // covers the (currently impossible) case where phaseError was
      // never assigned, so we never throw `null`.
      throw phaseError ?? new SyncPhaseError('download', 'Descarga fallida');
    }
    // Unreachable: the loop either returns or throws above. TS needs a
    // fall-through; if the for-loop body ever returns without throwing
    // (impossible today) we surface a generic failure.
    throw new SyncPhaseError('download', 'Descarga fallida tras varios intentos');
  }

  /**
   * Promise-friendly sleep. Used by the download retry loop (AC4). Pulled
   * out so tests can monkey-patch it if they ever need to skip the wait.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async copyTrackFile(
    track: TrackInfo,
    outputDir: string,
    outputPath: string,
    coverArtMode: CoverArtMode,
    trackMeta: TrackMetadata,
    options: ReturnType<typeof resolveSyncOptions>,
  ): Promise<number> {
    // ORAIN-0737 AC2: stream the download through a temp file under
    // os.tmpdir() with extension iff track.format names a known audio
    // format. Mirrors convertAndCopy and reuses buildCopyTrackTempPath so
    // the rules don't drift. The destination USB is NEVER written with a
    // temp file directly (no .jt-tmp-* artefacts left behind — AC4).
    const tmpPath = buildCopyTrackTempPath(track.format, Date.now());
    try {
      // ORAIN-0739: download + retry + stall + size + body validation in
      // one shot. Returns the buffered temp file (already validated) and
      // the three byte-count fields for the diagnostic log (AC8).
      await this._downloadWithValidation(track, tmpPath);

      // Check for cancellation after the download completes, mirroring the
      // convert path so cancel mid-pipe and cancel-after-pipe are handled
      // the same way.
      this.cancellation.throwIfCancelled();

      const embedMetadata = options.embedMetadata !== false;

      if (embedMetadata) {
        const embedCover =
          coverArtMode === 'embed'
            ? await this.getCoverArtBuffer(track.id, track.albumId, coverArtMode)
            : undefined;
        const originalMeta = await this.deps.converter.readFileMetadata(tmpPath);
        const mergedMeta = mergeMetadata(originalMeta, trackMeta);
        const result = await this.deps.converter.tagFile(
          tmpPath,
          outputPath,
          mergedMeta,
          embedCover,
        );
        if (!result.success) throw new Error(result.error ?? 'Tagging failed');

        if (coverArtMode === 'companion') {
          const coverBuffer = await this.getCoverArtBuffer(track.id, track.albumId, coverArtMode);
          if (coverBuffer) await this.writeCompanionCover(outputDir, coverBuffer);
        }
      } else {
        // No-metadata branch: copy the buffered temp directly onto the
        // destination. Use the existing fs.read+write path so the FileSystem
        // mock (which doesn't expose a true read stream) works unchanged.
        const data = await this.deps.fs.readFile(tmpPath);
        await this.deps.fs.writeFile(outputPath, data);
      }
      return track.size ?? 0;
    } finally {
      // AC4: unlink on every exit — success, FFmpeg failure, stream error,
      // cancellation. The `.catch(() => {})` pattern matches convertAndCopy
      // so a missing temp at cleanup time does not propagate.
      await this.deps.fs.unlink(tmpPath).catch(() => {});
    }
  }

  /**
   * Validate destination path
   */
  async validateDestination(path: string): Promise<DestinationValidation> {
    return validateDestination(path, this.deps.fs);
  }

  /**
   * Estimate total size for items
   * If syncedIds is provided, accumulates syncedMusicBytes and newMusicBytes separately
   */
  async estimateSize(
    itemIds: string[],
    itemTypes: Map<string, ItemType>,
    options?: {
      convertToMp3?: boolean;
      bitrate?: string;
      coverArtMode?: CoverArtMode;
      syncedIds?: Set<string>;
    },
  ): Promise<SizeEstimate> {
    const { tracks: rawTracks, errors: _errors } = await this.deps.api.getTracksForItems(
      itemIds,
      itemTypes,
    );
    const tracks = deduplicateTracks(rawTracks);

    // ORAIN-0738: route through estimateOutputBytes so the storage-bar total
    // matches the progress-bar total exactly. Cover bytes are counted when
    // the caller passes the same coverArtMode the sync will use, since the
    // preview's job is to show what the sync will write. In `companion` mode
    // each album's cover is counted once via `companionCoverAlbumIds`, like
    // runCopyPhase does.
    const convertToMp3 = options?.convertToMp3 === true;
    const targetBitrateKbps = parseBitrateKbps(options?.bitrate ?? '192k');
    const coverArtMode: CoverArtMode = options?.coverArtMode ?? 'off';

    const formatBreakdown = new Map<string, number>();
    const typeBreakdown = new Map<ItemType, number>();

    let totalBytes = 0;
    let syncedMusicBytes = 0;
    let newMusicBytes = 0;

    // Companion-mode deduplication: a single cover is written once per
    // album, no matter how many tracks share it. `runCopyPhase` keeps the
    // same invariant.
    const companionCoverAlbumIds = new Set<string>();
    if (coverArtMode === 'companion') {
      for (const t of tracks) {
        if (t.albumId) companionCoverAlbumIds.add(t.albumId);
      }
    }

    for (const track of tracks) {
      const addCover =
        coverArtMode === 'embed' ||
        (coverArtMode === 'companion' &&
          track.albumId !== undefined &&
          companionCoverAlbumIds.has(track.albumId));
      // Consume the per-album cover slot on the first companion track seen,
      // so only one track of an album carries the constant.
      if (coverArtMode === 'companion' && track.albumId !== undefined) {
        companionCoverAlbumIds.delete(track.albumId);
      }
      const effectiveSize = estimateOutputBytes(track, {
        convertToMp3,
        bitrate: '192k',
        targetBitrateKbps,
        coverArtMode,
        addCover,
      });

      totalBytes += effectiveSize;

      // Separate synced vs new if syncedIds provided
      if (options?.syncedIds?.has(track.id)) {
        syncedMusicBytes += effectiveSize;
      } else {
        newMusicBytes += effectiveSize;
      }

      // Format breakdown (report effective size per format)
      const fmt = (track.format ?? '').toLowerCase();
      formatBreakdown.set(fmt, (formatBreakdown.get(fmt) ?? 0) + effectiveSize);

      // Type breakdown
      const itemType = itemTypes.get(track.id);
      if (itemType) {
        typeBreakdown.set(itemType, (typeBreakdown.get(itemType) ?? 0) + effectiveSize);
      }
    }

    return {
      totalBytes,
      trackCount: tracks.length,
      formatBreakdown,
      typeBreakdown,
      syncedMusicBytes,
      newMusicBytes,
    };
  }

  /**
   * Remove synced items from destination.
   *
   * For playlist items:
   *   1. Delete the corresponding .m3u8 file.
   *   2. Only delete audio files that are NOT referenced by any remaining .m3u8
   *      on the device (to avoid breaking other playlists).
   * For artist/album items: same track-reference safety check applies.
   */
  async removeItems(
    itemIds: string[],
    itemTypes: Map<string, ItemType>,
    destinationPath: string,
  ): Promise<{ removed: number; errors: string[] }> {
    if (itemIds.length === 0) return { removed: 0, errors: [] };

    const { tracks: rawTracks } = await this.deps.api.getTracksForItems(itemIds, itemTypes);
    const tracks = deduplicateTracks(rawTracks);

    // Auto-detect serverRootPath if not set
    if (!this.serverRootPath && tracks.length > 0) {
      const detected = detectServerRootPath(tracks);
      if (detected) this.serverRootPath = detected;
    }

    const errors: string[] = [];
    let removed = 0;
    const dirsToClean = new Set<string>();

    // Step 1: Delete M3U8 files for playlist items being removed
    const playlistIds = itemIds.filter((id) => itemTypes.get(id) === 'playlist');
    for (const playlistId of playlistIds) {
      try {
        const info = await this.deps.api.getItem(playlistId);
        if (info?.name) {
          const safeName = info.name.replace(/[<>:"/\\|?*]/g, '_');
          const m3u8Path = `${destinationPath}/${safeName}.m3u8`;
          if (await this.deps.fs.exists(m3u8Path)) {
            await this.deps.fs.unlink(m3u8Path);
          }
        }
      } catch {
        /* non-fatal */
      }
    }

    if (tracks.length === 0) return { removed: 0, errors: [] };

    // Step 2: Collect all track paths still referenced by remaining M3U8 files.
    // This is done AFTER deleting the playlist M3U8s above, so tracks exclusive
    // to the removed playlists won't be protected.
    const protectedPaths = await this.getM3u8ReferencedPaths(destinationPath);

    // Step 3: Delete audio files not referenced by any remaining M3U8
    for (const track of tracks) {
      try {
        if (!track.path) continue;
        const outputDir = this.getOutputDir(track, destinationPath, true);
        const originalFilename = getFilenameFromPath(track.path);
        const mp3Filename = originalFilename.replace(/\.[^.]+$/, '.mp3');

        let deleted = false;
        for (const filename of [originalFilename, mp3Filename]) {
          const outputPath = `${outputDir}/${filename}`;
          if (!(await this.deps.fs.exists(outputPath))) continue;

          // Compute relative path for this specific file (respecting actual extension)
          if (this.serverRootPath && track.path) {
            const baseRelative = getRelativePath(track.path, this.serverRootPath);
            const ext = filename.match(/\.[^.]+$/)?.[0] ?? '';
            const relativePath = baseRelative.replace(/\.[^.]+$/, ext);
            if (protectedPaths.has(relativePath)) break; // referenced elsewhere
          } else if (protectedPaths.size > 0) {
            break; // can't compute relative path, be conservative
          }

          // AC-6: Delete the corresponding .lrc sidecar
          const lrcPath = outputPath.replace(/\.[^.]+$/, '.lrc');
          if (await this.deps.fs.exists(lrcPath)) {
            await this.deps.fs.unlink(lrcPath);
          }

          await this.deps.fs.unlink(outputPath);
          deleted = true;
          dirsToClean.add(outputDir);
          break;
        }
        if (deleted) removed++;
      } catch (error) {
        errors.push(
          `Failed to remove "${track.name}": ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    // AC-7: Detect and remove orphaned .lrc files in affected directories
    // (files without corresponding audio files)
    for (const dir of dirsToClean) {
      await this.cleanOrphanedLrcFiles(dir);
    }

    // AC-3: Clean cover.jpg from directories that are now empty of audio files
    for (const dir of dirsToClean) {
      await this.cleanCoverIfDirEmpty(dir);
    }

    // Clean up empty directories (deepest first)
    const sortedDirs = [...dirsToClean].sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
      await this.cleanEmptyDir(dir, destinationPath);
    }

    return { removed, errors };
  }

  /**
   * Read all .m3u8 files in the destination root and return the set of
   * relative track paths they reference (lines that don't start with #).
   */
  private async getM3u8ReferencedPaths(destinationPath: string): Promise<Set<string>> {
    const referenced = new Set<string>();
    try {
      const entries = await this.deps.fs.readdir(destinationPath);
      const m3u8Files = entries.filter((e) => e.toLowerCase().endsWith('.m3u8'));
      for (const m3u8File of m3u8Files) {
        try {
          const content = await this.deps.fs.readFile(`${destinationPath}/${m3u8File}`);
          for (const line of content.toString('utf8').split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) referenced.add(trimmed);
          }
        } catch {
          /* ignore unreadable files */
        }
      }
    } catch {
      /* ignore if destination doesn't exist */
    }
    return referenced;
  }

  /**
   * Test connection to Jellyfin
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    return this.deps.api.testConnection();
  }

  /**
   * Analyze diff between server tracks and device's synced tracks.
   * Used to show "out of sync" status in UI before confirming sync.
   *
   * @param preloadedTracks - Optional Map<itemId, TrackInfo[]> from shared cache.
   *   When provided, the method skips the internal api.getTracksForItems call,
   *   using the pre-loaded tracks instead. Eliminates redundant fetches when
   *   the caller (main process) has already populated the cache.
   */
  async analyzeDiff(
    itemIds: string[],
    itemTypes: Map<string, ItemType>,
    destinationPath: string,
    options: {
      coverArtMode: CoverArtMode;
      bitrate: '128k' | '192k' | '320k';
      convertToMp3: boolean;
    },
    preloadedTracks?: Map<string, TrackInfo[]>,
  ): Promise<SyncDiffResult> {
    // Resolve options to get filesystemType for path sanitization
    const resolvedOptions = resolveSyncOptions({
      convertToMp3: options.convertToMp3,
      bitrate: options.bitrate,
    });
    const filesystemType = resolvedOptions.filesystemType ?? 'unknown';

    // Get synced tracks from device DB
    const syncedTracks = getSyncedTracksForDevice(destinationPath);

    // Build lookup map: trackId → synced record
    const syncedMap = new Map<string, SyncedTrackRecord>();
    for (const t of syncedTracks) {
      syncedMap.set(t.trackId, t);
    }

    // AC-4: Use preloadedTracks when available; otherwise fetch from API
    let allServerTracks: TrackInfo[];
    let fetchErrors: string[];

    if (preloadedTracks && preloadedTracks.size > 0) {
      // Merge all preloaded tracks into a single array, grouped by parentItemId
      allServerTracks = [];
      for (const [itemId, tracks] of preloadedTracks) {
        for (const track of tracks) {
          allServerTracks.push({ ...track, parentItemId: itemId });
        }
      }
      // ORAIN-0709 (cycle 2 fix): deduplicate even when tracks come from the
      // preloaded cache — the cache may contain overlapping items (e.g. artist +
      // albumArtist + album + playlist all pointing to the same track pool).
      allServerTracks = deduplicateTracks(allServerTracks);
      fetchErrors = [];
    } else {
      // Fetch all tracks in a single batched call — no N+1
      const result = await this.deps.api.getTracksForItems(Array.from(itemIds), itemTypes);
      // ORAIN-0709: deduplicate to prevent inflated counts when selection overlaps
      allServerTracks = deduplicateTracks(result.tracks);
      fetchErrors = result.errors;
    }

    // Group tracks by parentItemId for efficient diff per item
    const tracksByItem = new Map<string, TrackInfo[]>();
    for (const track of allServerTracks) {
      const parentId = track.parentItemId ?? '';
      if (!tracksByItem.has(parentId)) {
        tracksByItem.set(parentId, []);
      }
      tracksByItem.get(parentId)!.push(track);
    }

    // Resolve playlist item names (needed because getPlaylistTracks doesn't include name)
    const playlistNames = new Map<string, string>();
    await Promise.all(
      itemIds
        .filter((id) => itemTypes.get(id) === 'playlist')
        .map(async (playlistId) => {
          const info = await this.deps.api.getItem(playlistId);
          if (info) playlistNames.set(playlistId, info.name);
        }),
    );

    // Build itemErrors from fetch errors
    const itemErrors: { itemId: string; itemName: string; error: string }[] = fetchErrors
      .filter((e) => e.includes('Failed to fetch'))
      .map((e) => {
        // Parse "Failed to fetch {type} {id}: {message}"
        const typeMatch = e.match(/Failed to fetch (artist|album|playlist) (.+?):/);
        const itemId = typeMatch ? typeMatch[2] : 'unknown';
        return { itemId, itemName: itemId, error: e };
      });

    // Auto-detect serverRootPath from first fetch
    if (allServerTracks.length > 0) {
      const detected = detectServerRootPath(allServerTracks);
      if (detected) {
        this.serverRootPath = detected;
      }
    }

    // v1→v2 retrocompatibility: build set of item IDs synced with v1 (synced_files table).
    // Items here have no synced_tracks entries. We treat them as fully unchanged to prevent
    // false "out of sync" after an app update. Once a v2 sync runs, synced_tracks gets
    // populated and normal diff logic takes over.
    const legacySyncedItemIds = new Set(getSyncedItems(destinationPath).map((i) => i.id));

    const itemDiffs: ItemDiff[] = [];
    let totalNew = 0;
    let totalMetaChanged = 0;
    let totalRemoved = 0;
    let totalPathChanged = 0;
    let totalUnchanged = 0;

    for (const itemId of itemIds) {
      const itemType = itemTypes.get(itemId) ?? 'album';
      const itemName = itemType === 'playlist' ? (playlistNames.get(itemId) ?? itemId) : itemId;

      const serverTracks = tracksByItem.get(itemId) ?? [];

      // Get synced tracks for this specific item from DB
      const syncedItemTracks = getSyncedTracksForItem(destinationPath, itemId);
      const syncedItemMap = new Map<string, SyncedTrackRecord>();
      for (const s of syncedItemTracks) {
        syncedItemMap.set(s.trackId, s);
      }

      // v1→v2 retrocompatibility: if this item was synced with v1 (present in synced_files)
      // but has no track-level records in synced_tracks, treat all server tracks as unchanged.
      // This prevents false "out of sync" after an app update. Once a v2 sync runs and writes
      // synced_tracks records, this early-return is no longer triggered and normal diff resumes.
      if (syncedItemTracks.length === 0 && legacySyncedItemIds.has(itemId)) {
        const unchangedChanges: TrackChange[] = serverTracks.map((t) => ({
          trackId: t.id,
          trackName: t.name,
          changeType: 'unchanged' as const,
        }));
        totalUnchanged += unchangedChanges.length;
        itemDiffs.push({
          itemId,
          itemName,
          itemType,
          changes: unchangedChanges,
          summary: {
            new: 0,
            metadataChanged: 0,
            removed: 0,
            pathChanged: 0,
            unchanged: unchangedChanges.length,
          },
        });
        continue;
      }

      const changes: TrackChange[] = [];

      // For artists: track changes grouped by album (parentItemId)
      const albumChanges = new Map<
        string,
        { newTracks: number; metadataChanged: number; pathChanged: number }
      >();

      // Detect new / changed / unchanged server tracks
      for (const track of serverTracks) {
        const synced = syncedItemMap.get(track.id);
        const trackMeta = this.buildMetadata(track);
        const currentHash = computeMetadataHash(trackMeta);

        if (!synced) {
          changes.push({ trackId: track.id, trackName: track.name, changeType: 'new' });
          totalNew++;
          // Track new status in albumChanges if parentItemId available
          if (track.parentItemId) {
            const prev = albumChanges.get(track.parentItemId) ?? {
              newTracks: 0,
              metadataChanged: 0,
              pathChanged: 0,
            };
            albumChanges.set(track.parentItemId, {
              newTracks: prev.newTracks + 1,
              metadataChanged: prev.metadataChanged,
              pathChanged: prev.pathChanged,
            });
          }
        } else if (synced.metadataHash !== currentHash) {
          changes.push({
            trackId: track.id,
            trackName: track.name,
            changeType: 'metadata_changed',
          });
          totalMetaChanged++;
          if (track.parentItemId) {
            const prev = albumChanges.get(track.parentItemId) ?? {
              newTracks: 0,
              metadataChanged: 0,
              pathChanged: 0,
            };
            albumChanges.set(track.parentItemId, {
              newTracks: prev.newTracks,
              metadataChanged: prev.metadataChanged + 1,
              pathChanged: prev.pathChanged,
            });
          }
        } else if (options.convertToMp3 && synced.encodedBitrate !== options.bitrate) {
          changes.push({ trackId: track.id, trackName: track.name, changeType: 'bitrate_changed' });
          totalMetaChanged++;
          if (track.parentItemId) {
            const prev = albumChanges.get(track.parentItemId) ?? {
              newTracks: 0,
              metadataChanged: 0,
              pathChanged: 0,
            };
            albumChanges.set(track.parentItemId, {
              newTracks: prev.newTracks,
              metadataChanged: prev.metadataChanged + 1,
              pathChanged: prev.pathChanged,
            });
          }
        } else if (synced.coverArtMode !== options.coverArtMode) {
          changes.push({
            trackId: track.id,
            trackName: track.name,
            changeType: 'cover_art_changed',
          });
          totalMetaChanged++;
          if (track.parentItemId) {
            const prev = albumChanges.get(track.parentItemId) ?? {
              newTracks: 0,
              metadataChanged: 0,
              pathChanged: 0,
            };
            albumChanges.set(track.parentItemId, {
              newTracks: prev.newTracks,
              metadataChanged: prev.metadataChanged + 1,
              pathChanged: prev.pathChanged,
            });
          }
        } else {
          // Legacy records (serverRootPath = NULL) cannot be reliably path-compared:
          // we don't know what root was in effect at original sync time, and
          // detectServerRootPath may produce a different or empty root for the batch.
          // Hash comparison above already catches real content changes (bitrate, metadata,
          // cover art). Mark as unchanged to prevent false path_changed on v1→v2 migration.
          // Once the track is re-synced with v2 code, a proper serverRootPath is stored
          // and path comparison resumes correctly.
          if (synced.serverRootPath === null) {
            changes.push({ trackId: track.id, trackName: track.name, changeType: 'unchanged' });
            totalUnchanged++;
          } else {
            const rootPathForDiff = synced.serverRootPath;
            const serverPathForDiff = synced.serverPath ?? track.path;
            const outputDir = this.getOutputDir(
              { ...track, path: serverPathForDiff },
              destinationPath,
              true,
              filesystemType,
              rootPathForDiff,
            );
            const outputFilename = this.resolveCanonicalFilename(
              { ...track, path: serverPathForDiff },
              resolvedOptions,
            );
            const expectedPath = `${outputDir}/${outputFilename}`;
            if (synced.destinationPath !== expectedPath) {
              changes.push({
                trackId: track.id,
                trackName: track.name,
                changeType: 'path_changed',
              });
              totalPathChanged++;
              if (track.parentItemId) {
                const prev = albumChanges.get(track.parentItemId) ?? {
                  newTracks: 0,
                  metadataChanged: 0,
                  pathChanged: 0,
                };
                albumChanges.set(track.parentItemId, {
                  newTracks: prev.newTracks,
                  metadataChanged: prev.metadataChanged,
                  pathChanged: prev.pathChanged + 1,
                });
              }
            } else {
              changes.push({ trackId: track.id, trackName: track.name, changeType: 'unchanged' });
              totalUnchanged++;
            }
          }
        }
      }

      // Detect removed tracks: in synced DB for this item but not on server
      for (const synced of syncedItemTracks) {
        if (!serverTracks.find((t) => t.id === synced.trackId)) {
          changes.push({
            trackId: synced.trackId,
            trackName: synced.trackId,
            changeType: 'removed',
          });
          totalRemoved++;
        }
      }

      // For artist items, compute sub-items (per-album breakdown)
      // albumChanges tracks metadata/path changes by parentItemId (album ID)
      const subItems: ItemDiff['subItems'] =
        itemType === 'artist' && albumChanges.size > 0
          ? [...albumChanges.entries()].map(([id, s]) => ({ itemId: id, summary: s }))
          : undefined;

      itemDiffs.push({
        itemId,
        itemName,
        itemType,
        changes,
        summary: {
          new: changes.filter((c) => c.changeType === 'new').length,
          metadataChanged: changes.filter((c) =>
            ['metadata_changed', 'cover_art_changed', 'bitrate_changed'].includes(c.changeType),
          ).length,
          removed: changes.filter((c) => c.changeType === 'removed').length,
          pathChanged: changes.filter((c) => c.changeType === 'path_changed').length,
          unchanged: changes.filter((c) => c.changeType === 'unchanged').length,
        },
        ...(subItems && { subItems }),
      });
    }

    return {
      items: itemDiffs,
      totals: {
        newTracks: totalNew,
        metadataChanged: totalMetaChanged,
        removed: totalRemoved,
        pathChanged: totalPathChanged,
        unchanged: totalUnchanged,
      },
      itemErrors: itemErrors.length > 0 ? itemErrors : undefined,
    };
  }

  // Private helpers

  /**
   * Get output directory path.
   * Preserves original server path structure when available; falls back to metadata.
   *
   * @param track - Track with path used to compute relative path
   * @param basePath - Destination base path
   * @param preserveStructure - Whether to preserve folder structure
   * @param filesystemType - Filesystem type for sanitization
   * @param serverRootPathOverride - Optional serverRootPath override. When provided,
   *   this overrides the instance serverRootPath. This is used during diff analysis
   *   where per-track serverRootPath (stored at sync time) must be respected instead
   *   of the current instance value (which may have been auto-detected differently).
   */
  private getOutputDir(
    track: { path: string; artists?: string[]; album?: string; year?: number },
    basePath: string,
    preserveStructure: boolean,
    filesystemType: FilesystemType = 'unknown',
    serverRootPathOverride?: string,
  ): string {
    // Prefer per-track override (from sync-time storage), fall back to instance value
    const effectiveRootPath = serverRootPathOverride ?? this.serverRootPath;
    const serverRelativePath = effectiveRootPath
      ? getRelativePath(track.path, effectiveRootPath)
      : preserveStructure && track.path
        ? track.path
        : null;

    if (serverRelativePath) {
      validatePathTraversal(basePath, serverRelativePath);
      const parts = serverRelativePath.split('/');
      if (parts.length > 1) {
        parts.pop(); // remove filename
        const sanitized = parts.map((p) =>
          sanitizePathComponent(p, { platform: this.platform, filesystem: filesystemType }),
        );
        return `${basePath}/${sanitized.join('/')}`;
      }
      return basePath;
    }

    // Metadata fallback when no path available
    const parts = [basePath, 'lib'];

    if (track.artists?.[0]) {
      const artist = sanitizePathComponent(
        track.artists[0].replace(/[<>:"/\\|?*]/g, '_').slice(0, 100),
        { platform: this.platform, filesystem: filesystemType },
      );
      parts.push(artist);
    }

    if (track.album) {
      let folder = track.album.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
      if (track.year) folder += ` (${track.year})`;
      parts.push(
        sanitizePathComponent(folder, { platform: this.platform, filesystem: filesystemType }),
      );
    }

    return parts.join('/');
  }

  /**
   * Get output filename
   * Uses original filename from server path if available, otherwise reconstructs from metadata
   */
  /**
   * Resolve the canonical (non-suffixed) output filename for a track.
   * This is used to check if the file already exists before deciding
   * whether to skip, overwrite, or download.
   */
  private resolveCanonicalFilename(
    track: {
      name: string;
      path: string;
      format: string;
      trackNumber?: number;
      artists?: string[];
      album?: string;
    },
    options: ReturnType<typeof resolveSyncOptions>,
  ): string {
    if (track.path) {
      return this.resolveFilenameFromPath(track, options);
    }
    return this.buildFilenameFromMetadata(track, options);
  }

  private resolveFilenameFromPath(
    track: { path: string; format: string },
    options: ReturnType<typeof resolveSyncOptions>,
  ): string {
    let filename = getFilenameFromPath(track.path);

    if (hasTraversalSegment(filename) || filename.includes('/') || filename.includes('\\')) {
      throw new Error(`Invalid filename: path traversal detected in "${filename}"`);
    }

    // Apply filesystem-specific sanitization (handles FAT32/exFAT/NTFS invalid chars,
    // trailing dots/spaces, reserved names, length limits). Platform is injected
    // so win32 sanitizes even when filesystemType is 'unknown' (ORAIN-0725).
    filename = sanitizePathComponent(filename, {
      platform: this.platform,
      filesystem: options.filesystemType,
    });

    // Fallback: replace any remaining forbidden chars for non-Windows filesystems
    filename = filename.replace(/[<>:"|?*]/g, '_');

    if (options.convertToMp3 && !filename.toLowerCase().endsWith('.mp3')) {
      filename = filename.replace(/\.[^.]+$/, '.mp3');
    }

    return filename;
  }

  private buildFilenameFromMetadata(
    track: {
      name: string;
      format: string;
      trackNumber?: number;
      artists?: string[];
      album?: string;
    },
    options: ReturnType<typeof resolveSyncOptions>,
  ): string {
    const extension = options.convertToMp3 ? 'mp3' : track.format.toLowerCase();
    const baseName = track.name.replace(/[<>:"/\\|?*]/g, '_');
    const artistName = track.artists?.[0]?.replace(/[<>:"/\\|?*]/g, '_') ?? 'Unknown Artist';
    const albumName = track.album?.replace(/[<>:"/\\|?*]/g, '_') ?? 'Unknown Album';

    if (track.trackNumber && options.preserveStructure) {
      const trackNum = String(track.trackNumber).padStart(2, '0');
      return `${artistName} - ${albumName} - ${trackNum} - ${baseName}.${extension}`;
    }

    return `${baseName}.${extension}`;
  }

  /**
   * Generate M3U8 playlist files in the destination root.
   * Each file uses relative paths to audio files under lib/.
   */
  private async generateM3u8Files(
    playlistIds: string[],
    destinationPath: string,
    options: ReturnType<typeof resolveSyncOptions>,
  ): Promise<void> {
    for (const playlistId of playlistIds) {
      try {
        const [info, tracks] = await Promise.all([
          this.deps.api.getItem(playlistId),
          this.deps.api.getPlaylistTracks(playlistId),
        ]);

        const playlistName = info?.name ?? `Playlist_${playlistId.slice(0, 8)}`;
        const safeName = playlistName.replace(/[<>:"/\\|?*]/g, '_');
        const m3u8Path = `${destinationPath}/${safeName}.m3u8`;

        const lines = ['#EXTM3U'];
        for (const track of tracks) {
          if (!track.path || !this.serverRootPath) continue;
          let relativePath = getRelativePath(track.path, this.serverRootPath);
          if (!relativePath) continue;

          // Adjust extension if tracks were converted to MP3
          if (options.convertToMp3 && !relativePath.toLowerCase().endsWith('.mp3')) {
            relativePath = relativePath.replace(/\.[^.]+$/, '.mp3');
          }

          // Apply the same per-component sanitization used when writing files, so
          // M3U8 entries match the actual paths on disk (critical for FAT32/exFAT/NTFS).
          // Platform injection is required by ORAIN-0725 so win32 sanitizes even
          // when filesystemType is 'unknown'.
          const fs = options.filesystemType ?? 'unknown';
          if (fs !== 'unknown' || this.platform === 'win32') {
            relativePath = relativePath
              .split('/')
              .map((segment) =>
                sanitizePathComponent(segment, { platform: this.platform, filesystem: fs }),
              )
              .join('/');
          }

          const artistLabel = track.artists?.join(', ') ?? track.albumArtist ?? '';
          const displayName = artistLabel ? `${artistLabel} - ${track.name}` : track.name;
          lines.push(`#EXTINF:-1,${displayName}`);
          lines.push(relativePath);
        }

        await this.deps.fs.writeFile(m3u8Path, Buffer.from(lines.join('\n') + '\n', 'utf8'));
        this.log.info(`M3U8 written: ${safeName}.m3u8 (${lines.length - 1} tracks)`);
      } catch (error) {
        this.log.warn(
          `M3U8 generation failed for playlist ${playlistId}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
  }

  private readonly SYSTEM_FILES = new Set([
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
    '.Spotlight-V100',
    '.Trashes',
  ]);

  private isMusicFile(name: string): boolean {
    // Any non-system, non-hidden file counts as content
    return !name.startsWith('.') && !this.SYSTEM_FILES.has(name);
  }

  private async cleanEmptyDir(dir: string, basePath: string): Promise<void> {
    if (dir === basePath || !dir.startsWith(basePath + '/')) return;
    try {
      const contents = await this.deps.fs.readdir(dir);
      const meaningfulContents = contents.filter((f) => this.isMusicFile(f));
      if (meaningfulContents.length === 0) {
        // Delete system/hidden files first so rmdir can succeed
        for (const f of contents) {
          try {
            await this.deps.fs.unlink(`${dir}/${f}`);
          } catch {
            /* ignore */
          }
        }
        await this.deps.fs.rmdir(dir);
        const parent = path.dirname(dir);
        await this.cleanEmptyDir(parent, basePath);
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  private async deleteAlternateFormats(outputDir: string, targetFilename: string): Promise<void> {
    const baseName = targetFilename.replace(/\.[^.]+$/, '');
    const targetExt = (targetFilename.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();

    for (const ext of ALL_AUDIO_EXTENSIONS) {
      if (ext === targetExt) continue;
      const altPath = `${outputDir}/${baseName}.${ext}`;
      try {
        if (await this.deps.fs.exists(altPath)) {
          await this.deps.fs.unlink(altPath);
        }
      } catch {
        // non-fatal: continue to next extension
      }
    }
  }

  /**
   * Clean up .lrc sidecar files for tracks that were synced with embed mode.
   * When switching to embed, existing .lrc files from prior syncs should be removed
   * silently as part of the cleanup phase.
   */
  private async cleanLrcFilesForEmbedMode(
    destinationPath: string,
    syncedBasenames: Set<string>,
  ): Promise<void> {
    if (syncedBasenames.size === 0) {
      return;
    }

    // Walk the destination tree to find and remove .lrc files whose base name
    // matches any of the synced track basenames
    const toRemove: string[] = [];
    await this.walkAndCleanLrc(destinationPath, syncedBasenames, toRemove);

    for (const lrcPath of toRemove) {
      try {
        await this.deps.fs.unlink(lrcPath);
        this.log.debug(`Removed stale LRC: ${lrcPath}`);
      } catch {
        /* non-fatal */
      }
    }
  }

  private async walkAndCleanLrc(
    dir: string,
    basenames: Set<string>,
    toRemove: string[],
  ): Promise<void> {
    try {
      const entries = await this.deps.fs.readdir(dir);
      for (const entry of entries) {
        const fullPath = `${dir}/${entry}`;
        try {
          const isDir = await this.deps.fs.isDirectory(fullPath);
          // Also check if it's an "implicit" directory (has files under it but not explicitly marked)
          const fsAny = this.deps.fs as unknown as Record<string, unknown>;
          const isImplicitDir =
            !isDir &&
            typeof fsAny.__isImplicitDir === 'function' &&
            fsAny.__isImplicitDir(fullPath);
          if (isDir || isImplicitDir) {
            // Recurse into directory (explicit or implicit)
            await this.walkAndCleanLrc(fullPath, basenames, toRemove);
          } else if (entry.toLowerCase().endsWith('.lrc')) {
            const baseName = entry.replace(/\.lrc$/i, '');
            if (basenames.has(baseName)) {
              toRemove.push(fullPath);
            }
          }
        } catch {
          /* skip unreadable entries */
        }
      }
    } catch {
      /* ignore inaccessible directories */
    }
  }

  /**
   * Detect and remove orphaned .lrc files in a directory.
   * An orphaned LRC has no corresponding audio file (same base name, different extension).
   */
  private async cleanOrphanedLrcFiles(dir: string): Promise<void> {
    try {
      const entries = await this.deps.fs.readdir(dir);
      const lrcFiles = entries.filter((e) => e.toLowerCase().endsWith('.lrc'));

      for (const lrcFile of lrcFiles) {
        const baseName = lrcFile.replace(/\.lrc$/i, '');
        const audioExtensions = ALL_AUDIO_EXTENSIONS;

        // Check if any audio file with the same base name exists
        const hasAudio = audioExtensions.some(
          (ext) =>
            entries.includes(`${baseName}.${ext}`) ||
            entries.includes(`${baseName}.${ext.toUpperCase()}`),
        );

        if (!hasAudio) {
          try {
            await this.deps.fs.unlink(`${dir}/${lrcFile}`);
            this.log.debug(`Removed orphaned LRC: ${dir}/${lrcFile}`);
          } catch {
            /* non-fatal */
          }
        }
      }
    } catch {
      /* ignore errors during cleanup */
    }
  }

  /**
   * AC-3: Remove cover.jpg from a directory if it has no audio files.
   * Called after track deletion to clean up stale covers from now-empty dirs.
   */
  private async cleanCoverIfDirEmpty(dir: string): Promise<void> {
    try {
      const entries = await this.deps.fs.readdir(dir);
      const hasAudio = ALL_AUDIO_EXTENSIONS.some((ext) =>
        entries.some((e) => e.toLowerCase().endsWith(`.${ext.toLowerCase()}`)),
      );
      if (hasAudio) return; // directory still has audio files, keep cover.jpg

      const coverPath = `${dir}/cover.jpg`;
      if (await this.deps.fs.exists(coverPath)) {
        await this.deps.fs.unlink(coverPath);
        this.log.debug(`Removed cover.jpg from empty directory: ${dir}`);
      }
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Clean up cover.jpg companion files for tracks that were synced with companion mode
   * but are now being synced with embed or off mode.
   * AC-1: Removes cover.jpg from dirs when switching from companion to non-companion mode.
   * AC-4: Scoped to DB-tracked track directories only (no global filesystem walk).
   */
  private async cleanCoverFilesForNonCompanionMode(
    _destinationPath: string,
    coverJpgPaths: string[],
  ): Promise<void> {
    for (const coverPath of coverJpgPaths) {
      try {
        const exists = await this.deps.fs.exists(coverPath);
        if (exists) {
          await this.deps.fs.unlink(coverPath);
          this.log.debug(`Removed stale cover.jpg: ${coverPath}`);
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  /**
   * Strip embedded cover art from a track file when switching to companion mode.
   * Uses the converter's stripCoverArt method with ffprobe early exit.
   * AC-2: Strip embedded cover when switching from embed to companion mode.
   */
  private async stripCoverFromTrack(inputPath: string, outputPath: string): Promise<void> {
    try {
      const result = await this.deps.converter.stripCoverArt(inputPath, outputPath);
      if (result.success) {
        this.log.debug(`Cover strip operation completed for: ${inputPath}`);
      } else {
        this.log.warn(`Failed to strip cover from ${inputPath}: ${result.error}`);
      }
    } catch (err) {
      this.log.warn(`Cover strip error for ${inputPath}: ${err}`);
    }
  }

  /**
   * Build TrackMetadata from a TrackInfo — only fields with values are set,
   * so FFmpeg only writes non-empty fields (doesn't clear existing tags).
   */
  private buildMetadata(track: TrackInfo): TrackMetadata {
    return {
      title: track.name,
      artist: track.artists?.join('; '),
      albumArtist:
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- Empty string must become undefined, not empty string
        track.albumArtist || undefined,
      album: track.album,
      year: track.year?.toString(),
      trackNumber: track.trackNumber !== undefined ? String(track.trackNumber) : undefined,
      discNumber: track.discNumber !== undefined ? String(track.discNumber) : undefined,
      genres: track.genres,
    };
  }

  /**
   * Fetch cover art for a track if the mode requires it.
   * Uses albumId for caching to avoid N HTTP requests for the same album's cover.
   * Returns undefined when coverArtMode is 'off' or on error (non-blocking).
   */
  private async getCoverArtBuffer(
    trackId: string,
    albumId: string | undefined,
    mode: CoverArtMode,
  ): Promise<Buffer | undefined> {
    if (mode === 'off') return undefined;

    // Check cache first using albumId
    const cacheKey = albumId ?? trackId;
    if (this.coverArtCache.has(cacheKey)) {
      return this.coverArtCache.get(cacheKey);
    }

    try {
      const buffer = await this.deps.api.getCoverArt(trackId);

      // Discard cover art exceeding 5MB to avoid embedding bloated images
      const MAX_COVER_SIZE = 5 * 1024 * 1024; // 5 MB
      if (buffer.length > MAX_COVER_SIZE) {
        this.progressEmitter.emit({
          phase: this.currentPhase,
          current: 0,
          total: 0,
          warning: 'cover_art_too_large',
        });
        this.log.warn(
          `Cover art for track ${trackId} exceeds 5 MB (${buffer.length} bytes) — discarding`,
        );
        return undefined;
      }

      this.coverArtCache.set(cacheKey, buffer);
      return buffer;
    } catch {
      this.coverArtFailCount++;
      if (this.coverArtFailCount === 1) {
        this.progressEmitter.emit({
          phase: this.currentPhase,
          current: 0,
          total: 0,
          warning: 'cover_art_unavailable',
        });
      }
      this.log.warn(`Cover art not available for track ${trackId}`);
      return undefined;
    }
  }

  /**
   * Write cover.jpg companion file to an album directory (once per directory).
   *
   * The directory is marked as processed only after a successful write:
   * if the write fails the next track in the same directory will retry
   * instead of silently being left without a cover.jpg. Today's sync
   * pipeline is sequential so the race doesn't materialise, but adding
   * before the await would silently break a future concurrent path.
   */
  private async writeCompanionCover(dir: string, coverBuffer: Buffer): Promise<void> {
    if (this.processedCoverDirs.has(dir)) return;
    try {
      await this.deps.fs.writeFile(`${dir}/cover.jpg`, coverBuffer);
      this.processedCoverDirs.add(dir);
      this.log.debug(`Companion cover written: ${dir}/cover.jpg`);
    } catch (err) {
      this.log.warn(
        `Failed to write companion cover in ${dir}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Process lyrics for a track based on the lyrics mode.
   * Returns 1 if lyrics were successfully added, 0 otherwise.
   */
  private async processLyrics(
    track: TrackInfo,
    outputPath: string,
    lyricsMode: LyricsMode,
  ): Promise<number> {
    if (lyricsMode === 'off') return 0;

    try {
      const lyrics = await this.deps.api.fetchLyrics(track.id);
      if (!lyrics) return 0;

      if (lyricsMode === 'lrc') {
        // Write LRC sidecar file alongside the audio
        const lrcPath = outputPath.replace(/\.[^.]+$/, '.lrc');
        await this.deps.fs.writeFile(lrcPath, Buffer.from(lyrics, 'utf8'));
        this.log.debug(`LRC file written: ${lrcPath}`);
        return 1;
      }

      if (lyricsMode === 'embed') {
        // Embed lyrics into the audio file
        // For embed mode, strip LRC timestamps — plain text works with more players
        const plainTextLyrics = lyrics.replace(/^\[\d{2}:\d{2}\.\d{2}\]/gm, '').trim();
        const format = track.format.toLowerCase();
        const result = await this.deps.converter.embedLyrics?.(
          outputPath,
          outputPath,
          plainTextLyrics,
          format,
        );
        if (result?.success) {
          this.log.debug(`Lyrics embedded in: ${outputPath}`);
          return 1;
        }
        if (result?.error) {
          this.log.warn(`Failed to embed lyrics in ${outputPath}: ${result.error}`);
        }
        return 0;
      }

      return 0;
    } catch (error) {
      // Non-fatal: skip lyrics for this track
      const message = `Could not process lyrics for ${track.name}: ${error instanceof Error ? error.message : 'unknown error'}`;
      // Pre-10.9 servers may return 501/405/etc. — distinguish from 404 to make production errors visible
      if (error instanceof ApiError && error.statusCode === 404) {
        this.log.debug(message);
      } else {
        this.log.warn(message);
      }
      return 0;
    }
  }

  /**
   * Embed ReplayGain tags into a track file.
   * Non-blocking: skips silently if no ReplayGain data is available.
   */
  private async processReplayGain(track: TrackInfo, outputPath: string): Promise<void> {
    try {
      const replayGain = await this.deps.api.fetchReplayGain(track.id);
      if (!replayGain) return;

      const format = track.format.toLowerCase();
      const result = await this.deps.converter.embedReplayGain?.(
        outputPath,
        outputPath,
        replayGain,
        format,
      );
      if (result?.success) {
        this.log.debug(`ReplayGain embedded in: ${outputPath}`);
      } else if (result?.error) {
        this.log.warn(`Failed to embed ReplayGain in ${outputPath}: ${result.error}`);
      }
    } catch (error) {
      // Non-fatal: skip ReplayGain for this track
      this.log.debug(
        `Could not process ReplayGain for ${track.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
  private async convertAndCopy(
    track: TrackInfo,
    outputPath: string,
    bitrate: '128k' | '192k' | '320k',
    embedMetadata: boolean,
    coverArtMode: CoverArtMode,
  ): Promise<void> {
    // ORAIN-0732 AC4: extension is appended only when track.format names a
    // recognised audio format from ALL_AUDIO_EXTENSIONS; unknown / unsafe /
    // empty values yield a bare temp path so FFmpeg falls back to content
    // sniffing. The membership check and `os.tmpdir()` placement live in
    // `buildConvertTempPath` (tested by temp-path.test.ts).
    //
    // ORAIN-0732 AC3: the temp file lives under os.tmpdir(), NEVER next to
    // `outputPath` (USB). Reasons: USB wear on FAT32/exFAT, crash leftovers
    // surfacing as broken tracks on the player, Windows MAX_PATH on FAT32,
    // and Snap confinement blocking writes under $HOME on removable-media.
    const tmpPath = buildConvertTempPath(track.format, Date.now());

    // ORAIN-0732 AC6 (cycle 2): wrap the download pipe and the conversion in
    // a single try/finally so the temp file is unlinked on EVERY exit path —
    // download failure, cancellation, conversion failure, or success. The
    // pipe previously lived outside the try block, so a stream error
    // (network, disk full, cancelled response) rejected the promise before
    // entering the try, leaking the partial temp file in os.tmpdir().
    try {
      // ORAIN-0739: download + retry + stall + size + body validation in
      // one shot. The returned `downloadContentType` / `downloadContentLength`
      // are needed by the diagnostic log (AC8). FFmpeg only runs if the
      // buffered body passed the fingerprint check (AC1).
      const downloadResult = await this._downloadWithValidation(track, tmpPath);
      const downloadContentType = downloadResult.contentType;
      const downloadContentLength = downloadResult.contentLength;

      // Check for cancellation after download stream is buffered, before expensive conversion.
      this.cancellation.throwIfCancelled();

      let metadata: TrackMetadata = {};
      if (embedMetadata) {
        // Read original file metadata and merge with Jellyfin fields — Jellyfin wins on conflicts
        const originalMeta = await this.deps.converter.readFileMetadata(tmpPath);
        const jellyfinMeta = this.buildMetadata(track);
        metadata = mergeMetadata(originalMeta, jellyfinMeta);
      }

      const embedCover =
        coverArtMode === 'embed'
          ? await this.getCoverArtBuffer(track.id, track.albumId, coverArtMode)
          : undefined;

      // Convert directly from the buffered temp file path — no read stream.
      // ORAIN-0732 AC1: FFmpeg receives -i file:<path> and can seek/sniff
      // the original format. The temp file is unlinked in the finally
      // block below.
      const result = await this.deps.converter.convertStreamToMp3WithMeta(
        tmpPath,
        outputPath,
        bitrate,
        metadata,
        embedCover,
      );
      if (!result.success) {
        // ORAIN-0729 + ORAIN-0739 AC8: emit a diagnostic log line so the
        // next failure does not require asking the reporter what FFmpeg
        // received. The five AC1 fields are logged plus the three byte
        // counts (receivedBytes vs contentLength vs declaredSize) as
        // separate fields — this is the AC8 fix the 0.7.2 release was
        // shipping wrong.
        await this.logConversionFailureDiagnostic(
          track,
          tmpPath,
          downloadContentType,
          downloadContentLength,
          downloadResult.receivedBytes,
          downloadResult.declaredSize,
          result.error,
        );
        throw new Error(result.error ?? 'Conversion failed');
      }
    } finally {
      await this.deps.fs.unlink(tmpPath).catch(() => {}); // always clean up temp
    }
  }

  /**
   * ORAIN-0729: log a diagnostic line when FFmpeg conversion fails so the
   * support flow can identify what FFmpeg received without asking the
   * reporter. Five fields, one log line:
   *   - format reported by Jellyfin (track.format)
   *   - extension from the server path (track.path)
   *   - Content-Type header of the download response
   *   - size in bytes (track.size, or measured temp-file size as fallback)
   *   - first 16 bytes of the buffered temp file, in hex
   *
   * ORAIN-0739 AC8: the prior release logged `size=track.size` and called
   * it the bytes FFmpeg received — but `track.size` is what Jellyfin
   * says about the original on-disk file, NOT what the proxy delivered.
   * Now we log three separate fields:
   *   - receivedBytes: bytes actually buffered into the temp file
   *   - contentLength: the Content-Length header value
   *   - declaredSize: track.size (Jellyfin's view of the original)
   * `size=…` is kept (now sourced from the temp file's stat, falling back
   * to track.size) so the existing log scrapers still find a token by
   * that name.
   *
   * Logging happens BEFORE the throw so the existing error envelope
   * (sync-failed popup) keeps its behaviour unchanged.
   */
  private async logConversionFailureDiagnostic(
    track: TrackInfo,
    tmpPath: string,
    downloadContentType: string | undefined,
    downloadContentLength: number | undefined,
    receivedBytes: number | undefined,
    declaredSize: number | undefined,
    ffmpegError: string | undefined,
  ): Promise<void> {
    let size: number | undefined = typeof track.size === 'number' ? track.size : undefined;
    let first16Hex = 'unavailable';
    try {
      const stat = await this.deps.fs.stat(tmpPath);
      // Prefer the measured temp-file size; fall back to track.size only
      // if stat somehow fails (it shouldn't for a file we just wrote).
      size = stat.size;
      // Best-effort: read the first 16 bytes of the temp file. If the file
      // is empty or unreadable, leave the placeholder so the log line is
      // still well-formed.
      const buf = await this.deps.fs.readFile(tmpPath);
      if (buf.length > 0) {
        first16Hex = buf.subarray(0, 16).toString('hex');
      }
    } catch {
      // Don't let a diagnostic read failure mask the original conversion
      // error. Fallbacks above keep the log line well-formed.
    }

    const extension = (() => {
      const path = track.path ?? '';
      const idx = path.lastIndexOf('.');
      return idx >= 0 ? path.slice(idx).toLowerCase() : '(none)';
    })();

    this.log.warn(
      `[ffmpeg-received] trackId=${track.id} format=${track.format} extension=${extension} ` +
        `contentType=${downloadContentType ?? '(none)'} ` +
        `receivedBytes=${receivedBytes ?? '(unknown)'} ` +
        `contentLength=${downloadContentLength ?? '(unknown)'} ` +
        `declaredSize=${declaredSize ?? '(unknown)'} ` +
        `size=${size ?? '(unknown)'} first16Hex=${first16Hex} ` +
        `ffmpegError=${ffmpegError ?? '(none)'}`,
    );
  }
}

/**
 * Create SyncCore instance
 */
export function createSyncCore(config: SyncConfig, deps?: Partial<SyncDependencies>): SyncCore {
  const core = new SyncCoreImpl(config, deps);

  return {
    sync: (input, onProgress) => core.sync(input, onProgress),
    cancel: () => core.cancel(),
    validateDestination: (path) => core.validateDestination(path),
    estimateSize: (itemIds, itemTypes, options) => core.estimateSize(itemIds, itemTypes, options),
    removeItems: (itemIds, itemTypes, destinationPath) =>
      core.removeItems(itemIds, itemTypes, destinationPath),
    testConnection: () => core.testConnection(),
    analyzeDiff: (itemIds, itemTypes, destinationPath, options, preloadedTracks) =>
      core.analyzeDiff(itemIds, itemTypes, destinationPath, options, preloadedTracks),
  };
}

/**
 * Public interface for SyncCore
 */
export interface SyncCore {
  sync(input: SyncInput, onProgress?: ProgressCallback): Promise<SyncResult>;
  cancel(): void;
  validateDestination(path: string): Promise<DestinationValidation>;
  estimateSize(
    itemIds: string[],
    itemTypes: Map<string, ItemType>,
    options?: {
      convertToMp3?: boolean;
      bitrate?: string;
      coverArtMode?: CoverArtMode;
      syncedIds?: Set<string>;
    },
  ): Promise<SizeEstimate>;
  removeItems(
    itemIds: string[],
    itemTypes: Map<string, ItemType>,
    destinationPath: string,
  ): Promise<{ removed: number; errors: string[] }>;
  testConnection(): Promise<{ success: boolean; error?: string }>;
  analyzeDiff(
    itemIds: string[],
    itemTypes: Map<string, ItemType>,
    destinationPath: string,
    options: {
      coverArtMode: CoverArtMode;
      bitrate: '128k' | '192k' | '320k';
      convertToMp3: boolean;
    },
    preloadedTracks?: Map<string, TrackInfo[]>,
  ): Promise<SyncDiffResult>;
}

/**
 * Export factory for tests
 */
export function createTestSyncCore(config: SyncConfig, deps: SyncDependencies): SyncCore {
  return new SyncCoreImpl(config, deps);
}

// =============================================================================
// readHeaderBytes — streaming header reader for post-download body
// fingerprinting (ORAIN-0739 HIGH-2)
//
// AC6 lets the body cap reach 2 GiB. Reading the full body into heap
// for AC3's magic-byte check is unsafe: every successful download near
// the cap would OOM. `readHeaderBytes` opens a stream, accumulates
// chunks until `maxBytes` is reached or the stream ends, then closes
// the stream and returns the truncated buffer. It uses `FileSystem` so
// it can be tested with the mock fs without touching real disk.
// =============================================================================

/**
 * Read up to `maxBytes` from `path` via `FileSystem.createReadStream`.
 * Returns a buffer of length `min(actualFileSize, maxBytes)`. Stops
 * reading once enough bytes are accumulated — large files never load
 * the body into heap.
 *
 * Stream errors bubble up so the caller's existing error path
 * (catch → SyncPhaseError) handles them uniformly.
 *
 * ORAIN-0739 MEDIUM: when `'close'` fires before `'end'` or `'error'`
 * (rare Node Readable ordering when a producer destroys without
 * flushing), we reject instead of resolving an empty buffer. An empty
 * buffer would otherwise be misclassified as `phase: 'validation'` by
 * the downstream `validateAudioBody`, when the real fault was the
 * download stream itself (`phase: 'download'`).
 */
async function readHeaderBytes(fs: FileSystem, path: string, maxBytes: number): Promise<Buffer> {
  const stream = await fs.createReadStream(path);
  // `FileSystem.createReadStream` returns a `NodeJS.ReadableStream`.
  // For `'data'` event payloads (Buffer | string) and `destroy()` we
  // need the concrete `Readable` API. Cast at the boundary once so the
  // event handlers below are typed end-to-end.
  const readable = stream as NodeJS.ReadableStream & {
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
    on(event: 'end', listener: () => void): unknown;
    on(event: 'error', listener: (err: Error) => void): unknown;
    on(event: 'close', listener: () => void): unknown;
    removeAllListeners(event?: string): unknown;
    destroy(): unknown;
  };

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      readable.removeAllListeners('data');
      readable.removeAllListeners('end');
      readable.removeAllListeners('error');
      readable.removeAllListeners('close');
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Best-effort destroy so the FD does not leak while the promise
      // settles. `destroy()` on an already-ended stream is a no-op.
      try {
        readable.destroy();
      } catch {
        // ignore — we are returning the buffered result regardless
      }
      fn();
    };

    readable.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // If a single chunk exceeds maxBytes, slice it and stop.
      if (total + buf.length >= maxBytes) {
        const remaining = maxBytes - total;
        chunks.push(remaining > 0 ? buf.subarray(0, remaining) : Buffer.alloc(0));
        total = maxBytes;
        settle(() => resolve(Buffer.concat(chunks, total)));
        return;
      }
      chunks.push(buf);
      total += buf.length;
    });

    // ORAIN-0739 MEDIUM: track whether the stream emitted 'end' or
    // 'error' before 'close'. The normal order is end/close or
    // error/close. If 'close' fires first with neither of those having
    // happened (rare producer-destroy-without-flush case), the stream
    // did not deliver its content cleanly — reject so the caller
    // classifies it as a download fault rather than a validation
    // "empty body" error.
    let endedOrErrored = false;
    readable.on('end', () => {
      endedOrErrored = true;
      settle(() => resolve(Buffer.concat(chunks, total)));
    });

    readable.on('error', (err: Error) => {
      endedOrErrored = true;
      settle(() => reject(err));
    });

    // `'close'` fires after `'end'`/`'error'` on a normal stream, and is
    // also the last observable signal when the producer destroys
    // without flushing. If we never saw end/error first, the stream did
    // not deliver content cleanly — surface it as a download error.
    readable.on('close', () => {
      if (!endedOrErrored) {
        settle(() => reject(new Error('Stream closed before content was delivered')));
        return;
      }
      // Normal path: end/error already settled the promise. Nothing to
      // do here (settle is no-op when `settled` is true).
    });
  });
}

// ORAIN-0739 MEDIUM: a thin re-export so tests can exercise the
// `'close'`-without-`'end'` path with hand-crafted Readables. Production
// callers continue to call the module-private `readHeaderBytes`.
export const readHeaderBytesForTest = readHeaderBytes;
