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
} from './types';

import { ALL_AUDIO_EXTENSIONS, CONVERT_CONCURRENCY, COPY_CONCURRENCY } from './audio-formats';

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

import {
  createApiClient,
  SyncApi,
  detectServerRootPath,
} from './sync-api';

import {
  createNodeFileSystem,
  createFFmpegConverter,
  validateDestination,
  ensureDirectory,
  FileSystem,
  AudioConverter,
  mergeMetadata,
} from './sync-files';

import {
  createProgressEmitter,
  createCancellationController,
  createProgressStats,
  PhaseManager,
  ProgressEmitter,
  CancellationController,
  SyncCancelledError,
} from './sync-progress';

/**
 * Validate that a path stays within allowed boundaries (prevent path traversal)
 */
function validatePathTraversal(basePath: string, relativePath: string): void {
  if (hasTraversalSegment(relativePath)) {
    throw new Error(`Path traversal attempt detected: "${relativePath}" would escape "${basePath}"`);
  }

  // Normalize and verify the final path is still within base
  const normalizedBase = basePath.replace(/\/+$/, '');
  const normalizedFull = `${normalizedBase}/${relativePath}`.replace(/\/+/g, '/');

  if (!normalizedFull.startsWith(normalizedBase + '/') && normalizedFull !== normalizedBase) {
    throw new Error(`Path traversal attempt detected: final path "${normalizedFull}" escapes base "${basePath}"`);
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
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
  fn: (item: T) => Promise<void>
): Promise<void> {
  let i = 0;
  async function worker(): Promise<void> {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
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
function needsConversion(track: { format: string; bitrate?: number }, targetBitrateKbps: number): boolean {
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
function estimatedMp3Size(originalBytes: number, sourceBitrateKbps: number, targetBitrateKbps: number): number {
  const effectiveSource = sourceBitrateKbps > 0 ? sourceBitrateKbps : 900;
  return Math.floor(originalBytes * (targetBitrateKbps / effectiveSource));
}

/** Parse arbitrary bitrate string to kbps (e.g. '192k' → 192, '320k' → 320) */
function parseBitrateKbps(bitrate: string): number {
  return parseInt(bitrate.replace(/k$/i, ''), 10) || 192;
}

/** No-op logger used when no logger is injected (keeps module testable) */
const noopLogger: SyncLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

/**
 * Dependencies container (for dependency injection).
 */
export interface SyncDependencies {
  api: SyncApi;
  fs: FileSystem;
  converter: AudioConverter;
  logger?: SyncLogger;
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
    converter: createFFmpegConverter(),
  };
}

/**
 * SyncCore implementation
 */
class SyncCoreImpl {
  private deps: SyncDependencies;
  private log: SyncLogger;
  private progressEmitter: ProgressEmitter;
  private cancellation: CancellationController;
  private serverRootPath: string;
  private currentPhase: SyncPhase = 'fetching';
  /** Tracks album directories that have already received a cover.jpg (for companion mode dedup) */
  private processedCoverDirs = new Set<string>();
  /** Cover art cache keyed by Jellyfin album ID — avoids N HTTP requests for the same album's cover */
  private coverArtCache = new Map<string, Buffer>();
  /** Session-level counter for cover art fetch failures — used to emit a single UI warning */
  private coverArtFailCount = 0;

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
    };
    this.log = logger;
    this.progressEmitter = createProgressEmitter();
    this.cancellation = createCancellationController();
    // Default server root path if not provided
    this.serverRootPath = config.serverRootPath ?? '';
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
    
    // Subscribe progress callback if provided
    const unsubscribe = onProgress
      ? this.progressEmitter.subscribe(onProgress)
      : () => {};
    
    const phaseManager = new PhaseManager(this.progressEmitter);
    const errors: string[] = [];
    const tracksFailed: string[] = [];
    let totalTracks = 0; // Track total for cancellation handler

    try {
      // Reset cancellation state
      this.cancellation.reset();

      // 1. Validate destination
      this.currentPhase = 'fetching';
      phaseManager.startFetching(input.itemIds.length);
      const destValidation = await this.validateDestination(input.destinationPath);
      
      if (!destValidation.valid) {
        return {
          success: false,
          tracksCopied: 0,
          tracksSkipped: 0,
          tracksRetagged: 0,
          tracksMoved: 0,
          tracksRemoved: 0,
          tracksFailed: [],
          errors: destValidation.errors,
          totalSizeBytes: 0,
          durationMs: Date.now() - startTime,
        };
      }
      
      // 2. Fetch tracks from Jellyfin
      this.cancellation.throwIfCancelled();
      phaseManager.updateFetching(1, 3);
      
      const { tracks, errors: fetchErrors } = await this.deps.api.getTracksForItems(
        input.itemIds,
        input.itemTypes
      );
      
      // Auto-detect serverRootPath from tracks if not provided in config
      if (!this.serverRootPath && tracks.length > 0) {
        const detectedPath = detectServerRootPath(tracks);
        if (detectedPath) {
          this.serverRootPath = detectedPath;
          this.log.info(`Detected server root path: ${detectedPath}`);
        }
      }
      
      errors.push(...fetchErrors);
      totalTracks = tracks.length;
      
      if (tracks.length === 0) {
        return {
          success: false,
          tracksCopied: 0,
          tracksSkipped: 0,
          tracksRetagged: 0,
          tracksMoved: 0,
          tracksRemoved: 0,
          tracksFailed: [],
          errors: ['No tracks found for selected items', ...errors],
          totalSizeBytes: 0,
          durationMs: Date.now() - startTime,
        };
      }
      
      // 3. Resolve options
      const options = resolveSyncOptions(input.options);
      
      // 4. Prepare destination
      await ensureDirectory(input.destinationPath, this.deps.fs);
      
      // 5. Copy/Convert tracks (parallel, capped at TRACK_CONCURRENCY)
      this.currentPhase = 'copying';
      phaseManager.startCopying(tracks.length);

      const targetBitrateKbps = bitrateStringToKbps(options.bitrate ?? '192k');
      const anyWillConvert = options.convertToMp3 === true &&
        tracks.some(t => needsConversion(t, targetBitrateKbps));
      const concurrency = anyWillConvert ? CONVERT_CONCURRENCY : COPY_CONCURRENCY;
      let completed = 0;
      let statsRetagged = 0;
      let statsMoved = 0;

      // Pre-load all synced records for this device to avoid per-track DB round-trips
      let allSyncedRecords: SyncedTrackRecord[] = [];
      try {
        allSyncedRecords = getSyncedTracksForDevice(input.destinationPath);
      } catch (e) {
        this.log.warn('Failed to load synced records, treating all tracks as new');
      }
      const syncedByTrackId = new Map<string, SyncedTrackRecord>();
      for (const rec of allSyncedRecords) {
        syncedByTrackId.set(rec.trackId, rec);
      }

      await runWithConcurrency(tracks, concurrency, async (track) => {
        // Bail early if cancelled — don't start new work
        if (this.cancellation.isCancelled()) return;

        try {
          const outputDir = this.getOutputDir(track, input.destinationPath, options.preserveStructure ?? true, options.filesystemType ?? 'unknown');
          await ensureDirectory(outputDir, this.deps.fs);

          const willConvert = options.convertToMp3 === true && needsConversion(track, targetBitrateKbps);
          const coverArtMode = options.coverArtMode ?? 'embed';

          // Resolve the canonical filename (no uniqueness suffix yet)
          const outputFilename = this.resolveCanonicalFilename(track, options);
          const outputPath = `${outputDir}/${outputFilename}`;

          // Build current metadata hash — must be computed inside the loop
          // (after options are resolved) so the hash is consistent
          const trackMeta = this.buildMetadata(track);
          const currentHash = computeMetadataHash(trackMeta);
          const encodedBitrate = willConvert ? (options.bitrate ?? '192k') : null;
          const itemId = track.parentItemId ?? '';

          // Check DB record for this track
          const syncedRecord = syncedByTrackId.get(track.id);

          if (syncedRecord) {
            // Track was previously synced — determine what changed
            const metadataChanged = syncedRecord.metadataHash !== currentHash;
            const bitrateChanged = willConvert && syncedRecord.encodedBitrate !== encodedBitrate;
            const coverArtChanged = syncedRecord.coverArtMode !== coverArtMode;
            const pathChanged = syncedRecord.destinationPath !== outputPath;

            if (!metadataChanged && !bitrateChanged && !coverArtChanged) {
              if (pathChanged) {
                // Album was renamed/moved — no re-download, just record new path
                upsertSyncedTrack(
                  input.destinationPath,
                  itemId,
                  track.id,
                  outputPath,
                  track.size ?? null,
                  currentHash,
                  coverArtMode,
                  encodedBitrate,
                  track.path ?? null,
                  this.serverRootPath || null
                );
                statsMoved++;
                this.log.debug(`Move-detected (no re-download): ${track.name}`);
              } else {
                // Truly unchanged — skip entirely
                stats.itemsSkipped++;
                this.log.debug(`Skip (unchanged, hash matches): ${track.name}`);
              }
              return;
            }

            // Metadata, bitrate, or cover-art changed — re-tag without re-download
            if (!pathChanged && (metadataChanged || bitrateChanged || coverArtChanged)) {
              // File already at correct path, just update tags
              const embedCover = coverArtMode === 'embed' ? await this.getCoverArtBuffer(track.id, track.albumId, coverArtMode) : undefined;
              const tagResult = await this.deps.converter.tagFile(syncedRecord.destinationPath, syncedRecord.destinationPath, trackMeta, embedCover);
              if (tagResult.success) {
                upsertSyncedTrack(
                  input.destinationPath,
                  itemId,
                  track.id,
                  syncedRecord.destinationPath,
                  track.size ?? null,
                  currentHash,
                  coverArtMode,
                  encodedBitrate,
                  track.path ?? null,
                  this.serverRootPath || null
                );
                statsRetagged++;
                this.log.debug(`Re-tag (no re-download): ${track.name}`);
                return;
              }
              // Tag failed — fall through to re-download as last resort
              this.log.warn(`Re-tag failed for ${track.name}, falling back to re-download`);
            }
          }

          // Remove alternate-format copies of the same track (e.g. .flac when writing .mp3)
          if (await this.deps.fs.exists(outputPath)) {
            if (willConvert) {
              // Cross-format: can't compare sizes meaningfully, skip if present
              stats.itemsSkipped++;
              this.log.debug(`Skip (convert, exists): ${track.name}`);
              // Heal v1→v2 migration: populate synced_tracks so future analyzeDiff works correctly
              const existingSize = (await this.deps.fs.stat(outputPath)).size
              upsertSyncedTrack(
                input.destinationPath, itemId, track.id, outputPath,
                existingSize, currentHash, coverArtMode, encodedBitrate,
                track.path ?? null, this.serverRootPath || null
              );
              return;
            }
            if (track.size && (await this.deps.fs.stat(outputPath)).size === track.size) {
              // Same size → unchanged, skip
              stats.itemsSkipped++;
              this.log.debug(`Skip (same size): ${track.name}`);
              // Heal v1→v2 migration: populate synced_tracks so future analyzeDiff works correctly
              upsertSyncedTrack(
                input.destinationPath, itemId, track.id, outputPath,
                track.size, currentHash, coverArtMode, encodedBitrate,
                track.path ?? null, this.serverRootPath || null
              );
              return;
            }
            // Size differs → fall through and overwrite
            this.log.debug(`Overwrite (size changed): ${track.name}`);
          }

          // Remove alternate-format copies of the same track (e.g. .flac when writing .mp3)
          await this.deleteAlternateFormats(outputDir, outputFilename);

          // Determine metadata and cover art options for this track
          const embedMetadata = options.embedMetadata !== false;

          // Copy or convert
          if (willConvert) {
            const bitrateInfo = track.bitrate ? ` (source ${Math.round(track.bitrate / 1000)}kbps)` : '';
            this.log.debug(`Convert: ${track.name} [${track.format.toUpperCase()}${bitrateInfo}] → MP3 ${options.bitrate ?? '192k'}`);
            await this.convertAndCopy(track, outputPath, options.bitrate ?? '192k', embedMetadata, coverArtMode);
            stats.itemsConverted++;

            // Write companion cover after conversion (one per album directory)
            if (coverArtMode === 'companion') {
              const coverBuffer = await this.getCoverArtBuffer(track.id, track.albumId, coverArtMode);
              if (coverBuffer) await this.writeCompanionCover(outputDir, coverBuffer);
            }
          } else {
            const reason = options.convertToMp3 && track.format.toLowerCase() === 'mp3'
              ? ` (MP3 ${track.bitrate ? Math.round(track.bitrate / 1000) + 'kbps ≤ target' : 'bitrate unknown, skipping re-encode'})`
              : '';
            this.log.debug(`Copy: ${track.name} [${track.format.toUpperCase()}]${reason}`);
            const data = await this.deps.api.downloadItem(track.id);

            // Write via tagFile when metadata enrichment is enabled (passthrough → write tags without re-encoding)
            if (embedMetadata) {
              const tmpPath = `${input.destinationPath}/.jt-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              await this.deps.fs.writeFile(tmpPath, data);
              const embedCover = coverArtMode === 'embed' ? await this.getCoverArtBuffer(track.id, track.albumId, coverArtMode) : undefined;
              // Merge original file metadata with Jellyfin metadata — Jellyfin wins on conflicts, file fills holes
              const originalMeta = await this.deps.converter.readFileMetadata(tmpPath);
              const jellyfinMeta = this.buildMetadata(track);
              const mergedMeta = mergeMetadata(originalMeta, jellyfinMeta);
              const result = await this.deps.converter.tagFile(tmpPath, outputPath, mergedMeta, embedCover);
              await this.deps.fs.unlink(tmpPath).catch(() => {}); // clean up temp
              if (!result.success) throw new Error(result.error ?? 'Tagging failed');

              // Companion cover for passthrough (one per album directory)
              if (coverArtMode === 'companion') {
                const coverBuffer = await this.getCoverArtBuffer(track.id, track.albumId, coverArtMode);
                if (coverBuffer) await this.writeCompanionCover(outputDir, coverBuffer);
              }
            } else {
              await this.deps.fs.writeFile(outputPath, data);
            }
            stats.bytesTransferred += track.size ?? 0;
          }

          stats.itemsProcessed++;

          // Record successful sync to DB
          upsertSyncedTrack(
            input.destinationPath,
            itemId,
            track.id,
            outputPath,
            track.size ?? null,
            currentHash,
            coverArtMode,
            encodedBitrate,
            track.path ?? null,
            this.serverRootPath || null
          );

        } catch (error) {
          const errorMsg = `Failed to sync "${track.name}": ${error instanceof Error ? error.message : 'Unknown error'}`;
          errors.push(errorMsg);
          tracksFailed.push(track.id);
          stats.itemsFailed++;
          this.log.warn(errorMsg);
        } finally {
          completed++;
          phaseManager.updateCopying(completed, tracks.length, track.name);
        }
      });

      // Propagate cancellation after parallel tasks drain
      this.cancellation.throwIfCancelled();
      
      // 6. Complete
      phaseManager.complete(stats);

      // 7. Generate M3U8 files for playlist items
      const playlistIds = input.itemIds.filter(id => input.itemTypes.get(id) === 'playlist');
      if (playlistIds.length > 0 && this.serverRootPath) {
        await this.generateM3u8Files(playlistIds, input.destinationPath, resolveSyncOptions(input.options));
      }

      return {
        success: errors.length === 0,
        tracksCopied: stats.itemsProcessed,
        tracksSkipped: stats.itemsSkipped,
        tracksRetagged: statsRetagged,
        tracksMoved: statsMoved,
        tracksRemoved: 0,
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
          tracksFailed: [],
          errors: ['Sync was cancelled by user'],
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
        tracksFailed: tracksFailed,
        errors: [errorMsg, ...errors],
        totalSizeBytes: stats.bytesTransferred,
        durationMs: Date.now() - startTime,
      };
      
    } finally {
      unsubscribe();
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
  async estimateSize(itemIds: string[], itemTypes: Map<string, ItemType>, options?: { convertToMp3?: boolean; bitrate?: string; syncedIds?: Set<string> }): Promise<SizeEstimate> {
    const { tracks, errors: _errors } = await this.deps.api.getTracksForItems(itemIds, itemTypes);

    const formatBreakdown = new Map<string, number>();
    const typeBreakdown = new Map<ItemType, number>();

    let totalBytes = 0;
    let syncedMusicBytes = 0;
    let newMusicBytes = 0;

    for (const track of tracks) {
      // Apply MP3 conversion size reduction if needed
      const fmt = (track.format ?? '').toLowerCase();
      const needsConversion = options?.convertToMp3 && fmt !== 'mp3'
      const effectiveSize = needsConversion
        ? estimatedMp3Size(
            track.size ?? 0,
            (track.bitrate ?? 0) / 1000,  // track.bitrate is in bps, convert to kbps
            parseBitrateKbps(options?.bitrate ?? '192k')
          )
        : (track.size ?? 0)

      totalBytes += effectiveSize;

      // Separate synced vs new if syncedIds provided
      if (options?.syncedIds?.has(track.id)) {
        syncedMusicBytes += effectiveSize;
      } else {
        newMusicBytes += effectiveSize;
      }

      // Format breakdown (report effective size per format)
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
    destinationPath: string
  ): Promise<{ removed: number; errors: string[] }> {
    if (itemIds.length === 0) return { removed: 0, errors: [] };

    const { tracks } = await this.deps.api.getTracksForItems(itemIds, itemTypes);

    // Auto-detect serverRootPath if not set
    if (!this.serverRootPath && tracks.length > 0) {
      const detected = detectServerRootPath(tracks);
      if (detected) this.serverRootPath = detected;
    }

    const errors: string[] = [];
    let removed = 0;
    const dirsToClean = new Set<string>();

    // Step 1: Delete M3U8 files for playlist items being removed
    const playlistIds = itemIds.filter(id => itemTypes.get(id) === 'playlist');
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
      } catch { /* non-fatal */ }
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
          if (!await this.deps.fs.exists(outputPath)) continue;

          // Compute relative path for this specific file (respecting actual extension)
          if (this.serverRootPath && track.path) {
            const baseRelative = getRelativePath(track.path, this.serverRootPath);
            const ext = filename.match(/\.[^.]+$/)?.[0] ?? '';
            const relativePath = baseRelative.replace(/\.[^.]+$/, ext);
            if (protectedPaths.has(relativePath)) break; // referenced elsewhere
          } else if (protectedPaths.size > 0) {
            break; // can't compute relative path, be conservative
          }

          await this.deps.fs.unlink(outputPath);
          deleted = true;
          dirsToClean.add(outputDir);
          break;
        }
        if (deleted) removed++;
      } catch (error) {
        errors.push(`Failed to remove "${track.name}": ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
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
      const m3u8Files = entries.filter(e => e.toLowerCase().endsWith('.m3u8'));
      for (const m3u8File of m3u8Files) {
        try {
          const content = await this.deps.fs.readFile(`${destinationPath}/${m3u8File}`);
          for (const line of content.toString('utf8').split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) referenced.add(trimmed);
          }
        } catch { /* ignore unreadable files */ }
      }
    } catch { /* ignore if destination doesn't exist */ }
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
   */
  async analyzeDiff(
    itemIds: string[],
    itemTypes: Map<string, ItemType>,
    destinationPath: string,
    options: { coverArtMode: CoverArtMode; bitrate: '128k' | '192k' | '320k'; convertToMp3: boolean }
  ): Promise<SyncDiffResult> {
    // Resolve options to get filesystemType for path sanitization
    const resolvedOptions = resolveSyncOptions({ convertToMp3: options.convertToMp3, bitrate: options.bitrate });
    const filesystemType = resolvedOptions.filesystemType ?? 'unknown';

    // Get synced tracks from device DB
    const syncedTracks = getSyncedTracksForDevice(destinationPath);

    // Build lookup map: trackId → synced record
    const syncedMap = new Map<string, SyncedTrackRecord>();
    for (const t of syncedTracks) {
      syncedMap.set(t.trackId, t);
    }

    // Fetch all tracks in a single batched call — no N+1
    const { tracks: allServerTracks, errors: fetchErrors } = await this.deps.api.getTracksForItems(
      Array.from(itemIds),
      itemTypes
    );

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
        .filter(id => itemTypes.get(id) === 'playlist')
        .map(async (playlistId) => {
          const info = await this.deps.api.getItem(playlistId);
          if (info) playlistNames.set(playlistId, info.name);
        })
    );

    // Build itemErrors from fetch errors
    const itemErrors: { itemId: string; itemName: string; error: string }[] = fetchErrors
      .filter(e => e.includes('Failed to fetch'))
      .map(e => {
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
    const legacySyncedItemIds = new Set(getSyncedItems(destinationPath).map(i => i.id));

    const itemDiffs: ItemDiff[] = [];
    let totalNew = 0;
    let totalMetaChanged = 0;
    let totalRemoved = 0;
    let totalPathChanged = 0;
    let totalUnchanged = 0;

    for (const itemId of itemIds) {
      const itemType = itemTypes.get(itemId) ?? 'album';
      const itemName = itemType === 'playlist'
        ? (playlistNames.get(itemId) ?? itemId)
        : itemId;

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
        const unchangedChanges: TrackChange[] = serverTracks.map(t => ({
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
          summary: { new: 0, metadataChanged: 0, removed: 0, pathChanged: 0, unchanged: unchangedChanges.length },
        });
        continue;
      }

      const changes: TrackChange[] = [];

      // For artists: track changes grouped by album (parentItemId)
      const albumChanges = new Map<string, { newTracks: number; metadataChanged: number; pathChanged: number }>();

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
            const prev = albumChanges.get(track.parentItemId) ?? { newTracks: 0, metadataChanged: 0, pathChanged: 0 };
            albumChanges.set(track.parentItemId, { newTracks: prev.newTracks + 1, metadataChanged: prev.metadataChanged, pathChanged: prev.pathChanged });
          }
        } else if (synced.metadataHash !== currentHash) {
          changes.push({ trackId: track.id, trackName: track.name, changeType: 'metadata_changed' });
          totalMetaChanged++;
          if (track.parentItemId) {
            const prev = albumChanges.get(track.parentItemId) ?? { newTracks: 0, metadataChanged: 0, pathChanged: 0 };
            albumChanges.set(track.parentItemId, { newTracks: prev.newTracks, metadataChanged: prev.metadataChanged + 1, pathChanged: prev.pathChanged });
          }
        } else if (options.convertToMp3 && synced.encodedBitrate !== options.bitrate) {
          changes.push({ trackId: track.id, trackName: track.name, changeType: 'bitrate_changed' });
          totalMetaChanged++;
          if (track.parentItemId) {
            const prev = albumChanges.get(track.parentItemId) ?? { newTracks: 0, metadataChanged: 0, pathChanged: 0 };
            albumChanges.set(track.parentItemId, { newTracks: prev.newTracks, metadataChanged: prev.metadataChanged + 1, pathChanged: prev.pathChanged });
          }
        } else if (synced.coverArtMode !== options.coverArtMode) {
          changes.push({ trackId: track.id, trackName: track.name, changeType: 'cover_art_changed' });
          totalMetaChanged++;
          if (track.parentItemId) {
            const prev = albumChanges.get(track.parentItemId) ?? { newTracks: 0, metadataChanged: 0, pathChanged: 0 };
            albumChanges.set(track.parentItemId, { newTracks: prev.newTracks, metadataChanged: prev.metadataChanged + 1, pathChanged: prev.pathChanged });
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
              rootPathForDiff
            );
            const outputFilename = this.resolveCanonicalFilename(
              { ...track, path: serverPathForDiff },
              resolvedOptions
            );
            const expectedPath = `${outputDir}/${outputFilename}`;
            if (synced.destinationPath !== expectedPath) {
              changes.push({ trackId: track.id, trackName: track.name, changeType: 'path_changed' });
              totalPathChanged++;
              if (track.parentItemId) {
                const prev = albumChanges.get(track.parentItemId) ?? { newTracks: 0, metadataChanged: 0, pathChanged: 0 };
                albumChanges.set(track.parentItemId, { newTracks: prev.newTracks, metadataChanged: prev.metadataChanged, pathChanged: prev.pathChanged + 1 });
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
        if (!serverTracks.find(t => t.id === synced.trackId)) {
          changes.push({ trackId: synced.trackId, trackName: synced.trackId, changeType: 'removed' });
          totalRemoved++;
        }
      }

      // For artist items, compute sub-items (per-album breakdown)
      // albumChanges tracks metadata/path changes by parentItemId (album ID)
      const subItems: ItemDiff['subItems'] = itemType === 'artist' && albumChanges.size > 0
        ? [...albumChanges.entries()].map(([id, s]) => ({ itemId: id, summary: s }))
        : undefined;

      itemDiffs.push({
        itemId,
        itemName,
        itemType,
        changes,
        summary: {
          new: changes.filter(c => c.changeType === 'new').length,
          metadataChanged: changes.filter(c => ['metadata_changed', 'cover_art_changed', 'bitrate_changed'].includes(c.changeType)).length,
          removed: changes.filter(c => c.changeType === 'removed').length,
          pathChanged: changes.filter(c => c.changeType === 'path_changed').length,
          unchanged: changes.filter(c => c.changeType === 'unchanged').length,
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
    serverRootPathOverride?: string
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
        const sanitized = parts.map(p => sanitizePathComponent(p, filesystemType));
        return `${basePath}/${sanitized.join('/')}`;
      }
      return basePath;
    }

    // Metadata fallback when no path available
    const parts = [basePath, 'lib'];

    if (track.artists?.[0]) {
      const artist = sanitizePathComponent(
        track.artists[0].replace(/[<>:"/\\|?*]/g, '_').slice(0, 100),
        filesystemType
      );
      parts.push(artist);
    }

    if (track.album) {
      let folder = track.album.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
      if (track.year) folder += ` (${track.year})`;
      parts.push(sanitizePathComponent(folder, filesystemType));
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
    track: { name: string; path: string; format: string; trackNumber?: number; artists?: string[]; album?: string },
    options: ReturnType<typeof resolveSyncOptions>
  ): string {
    if (track.path) {
      return this.resolveFilenameFromPath(track, options);
    }
    return this.buildFilenameFromMetadata(track, options);
  }

  private resolveFilenameFromPath(
    track: { path: string; format: string },
    options: ReturnType<typeof resolveSyncOptions>
  ): string {
    let filename = getFilenameFromPath(track.path);

    if (hasTraversalSegment(filename) || filename.includes('/') || filename.includes('\\')) {
      throw new Error(`Invalid filename: path traversal detected in "${filename}"`);
    }

    // Apply filesystem-specific sanitization (handles FAT32/exFAT/NTFS invalid chars,
    // trailing dots/spaces, reserved names, length limits)
    filename = sanitizePathComponent(filename, options.filesystemType ?? 'unknown');

    // Fallback: replace any remaining forbidden chars for non-Windows filesystems
    filename = filename.replace(/[<>:"|?*]/g, '_');

    if (options.convertToMp3 && !filename.toLowerCase().endsWith('.mp3')) {
      filename = filename.replace(/\.[^.]+$/, '.mp3');
    }

    return filename;
  }

  private buildFilenameFromMetadata(
    track: { name: string; format: string; trackNumber?: number; artists?: string[]; album?: string },
    options: ReturnType<typeof resolveSyncOptions>
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
    options: ReturnType<typeof resolveSyncOptions>
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
          // M3U8 entries match the actual paths on disk (critical for FAT32/exFAT/NTFS)
          const fs = options.filesystemType ?? 'unknown';
          if (fs !== 'unknown') {
            relativePath = relativePath
              .split('/')
              .map(segment => sanitizePathComponent(segment, fs))
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
        this.log.warn(`M3U8 generation failed for playlist ${playlistId}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
  }

  private readonly SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.Spotlight-V100', '.Trashes']);

  private isMusicFile(name: string): boolean {
    // Any non-system, non-hidden file counts as content
    return !name.startsWith('.') && !this.SYSTEM_FILES.has(name);
  }

  private async cleanEmptyDir(dir: string, basePath: string): Promise<void> {
    if (dir === basePath || !dir.startsWith(basePath + '/')) return;
    try {
      const contents = await this.deps.fs.readdir(dir);
      const meaningfulContents = contents.filter(f => this.isMusicFile(f));
      if (meaningfulContents.length === 0) {
        // Delete system/hidden files first so rmdir can succeed
        for (const f of contents) {
          try { await this.deps.fs.unlink(`${dir}/${f}`); } catch { /* ignore */ }
        }
        await this.deps.fs.rmdir(dir);
        const parent = dir.substring(0, dir.lastIndexOf('/'));
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
   * Build TrackMetadata from a TrackInfo — only fields with values are set,
   * so FFmpeg only writes non-empty fields (doesn't clear existing tags).
   */
  private buildMetadata(track: TrackInfo): TrackMetadata {
    return {
      title: track.name,
      artist: track.artists?.join('; '),
      albumArtist: track.albumArtist,
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
    mode: CoverArtMode
  ): Promise<Buffer | undefined> {
    if (mode === 'off') return undefined;

    // Check cache first using albumId
    const cacheKey = albumId ?? trackId;
    if (this.coverArtCache.has(cacheKey)) {
      return this.coverArtCache.get(cacheKey);
    }

    try {
      const buffer = await this.deps.api.getCoverArt(trackId);
      this.coverArtCache.set(cacheKey, buffer);
      return buffer;
    } catch {
      this.coverArtFailCount++;
      if (this.coverArtFailCount === 1) {
        this.progressEmitter.emit({ phase: this.currentPhase, current: 0, total: 0, warning: 'cover_art_unavailable' });
      }
      this.log.warn(`Cover art not available for track ${trackId}`);
      return undefined;
    }
  }

  /**
   * Write cover.jpg companion file to an album directory (once per directory).
   */
  private async writeCompanionCover(dir: string, coverBuffer: Buffer): Promise<void> {
    if (this.processedCoverDirs.has(dir)) return;
    this.processedCoverDirs.add(dir);
    try {
      await this.deps.fs.writeFile(`${dir}/cover.jpg`, coverBuffer);
      this.log.debug(`Companion cover written: ${dir}/cover.jpg`);
    } catch (err) {
      this.log.warn(`Failed to write companion cover in ${dir}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async convertAndCopy(
    track: TrackInfo,
    outputPath: string,
    bitrate: '128k' | '192k' | '320k',
    embedMetadata: boolean,
    coverArtMode: CoverArtMode
  ): Promise<void> {
    // Buffer stream to temp file so we can read original file metadata before converting
    const tmpPath = `${outputPath}.jt-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const stream = await this.deps.api.downloadItemStream(track.id);

    // Pipe stream to temp file
    const writeStream = await this.deps.fs.createWriteStream(tmpPath);
    await new Promise<void>((resolve, reject) => {
      stream.pipe(writeStream);
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    let metadata: TrackMetadata = {};
    if (embedMetadata) {
      // Read original file metadata and merge with Jellyfin fields — Jellyfin wins on conflicts
      const originalMeta = await this.deps.converter.readFileMetadata(tmpPath);
      const jellyfinMeta = this.buildMetadata(track);
      metadata = mergeMetadata(originalMeta, jellyfinMeta);
    }

    const embedCover = coverArtMode === 'embed' ? await this.getCoverArtBuffer(track.id, track.albumId, coverArtMode) : undefined;

    // Convert from the buffered temp file (preserves original stream data)
    const readStream = await this.deps.fs.createReadStream(tmpPath);
    const result = await this.deps.converter.convertStreamToMp3WithMeta(readStream, outputPath, bitrate, metadata, embedCover);
    await this.deps.fs.unlink(tmpPath).catch(() => {}); // clean up temp

    if (!result.success) {
      throw new Error(result.error ?? 'Conversion failed');
    }
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
    estimateSize: (itemIds, itemTypes) => core.estimateSize(itemIds, itemTypes),
    removeItems: (itemIds, itemTypes, destinationPath) => core.removeItems(itemIds, itemTypes, destinationPath),
    testConnection: () => core.testConnection(),
    analyzeDiff: (itemIds, itemTypes, destinationPath, options) => core.analyzeDiff(itemIds, itemTypes, destinationPath, options),
  };
}

/**
 * Public interface for SyncCore
 */
export interface SyncCore {
  sync(input: SyncInput, onProgress?: ProgressCallback): Promise<SyncResult>;
  cancel(): void;
  validateDestination(path: string): Promise<DestinationValidation>;
  estimateSize(itemIds: string[], itemTypes: Map<string, ItemType>, options?: { convertToMp3?: boolean; bitrate?: string; syncedIds?: Set<string> }): Promise<SizeEstimate>;
  removeItems(itemIds: string[], itemTypes: Map<string, ItemType>, destinationPath: string): Promise<{ removed: number; errors: string[] }>;
  testConnection(): Promise<{ success: boolean; error?: string }>;
  analyzeDiff(itemIds: string[], itemTypes: Map<string, ItemType>, destinationPath: string, options: { coverArtMode: CoverArtMode; bitrate: '128k' | '192k' | '320k'; convertToMp3: boolean }): Promise<SyncDiffResult>;
}

/**
 * Export factory for tests
 */
export function createTestSyncCore(
  config: SyncConfig,
  deps: SyncDependencies
): SyncCore {
  return new SyncCoreImpl(config, deps);
}