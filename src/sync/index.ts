/**
 * JellyTunes Sync Module
 *
 * Public API for the synchronization module.
 *
 * Usage:
 * ```typescript
 * import { createSyncCore, SyncConfig, SyncInput } from './sync';
 *
 * const config: SyncConfig = {
 *   serverUrl: 'https://jellyfin.example.com',
 *   apiKey: 'your-api-key',
 *   userId: 'user-id'
 * };
 *
 * const syncCore = createSyncCore(config);
 *
 * const input: SyncInput = {
 *   itemIds: ['album-id-1', 'album-id-2'],
 *   itemTypes: new Map([
 *     ['album-id-1', 'album'],
 *     ['album-id-2', 'album']
 *   ]),
 *   destinationPath: '/mnt/usb/music'
 * };
 *
 * const result = await syncCore.sync(input, (progress) => {
 *   console.log(`${progress.phase}: ${progress.current}/${progress.total}`);
 * });
 * ```
 */

// Types
export type {
  SyncConfig,
  SyncInput,
  SyncOptions,
  SyncProgress,
  SyncResult,
  SyncPhase,
  ItemType,
  TrackInfo,
  SizeEstimate,
  DestinationValidation,
  ProgressCallback,
  CoverArtMode,
  LyricsMode,
  Id3TagVersion,
  TrackChangeType,
  TrackChange,
  ItemDiff,
  SyncDiffResult,
} from './types';

// Core
export { createSyncCore, type SyncCore } from './sync-core';
export type { SyncDependencies } from './sync-core';

// Config
export {
  validateSyncConfig,
  resolveSyncOptions,
  normalizeServerUrl,
  createSyncConfig as createValidatedConfig,
} from './sync-config';

// API
export {
  createApiClient,
  createMockApiClient,
  type SyncApi,
  type ApiClientConfig,
  type ApiIdentity,
} from './sync-api';

// Files
export {
  createNodeFileSystem,
  createMockFileSystem,
  createFFmpegConverter,
  createMockConverter,
  validateDestination,
  formatSize,
} from './sync-files';
export type { FileSystem, AudioConverter } from './sync-files';

// Progress
export {
  createProgressEmitter,
  createCancellationController,
  SyncCancelledError,
  ProgressBuilder,
  progress,
  PhaseManager,
} from './sync-progress';
