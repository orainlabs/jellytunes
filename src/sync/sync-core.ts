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
            await this.deps.fs.copyFile(track.path, outputPath);
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
   * Test connection to Jellyfin
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    return this.deps.api.testConnection();
  }
  
  // Private helpers
  
  /**
   * Get output directory path
   * Uses server root mapping if configured, otherwise falls back to preserving original path structure
   */
  private getOutputDir(
    track: {path: string; artists?: string[]; album?: string; year?: number},
    basePath: string,
    preserveStructure: boolean
  ): string {
    // If server root path is configured (or auto-detected), use original server path structure
    if (this.serverRootPath && track.path) {
      const relativePath = getRelativePath(track.path, this.serverRootPath);
      // Extract directory part from relative path
      const pathParts = relativePath.split('/');
      if (pathParts.length > 1) {
        // Remove filename, keep directory structure
        pathParts.pop();
        const dirRelative = pathParts.join('/');
        return `${basePath}/${dirRelative}`;
      }
      // Only filename, use base path
      return basePath;
    }
    
    // No serverRootPath: preserve original path structure from server
    // This ensures we don't lose the folder hierarchy even without explicit mapping
    if (track.path && preserveStructure) {
      // Extract directory from original path
      const pathParts = track.path.split('/');
      if (pathParts.length > 1) {
        // Remove filename, keep directory structure
        pathParts.pop();
        const dirRelative = pathParts.join('/');
        // Combine with destination base but preserve server structure
        return `${basePath}/${dirRelative}`;
      }
    }
    
    // Fallback: reconstruct from metadata only if preserveStructure is false
    // or if we have no path to work with
    if (!preserveStructure || !track.path) {
      return basePath;
    }
    
    const parts = [basePath, 'lib'];
    
    if (track.artists && track.artists.length > 0) {
      parts.push(this.sanitize(track.artists[0]));
    }
    
    if (track.album) {
      let albumFolder = this.sanitize(track.album);
      if (track.year) {
        albumFolder += ` (${track.year})`;
      }
      parts.push(albumFolder);
    }
    
    return parts.join('/');
  }
  
  private sanitize(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
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
    // If server root path is configured (or auto-detected), use original filename from server path
    if (this.serverRootPath && track.path) {
      const extension = options.convertToMp3 ? 'mp3' : track.format.toLowerCase();
      const originalFilename = getFilenameFromPath(track.path);
      
      // Replace extension if converting to mp3
      let filename = originalFilename;
      if (options.convertToMp3 && !originalFilename.toLowerCase().endsWith('.mp3')) {
        filename = originalFilename.replace(/\.[^.]+$/, `.${extension}`);
      }
      
      return getUniqueFilename(outputDir, filename, this.deps.fs);
    }
    
    // No serverRootPath: preserve original filename from server path
    if (track.path) {
      const extension = options.convertToMp3 ? 'mp3' : track.format.toLowerCase();
      const originalFilename = getFilenameFromPath(track.path);
      
      // Replace extension if converting to mp3
      let filename = originalFilename;
      if (options.convertToMp3 && !originalFilename.toLowerCase().endsWith('.mp3')) {
        filename = originalFilename.replace(/\.[^.]+$/, `.${extension}`);
      }
      
      return getUniqueFilename(outputDir, filename, this.deps.fs);
    }
    
    // Fallback: reconstruct from metadata only if we have no path
    const extension = options.convertToMp3 ? 'mp3' : track.format.toLowerCase();
    const baseName = track.name.replace(/[<>:"/\\|?*]/g, '_');
    const artistName = track.artists?.[0]?.replace(/[<>:"/\\|?*]/g, '_') ?? 'Unknown Artist';
    const albumName = track.album?.replace(/[<>:"/\\|?*]/g, '_') ?? 'Unknown Album';
    
    let filename: string;
    if (track.trackNumber && options.preserveStructure) {
      // Format: Artista - Álbum - Nº - Título.ext
      const trackNum = String(track.trackNumber).padStart(2, '0');
      filename = `${artistName} - ${albumName} - ${trackNum} - ${baseName}.${extension}`;
    } else {
      filename = `${baseName}.${extension}`;
    }
    
    return getUniqueFilename(outputDir, filename, this.deps.fs);
  }
  
  private needsConversion(format: string): boolean {
    const convertible = ['flac', 'wav', 'm4a', 'aac', 'ogg'];
    return convertible.includes(format.toLowerCase());
  }
  
  private async convertAndCopy(
    track: { path: string; name: string },
    outputPath: string,
    bitrate: '128k' | '192k' | '320k'
  ): Promise<void> {
    const tempPath = `/tmp/jellysync_${Date.now()}_${track.name.replace(/[^a-zA-Z0-9]/g, '_')}.mp3`;
    
    try {
      const result = await this.deps.converter.convertToMp3(
        track.path,
        tempPath,
        bitrate
      );
      
      if (!result.success) {
        throw new Error(result.error ?? 'Conversion failed');
      }
      
      await this.deps.fs.copyFile(tempPath, outputPath);
      
      // Clean up temp file
      try {
        await this.deps.fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    } catch (error) {
      // Clean up temp file on error
      try {
        await this.deps.fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
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