/**
 * JellyTunes Sync Module - Type Definitions
 * 
 * Core interfaces for the synchronization module.
 * These types define the public API contract.
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Required configuration to connect to Jellyfin server
 */
export interface SyncConfig {
  /** Jellyfin server URL (e.g., 'https://jellyfin.example.com') */
  serverUrl: string;
  /** Jellyfin API key with appropriate permissions */
  apiKey: string;
  /** User ID for library access */
  userId: string;
  /** Server root path to strip from track paths (e.g., '/mediamusic/lib/lib/') */
  serverRootPath?: string;
}

/**
 * Validation result for SyncConfig
 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

// =============================================================================
// INPUT / OUTPUT
// =============================================================================

/**
 * Item type classification for sync operations
 */
export type ItemType = 'artist' | 'album' | 'playlist';

/**
 * Input for sync operation
 */
export interface SyncInput {
  /** IDs of items to sync (artists, albums, or playlists) */
  itemIds: string[];
  /** Map of item ID to its type for efficient lookup */
  itemTypes: Map<string, ItemType>;
  /** Destination path for synced files */
  destinationPath: string;
  /** Optional conversion settings */
  options?: SyncOptions;
}

/**
 * Destination filesystem type — used to apply compatibility sanitization
 */
export type FilesystemType = 'fat32' | 'exfat' | 'ntfs' | 'apfs' | 'hfs+' | 'ext4' | 'unknown';

/**
 * Cover art handling mode
 */
export type CoverArtMode = 'embed' | 'companion' | 'off';

/**
 * Lyrics sync mode
 */
export type LyricsMode = 'lrc' | 'embed' | 'off';

/**
 * Optional sync behavior settings
 */
export interface SyncOptions {
  /** Convert FLAC to MP3 during sync */
  convertToMp3?: boolean;
  /** MP3 bitrate for conversion (ignored if convertToMp3 is false) */
  bitrate?: '128k' | '192k' | '320k';
  /** Skip existing files with same size */
  skipExisting?: boolean;
  /** Preserve folder structure (e.g., Artist/Album/Track) */
  preserveStructure?: boolean;
  /** Destination filesystem — enables compatibility sanitization for FAT32/exFAT/NTFS */
  filesystemType?: FilesystemType;
  /** Embed metadata from Jellyfin (default: true) */
  embedMetadata?: boolean;
  /** Cover art mode (default: 'embed') */
  coverArtMode?: CoverArtMode;
  /** Lyrics sync mode (default: 'off') */
  lyricsMode?: LyricsMode;
}

/**
 * Metadata fields to write to audio files via FFmpeg.
 * Jellyfin takes priority in all fields; missing fields are skipped (not cleared).
 */
export interface TrackMetadata {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  year?: string;
  trackNumber?: string;
  discNumber?: string;
  genres?: string[];
  /** Additional fields preserved from original file (not from Jellyfin) */
  composer?: string;
  isrc?: string;
  copyright?: string;
  comment?: string;
}

/**
 * Individual track information for sync
 */
export interface TrackInfo {
  /** Jellyfin track ID */
  id: string;
  /** Track name */
  name: string;
  /** Album name */
  album?: string;
  /** Artist name(s) */
  artists?: string[];
  /** Album artist */
  albumArtist?: string;
  /** Production year */
  year?: number;
  /** Genre(s) */
  genres?: string[];
  /** Album ID on Jellyfin server (used for cover art caching) */
  albumId?: string;
  /** Parent item ID this track belongs to (artist/album/playlist) — set by getTracksForItems */
  parentItemId?: string;
  /** File path on Jellyfin server */
  path: string;
  /** Audio format (mp3, flac, m4a, etc.) */
  format: string;
  /** File size in bytes */
  size?: number;
  /** Bitrate in bits per second (e.g. 320000 for 320 kbps), as reported by Jellyfin */
  bitrate?: number;
  /** Track number */
  trackNumber?: number;
  /** Disc number */
  discNumber?: number;
}

// =============================================================================
// PROGRESS & EVENTS
// =============================================================================

/**
 * Sync phase enumeration
 */
export type SyncPhase = 'fetching' | 'copying' | 'converting' | 'validating' | 'complete' | 'cancelled' | 'error';

/**
 * Progress event data
 */
export interface SyncProgress {
  /** Current phase of sync operation */
  phase: SyncPhase;
  /** Current item number (1-indexed) */
  current: number;
  /** Total items to process */
  total: number;
  /** Currently processing track name */
  currentTrack?: string;
  /** Bytes processed so far */
  bytesProcessed?: number;
  /** Total bytes to process */
  totalBytes?: number;
  /** Error message if phase is 'error' */
  errorMessage?: string;
  /** Non-blocking warning message (e.g. cover art unavailable) */
  warning?: string;
}

/**
 * Progress callback function type
 */
export type ProgressCallback = (progress: SyncProgress) => void;

// =============================================================================
// RESULT
// =============================================================================

/**
 * Sync operation result
 */
export interface SyncResult {
  /** Whether sync completed successfully */
  success: boolean;
  /** Number of tracks successfully copied/converted */
  tracksCopied: number;
  /** Number of tracks skipped (already up-to-date on device) */
  tracksSkipped: number;
  /** Number of tracks re-tagged (metadata-only update, no re-download) */
  tracksRetagged: number;
  /** Number of tracks moved/renamed (album rename detected) */
  tracksMoved: number;
  /** Number of orphaned tracks removed from device */
  tracksRemoved: number;
  /** Number of tracks that received lyrics successfully */
  lyricsAdded: number;
  /** Track IDs that failed to sync */
  tracksFailed: string[];
  /** Detailed error messages */
  errors: string[];
  /** Total size of files synced (bytes) */
  totalSizeBytes: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether sync was cancelled by user */
  cancelled?: boolean;
}

/**
 * Size estimation result
 */
export interface SizeEstimate {
  /** Total size in bytes (synced + new) */
  totalBytes: number;
  /** Number of tracks */
  trackCount: number;
  /** Breakdown by format */
  formatBreakdown: Map<string, number>;
  /** Breakdown by item type */
  typeBreakdown: Map<ItemType, number>;
  /** Size of tracks already synced on device */
  syncedMusicBytes: number;
  /** Size of tracks not yet synced */
  newMusicBytes: number;
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Destination path validation result
 */
export interface DestinationValidation {
  /** Path is valid for writing */
  valid: boolean;
  /** Path exists */
  exists: boolean;
  /** Path is writable */
  writable: boolean;
  /** Available disk space in bytes */
  freeSpace?: number;
  /** Error messages if invalid */
  errors: string[];
}

// =============================================================================
// INTERNAL TYPES (for testing)
// =============================================================================

/**
 * Jellyfin API response for a track item
 * @internal
 */
export interface JellyfinTrackItem {
  Id: string;
  Name: string;
  Album?: string;
  AlbumName?: string;
  AlbumArtist?: string;
  Artists?: string[];
  Genres?: string[];
  AlbumId?: string;
  Path?: string;
  MediaSources?: Array<{
    Path: string;
    Container?: string;
    Size?: number;
    Bitrate?: number;
  }>;
  IndexNumber?: number;
  ParentIndexNumber?: number;
}

/**
 * Jellyfin API response for an album
 * @internal
 */
export interface JellyfinAlbumItem {
  Id: string;
  Name: string;
  AlbumArtist?: string;
  ProductionYear?: number;
}

/**
 * Jellyfin API response for a playlist
 * @internal
 */
export interface JellyfinPlaylistItem {
  Id: string;
  Name: string;
  ChildCount?: number;
}

// =============================================================================
// LOGGING
// =============================================================================

/**
 * Minimal logger interface for the sync module.
 * Injected as an optional dependency so the module stays testable without electron-log.
 */
export interface SyncLogger {
  info:  (msg: string) => void
  warn:  (msg: string) => void
  error: (msg: string) => void
  debug: (msg: string) => void
}

/**
 * Fetch result for tracks from various item types
 * @internal
 */
export interface FetchedTracks {
  tracks: TrackInfo[];
  sourceItemId: string;
  sourceItemType: ItemType;
  errors: string[];
}

// =============================================================================
// DIFF ENGINE (Phase 2)
// =============================================================================

/**
 * Types of changes detected during diff analysis.
 */
export type TrackChangeType =
  | 'new'
  | 'metadata_changed'
  | 'cover_art_changed'
  | 'bitrate_changed'
  | 'removed'
  | 'path_changed'
  | 'unchanged';

/**
 * Individual track change record.
 */
export interface TrackChange {
  trackId: string;
  trackName: string;
  changeType: TrackChangeType;
  details?: string;
}

/**
 * Diff result for a single item (artist/album/playlist).
 */
export interface ItemDiff {
  itemId: string;
  itemName: string;
  itemType: ItemType;
  changes: TrackChange[];
  summary: {
    new: number;
    metadataChanged: number;
    removed: number;
    pathChanged: number;
    unchanged: number;
  };
  /** For artist items: per-album breakdown of which albums have changes */
  subItems?: Array<{
    itemId: string;
    summary: { newTracks: number; metadataChanged: number; pathChanged: number };
  }>;
}

/**
 * Complete diff analysis result for a sync operation.
 */
export interface SyncDiffResult {
  items: ItemDiff[];
  totals: {
    newTracks: number;
    metadataChanged: number;
    removed: number;
    pathChanged: number;
    unchanged: number;
  };
  /** Item-level errors encountered during diff (e.g. API failures) */
  itemErrors?: { itemId: string; itemName: string; error: string }[];
}