export interface UsbDevice {
  device: string;
  displayName: string;
  size: number;
  mountpoints: Array<{ path: string }>;
  isRemovable: boolean;
  vendorName?: string;
  serialNumber?: string;
  deviceInfo?: { total: number; free: number; used: number };
  deviceAddress?: number;
  vendorId?: number;
  productId?: number;
  productName?: string;
  manufacturerName?: string;
}

export interface JellyfinConfig {
  url: string;
  apiKey: string;
  userId?: string;
}

export interface Artist {
  Id: string;
  Name: string;
  AlbumCount?: number;
  ChildCount?: number;
  RunTimeTicks?: number;
  ImageTags?: { Primary?: string };
}

export interface Album {
  Id: string;
  Name: string;
  AlbumArtist?: string;
  ProductionYear?: number;
  PremiereDate?: string;
  ChildCount?: number;
  RunTimeTicks?: number;
  ImageTags?: { Primary?: string };
}

export interface Playlist {
  Id: string;
  Name: string;
  ChildCount?: number;
  RunTimeTicks?: number;
  ImageTags?: { Primary?: string };
}

export interface LibraryStats {
  ArtistCount: number;
  AlbumCount: number;
  SongCount: number;
  PlaylistCount: number;
  ItemCount: number;
}

export interface JellyfinUser {
  Id: string;
  Name: string;
  PrimaryImageTag?: string;
  Policy?: {
    IsAdministrator: boolean;
  };
}

export interface PaginationEntry<T> {
  items: T[];
  total: number;
  startIndex: number;
  hasMore: boolean;
  scrollPos: number;
}

export interface PaginationState {
  artists: PaginationEntry<Artist>;
  albums: PaginationEntry<Album>;
  playlists: PaginationEntry<Playlist>;
}

export interface Track {
  Id: string;
  Name: string;
  Artists: string[];
  AlbumName: string;
  IndexNumber: number;
  Duration: number;
  Path?: string;
  MediaSources?: Array<{ Path: string }>;
}

export type ActiveSection = 'library' | 'device';
export type LibraryTab = 'artists' | 'albums' | 'playlists';
// Re-export LyricsMode and LyricsModes from sync module to avoid duplication
export type { LyricsMode } from '../../sync/types';
export { LyricsModes } from '../../sync/types';

export type Bitrate = '128k' | '192k' | '320k';
export type CoverArtMode = 'off' | 'embed' | 'companion';

export interface SyncProgressInfo {
  current: number;
  total: number;
  file: string;
  phase?: string;
  currentTrack?: string;
  bytesProcessed?: number;
  totalBytes?: number;
  isCancelling?: boolean;
  warning?: string;
}

export interface ItemPreview {
  id: string;
  name: string;
  trackCount: number;
  sizeBytes: number;
  durationSeconds: number;
}

export interface PreviewData {
  trackCount: number;
  totalBytes: number;
  totalDurationSeconds: number;
  formatBreakdown: Record<string, number>;
  newTracksCount: number;
  newTracksBytes: number;
  newTracksDurationSeconds?: number;
  updatedTracksCount: number;
  updatedTracksBytes: number;
  updatedTracksDurationSeconds?: number;
  alreadySyncedCount: number;
  alreadySyncedBytes: number;
  alreadySyncedDurationSeconds?: number;
  willRemoveCount: number;
  willRemoveBytes: number;
  willRemoveDurationSeconds?: number;
  // Per-item breakdown for sync preview modal
  removedItems?: ItemPreview[];
  newItems?: ItemPreview[];
  updatedItems?: ItemPreview[];
  alreadySyncedItems?: ItemPreview[];
  /** True when new/updated track counts are tick-based estimates (real fetch was skipped).
   *  Already-on-device counts come from the device DB and remain reliable. */
  isTrackCountEstimate?: boolean;
}

export interface ItemTypeIndex {
  artists: Set<string>;
  albums: Set<string>;
  playlists: Set<string>;
}

export interface SavedDestination {
  id: string;
  name: string;
  path: string;
  // Encoding prefs — undefined means original quality (no conversion)
  convertToMp3?: boolean;
  bitrate?: Bitrate;
  coverArtMode?: 'off' | 'embed' | 'companion';
}
