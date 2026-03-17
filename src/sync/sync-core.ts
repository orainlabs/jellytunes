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
} from './types';

import {
  validateSyncConfig,
  resolveSyncOptions,
  createSyncConfig,
  buildDestinationPath,
  getRelativePath,
  getFilenameFromPath,
} from './sync-config';

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

/**
 * Validate that a path stays within allowed boundaries (prevent path traversal)
 */
function validatePathTraversal(basePath: string, relativePath: string): void {
  // Check for path traversal attempts (only .. should be blocked)
  // Note: paths may contain consecutive slashes, so we normalize first
  const normalizedPath = relativePath.replace(/\/+/g, '/');
  
  if (normalizedPath.includes('..')) {
    throw new Error(`Path traversal attempt detected: "${relativePath}" would escape "${basePath}"`);
  }
  
  // Normalize and verify the final path is still within base
  const normalizedBase = basePath.replace(/\/+$/, '');
  const normalizedFull = `${normalizedBase}/${normalizedPath}`.replace(/\/+/g, '/');
  
  if (!normalizedFull.startsWith(normalizedBase + '/') && normalizedFull !== normalizedBase) {
    throw new Error(`Path traversal attempt detected: final path "${normalizedFull}" escapes base "${basePath}"`);
  }
}

/**
 * Dependencies container (for dependency injection)
 */
export interface SyncDependencies {
  api: SyncApi;
  fs: FileSystem;
  converter: AudioConverter;
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
  private progressEmitter: ProgressEmitter;
  private cancellation: CancellationController;
  private serverRootPath: string;
  
  constructor(config: SyncConfig, deps?: SyncDependencies) {
    // Validate config
    const validation = validateSyncConfig(config);
    if (!validation.valid) {
      throw new Error(`Invalid config: ${validation.errors.join(', ')}`);
    }
    
    this.config = config;
    this.deps = deps ?? createDefaultDependencies(config);
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
        }
      }
      
      errors.push(...fetchErrors);
      totalTracks = tracks.length;
      
      if (tracks.length === 0) {
        return {
          success: false,
          tracksCopied: 0,
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
          const outputDir = this.getOutputDir(track, input.destinationPath, options.preserveStructure ?? true);
          await ensureDirectory(outputDir, this.deps.fs);
          
          const outputFilename = await this.getOutputFilename(track, outputDir, options);
          const outputPath = `${outputDir}/${outputFilename}`;
          
          // Check if already exists and skip
          if (options.skipExisting && await this.deps.fs.exists(outputPath)) {
            const existingStat = await this.deps.fs.stat(outputPath);
            if (existingStat.size === track.size) {
              stats.itemsProcessed++;
              continue;
            }
          }
          
          // Copy or convert
          if (options.convertToMp3 && this.needsConversion(track.format)) {
            await this.convertAndCopy(track, outputPath, options.bitrate ?? '192k');
            stats.itemsConverted++;
          } else {
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
    preserveStructure: boolean
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
        return `${basePath}/${parts.join('/')}`;
      }
      return basePath;
    }

    // Metadata fallback when no path available
    const parts = [basePath, 'lib'];

    if (track.artists?.[0]) {
      parts.push(track.artists[0].replace(/[<>:"/\\|?*]/g, '_').slice(0, 100));
    }

    if (track.album) {
      let folder = track.album.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
      if (track.year) folder += ` (${track.year})`;
      parts.push(folder);
    }

    return parts.join('/');
  }
  
  /**
   * Get output filename
   * Uses original filename from server path if available, otherwise reconstructs from metadata
   */
  private async getOutputFilename(
    track: { name: string; path: string; format: string; trackNumber?: number; artists?: string[]; album?: string },
    outputDir: string,
    options: ReturnType<typeof resolveSyncOptions>
  ): Promise<string> {
    if (track.path) {
      const filename = this.resolveFilenameFromPath(track, options);
      return getUniqueFilename(outputDir, filename, this.deps.fs);
    }

    // Fallback: reconstruct from metadata when no server path is available
    const filename = this.buildFilenameFromMetadata(track, options);
    return getUniqueFilename(outputDir, filename, this.deps.fs);
  }

  private resolveFilenameFromPath(
    track: { path: string; format: string },
    options: ReturnType<typeof resolveSyncOptions>
  ): string {
    let filename = getFilenameFromPath(track.path);

    filename = filename.replace(/[<>:"|?*]/g, '_');
    if (filename.includes('..') || filename.startsWith('.') || filename.endsWith(' ')) {
      throw new Error(`Invalid filename: suspicious characters detected in "${filename}"`);
    }

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
  
  private needsConversion(format: string): boolean {
    const convertible = ['flac', 'wav', 'm4a', 'aac', 'ogg'];
    return convertible.includes(format.toLowerCase());
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

          const artistLabel = track.artists?.join(', ') ?? track.albumArtist ?? '';
          const displayName = artistLabel ? `${artistLabel} - ${track.name}` : track.name;
          lines.push(`#EXTINF:-1,${displayName}`);
          lines.push(relativePath);
        }

        await this.deps.fs.writeFile(m3u8Path, Buffer.from(lines.join('\n') + '\n', 'utf8'));
      } catch {
        // M3U8 generation is non-fatal
      }
    }
  }

  private async cleanEmptyDir(dir: string, basePath: string): Promise<void> {
    if (dir === basePath || !dir.startsWith(basePath + '/')) return;
    try {
      const contents = await this.deps.fs.readdir(dir);
      if (contents.length === 0) {
        await this.deps.fs.rmdir(dir);
        const parent = dir.substring(0, dir.lastIndexOf('/'));
        await this.cleanEmptyDir(parent, basePath);
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  private async convertAndCopy(
    track: { id: string; path: string; name: string },
    outputPath: string,
    bitrate: '128k' | '192k' | '320k'
  ): Promise<void> {
    const timestamp = Date.now();
    const safeName = track.name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50);
    const tempPath = `/tmp/jellysync_${timestamp}_${safeName}.mp3`;
    const sourcePath = `/tmp/jellysync_src_${timestamp}.tmp`;
    
    // Track temp files for cleanup
    const tempFiles: string[] = [tempPath, sourcePath];
    
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
      
      // Now convert the downloaded file
      const result = await this.deps.converter.convertToMp3(
        sourcePath,
        tempPath,
        bitrate
      );
      
      if (!result.success) {
        throw new Error(result.error ?? 'Conversion failed');
      }
      
      await this.deps.fs.copyFile(tempPath, outputPath);
      
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
export function createSyncCore(config: SyncConfig, deps?: SyncDependencies): SyncCore {
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