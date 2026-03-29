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
  SyncProgress,
  ProgressCallback,
  SizeEstimate,
  ItemType,
  DestinationValidation,
  SyncLogger,
} from './types';

import {
  validateSyncConfig,
  resolveSyncOptions,
  createSyncConfig,
  buildDestinationPath,
  getRelativePath,
  getFilenameFromPath,
  sanitizePathComponent,
  hasTraversalSegment,
} from './sync-config';
import type { FilesystemType } from './types';

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
  getUniqueFilename,
  calculateTotalSize,
  FileSystem,
  AudioConverter,
} from './sync-files';

import {
  createProgressEmitter,
  createCancellationController,
  createProgressStats,
  PhaseManager,
  ProgressEmitter,
  CancellationController,
  ProgressStats,
  SyncCancelledError,
} from './sync-progress';
import { buildTempPaths } from './temp-path';

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

/** Formats that always need conversion to MP3 (lossless or incompatible containers) */
const LOSSLESS_FORMATS = new Set(['flac', 'wav', 'aiff', 'aif', 'wv', 'ape', 'alac']);

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
function createDefaultDependencies(config: SyncConfig): SyncDependencies {
  return {
    api: createApiClient({
      baseUrl: config.serverUrl,
      apiKey: config.apiKey,
      userId: config.userId,
    }),
    fs: createNodeFileSystem(),
    converter: createFFmpegConverter(),
  };
}

/**
 * SyncCore implementation
 */
class SyncCoreImpl {
  private config: SyncConfig;
  private deps: SyncDependencies;
  private log: SyncLogger;
  private progressEmitter: ProgressEmitter;
  private cancellation: CancellationController;
  private serverRootPath: string;

  constructor(config: SyncConfig, deps?: Partial<SyncDependencies>) {
    // Validate config
    const validation = validateSyncConfig(config);
    if (!validation.valid) {
      throw new Error(`Invalid config: ${validation.errors.join(', ')}`);
    }

    this.config = config;
    const defaults = createDefaultDependencies(config);
    this.deps = {
      api: deps?.api ?? defaults.api,
      fs: deps?.fs ?? defaults.fs,
      converter: deps?.converter ?? defaults.converter,
      logger: deps?.logger,
    };
    this.log = this.deps.logger ?? noopLogger;
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
      phaseManager.startFetching(input.itemIds.length);
      const destValidation = await this.validateDestination(input.destinationPath);
      
      if (!destValidation.valid) {
        return {
          success: false,
          tracksCopied: 0,
          tracksSkipped: 0,
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
      
      // 5. Copy/Convert tracks
      phaseManager.startCopying(tracks.length);
      
      for (let i = 0; i < tracks.length; i++) {
        this.cancellation.throwIfCancelled();
        
        const track = tracks[i];
        phaseManager.updateCopying(i + 1, tracks.length, track.name);
        
        try {
          const outputDir = this.getOutputDir(track, input.destinationPath, options.preserveStructure ?? true, options.filesystemType ?? 'unknown');
          await ensureDirectory(outputDir, this.deps.fs);

          const targetBitrateKbps = bitrateStringToKbps(options.bitrate ?? '192k');
          const willConvert = options.convertToMp3 === true && needsConversion(track, targetBitrateKbps);

          // Resolve the canonical filename (no uniqueness suffix yet)
          const outputFilename = this.resolveCanonicalFilename(track, options);
          const outputPath = `${outputDir}/${outputFilename}`;

          // Skip or overwrite if file already exists at the canonical path
          if (await this.deps.fs.exists(outputPath)) {
            if (willConvert) {
              // Cross-format: can't compare sizes meaningfully, skip if present
              stats.itemsSkipped++;
              this.log.debug(`Skip (convert, exists): ${track.name}`);
              continue;
            }
            if (track.size && (await this.deps.fs.stat(outputPath)).size === track.size) {
              // Same size → unchanged, skip
              stats.itemsSkipped++;
              this.log.debug(`Skip (same size): ${track.name}`);
              continue;
            }
            // Size differs → fall through and overwrite
            this.log.debug(`Overwrite (size changed): ${track.name}`);
          }

          // Remove alternate-format copies of the same track (e.g. .flac when writing .mp3)
          await this.deleteAlternateFormats(outputDir, outputFilename);

          // Copy or convert
          if (willConvert) {
            const bitrateInfo = track.bitrate ? ` (source ${Math.round(track.bitrate / 1000)}kbps)` : '';
            this.log.debug(`Convert: ${track.name} [${track.format.toUpperCase()}${bitrateInfo}] → MP3 ${options.bitrate ?? '192k'}`);
            await this.convertAndCopy(track, outputPath, options.bitrate ?? '192k');
            stats.itemsConverted++;
          } else {
            const reason = options.convertToMp3 && track.format.toLowerCase() === 'mp3'
              ? ` (MP3 ${track.bitrate ? Math.round(track.bitrate / 1000) + 'kbps ≤ target' : 'bitrate unknown, skipping re-encode'})`
              : '';
            this.log.debug(`Copy: ${track.name} [${track.format.toUpperCase()}]${reason}`);
            // Download from Jellyfin server instead of local copy
            // track.path is a server path that doesn't exist locally
            const data = await this.deps.api.downloadItem(track.id);
            await this.deps.fs.writeFile(outputPath, data);
            stats.bytesTransferred += track.size ?? 0;
          }

          stats.itemsProcessed++;

        } catch (error) {
          const errorMsg = `Failed to sync "${track.name}": ${error instanceof Error ? error.message : 'Unknown error'}`;
          errors.push(errorMsg);
          tracksFailed.push(track.id);
          stats.itemsFailed++;
          this.log.warn(errorMsg);
        }
      }
      
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
   */
  async estimateSize(itemIds: string[], itemTypes: Map<string, ItemType>): Promise<SizeEstimate> {
    const { tracks, errors } = await this.deps.api.getTracksForItems(itemIds, itemTypes);
    
    const formatBreakdown = new Map<string, number>();
    const typeBreakdown = new Map<ItemType, number>();
    
    let totalBytes = 0;
    
    for (const track of tracks) {
      totalBytes += track.size ?? 0;
      
      // Format breakdown
      const format = track.format.toLowerCase();
      formatBreakdown.set(format, (formatBreakdown.get(format) ?? 0) + (track.size ?? 0));
      
      // Type breakdown
      const itemType = itemTypes.get(track.id);
      if (itemType) {
        typeBreakdown.set(itemType, (typeBreakdown.get(itemType) ?? 0) + (track.size ?? 0));
      }
    }
    
    return {
      totalBytes,
      trackCount: tracks.length,
      formatBreakdown,
      typeBreakdown,
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

  // Private helpers
  
  /**
   * Get output directory path.
   * Preserves original server path structure when available; falls back to metadata.
   */
  private getOutputDir(
    track: { path: string; artists?: string[]; album?: string; year?: number },
    basePath: string,
    preserveStructure: boolean,
    filesystemType: FilesystemType = 'unknown'
  ): string {
    const serverRelativePath = this.serverRootPath
      ? getRelativePath(track.path, this.serverRootPath)
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

  /**
   * @deprecated Use resolveCanonicalFilename + manual uniqueness only for new files.
   * Kept for any external callers.
   */
  private async getOutputFilename(
    track: { name: string; path: string; format: string; trackNumber?: number; artists?: string[]; album?: string },
    outputDir: string,
    options: ReturnType<typeof resolveSyncOptions>
  ): Promise<string> {
    const filename = this.resolveCanonicalFilename(track, options);
    return getUniqueFilename(outputDir, filename, this.deps.fs);
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
    const audioExts = ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'wma', 'opus'];
    const baseName = targetFilename.replace(/\.[^.]+$/, '');
    const targetExt = (targetFilename.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();

    for (const ext of audioExts) {
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

  private async convertAndCopy(
    track: { id: string; path: string; name: string },
    outputPath: string,
    bitrate: '128k' | '192k' | '320k'
  ): Promise<void> {
    const timestamp = Date.now();
    const { sourcePath } = buildTempPaths(track.name, timestamp);

    // Only the downloaded source needs cleanup — FFmpeg writes directly to outputPath
    const tempFiles: string[] = [sourcePath];
    
    const cleanup = async (): Promise<void> => {
      for (const file of tempFiles) {
        try {
          if (await this.deps.fs.exists(file)) {
            await this.deps.fs.unlink(file);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
      tempFiles.length = 0;
    };
    
    try {
      // Download from Jellyfin server first
      const data = await this.deps.api.downloadItem(track.id);
      await this.deps.fs.writeFile(sourcePath, data);

      // Convert directly to the final destination — no intermediate copy needed
      const result = await this.deps.converter.convertToMp3(
        sourcePath,
        outputPath,
        bitrate
      );

      if (!result.success) {
        throw new Error(result.error ?? 'Conversion failed');
      }

      // Clean up temp files on success
      await cleanup();
    } catch (error) {
      // Clean up temp files on error (critical to prevent memory leak)
      await cleanup();
      throw error;
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
    validateDestination: (path) => core.validateDestination(path),
    estimateSize: (itemIds, itemTypes) => core.estimateSize(itemIds, itemTypes),
    removeItems: (itemIds, itemTypes, destinationPath) => core.removeItems(itemIds, itemTypes, destinationPath),
    testConnection: () => core.testConnection(),
  };
}

/**
 * Public interface for SyncCore
 */
export interface SyncCore {
  sync(input: SyncInput, onProgress?: ProgressCallback): Promise<SyncResult>;
  validateDestination(path: string): Promise<DestinationValidation>;
  estimateSize(itemIds: string[], itemTypes: Map<string, ItemType>): Promise<SizeEstimate>;
  removeItems(itemIds: string[], itemTypes: Map<string, ItemType>, destinationPath: string): Promise<{ removed: number; errors: string[] }>;
  testConnection(): Promise<{ success: boolean; error?: string }>;
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