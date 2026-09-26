import { type ElectronAPI } from '@electron-toolkit/preload';

interface UsbDevice {
  device: string;
  displayName: string;
  size: number;
  mountpoints: Array<{ path: string }>;
  isRemovable: boolean;
  vendorName?: string;
  serialNumber?: string;
  deviceInfo?: { total: number; free: number; used: number };
}

interface DeviceInfo {
  total: number;
  free: number;
  used: number;
}

interface TrackInfo {
  id: string;
  name: string;
  path: string;
  size: number;
  format: string;
}

interface SyncOptions {
  tracks: TrackInfo[];
  targetPath: string;
  convertToMp3: boolean;
  mp3Bitrate: string;
}

interface SyncResult {
  success: boolean;
  errors: string[];
  syncedFiles: number;
}

interface SyncProgress {
  current: number;
  total: number;
  currentFile: string;
  status: 'syncing' | 'completed' | 'cancelled';
  phase?: string;
  bytesProcessed?: number;
  totalBytes?: number;
  warning?: string;
}

interface Api {
  listUsbDevices: () => Promise<UsbDevice[]>;
  getDeviceInfo: (devicePath: string) => Promise<DeviceInfo>;
  getFilesystem: (devicePath: string) => Promise<string>;
  getTrackSize: (trackPath: string) => Promise<number>;
  getTrackFormat: (trackPath: string) => Promise<string>;
  onUsbAttach: (callback: () => void) => (() => void) | undefined;
  onUsbDetach: (callback: () => void) => (() => void) | undefined;
  startSync: (options: SyncOptions) => Promise<SyncResult>;
  startSync2: (options: {
    serverUrl: string;
    apiKey: string;
    userId: string;
    itemIds: string[];
    itemTypes: Record<string, 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre'>;
    itemNames?: Record<string, string>;
    destinationPath: string;
    options?: {
      convertToMp3?: boolean;
      bitrate?: '128k' | '192k' | '320k';
      coverArtMode?: 'off' | 'embed' | 'companion';
      lyricsMode?: 'off' | 'embed' | 'lrc';
    };
  }) => Promise<{
    success: boolean;
    tracksCopied: number;
    tracksSkipped: number;
    tracksRetagged?: number;
    lyricsAdded?: number;
    tracksFailed: string[];
    errors: string[];
    totalSizeBytes?: number;
  }>;
  cancelSync: () => Promise<{ cancelled: boolean }>;
  onSyncProgress: (callback: (progress: SyncProgress) => void) => (() => void) | undefined;
  isFfmpegAvailable: () => Promise<boolean>;
  getVersion: () => Promise<string>;
  // ORAIN-0562: stable per-installation id used in the Jellyfin Authorization
  // header. Persisted in main process; survives app restarts.
  getDeviceId: () => Promise<string>;
  selectFolder: () => Promise<string | null>;
  getFolderStats: (path: string) => Promise<{
    exists: boolean;
    isDirectory?: boolean;
    size?: number;
    modified?: string;
    error?: string;
  }>;
  getSyncedTracks: (mountPoint: string) => Promise<
    Array<{
      trackId: string;
      itemId: string;
      fileSize: number;
      destinationPath: string;
    }>
  >;
  getTracksForItem: (options: {
    serverUrl: string;
    apiKey: string;
    userId: string;
    itemId: string;
    itemType: 'artist' | 'album' | 'playlist' | 'albumArtist' | 'genre';
  }) => Promise<{
    tracks: Array<{
      id: string;
      name: string;
      path: string;
      size?: number;
      format: string;
      bitrate?: number;
      album?: string;
      albumId?: string;
      artists?: string[];
      albumArtist?: string;
      parentItemId?: string;
      durationSeconds?: number;
    }>;
    errors: string[];
  }>;
  getTracksForItems: (options: {
    serverUrl: string;
    apiKey: string;
    userId: string;
    itemIds: string[];
    itemTypes: Record<string, 'artist' | 'album' | 'playlist' | 'albumArtist' | 'genre'>;
  }) => Promise<{
    tracks: Array<{
      id: string;
      name: string;
      path: string;
      size?: number;
      format: string;
      bitrate?: number;
      album?: string;
      albumId?: string;
      artists?: string[];
      albumArtist?: string;
      parentItemId?: string;
      durationSeconds?: number;
    }>;
    errors: string[];
  }>;
  getDeviceSyncInfo: (mountPoint: string) => Promise<{
    lastSync: string | null;
    totalTracks: number;
    totalBytes: number;
    syncCount: number;
  } | null>;
  getSyncHistory: () => Promise<
    Array<{
      id: number;
      deviceMountPoint: string;
      startedAt: string;
      completedAt: string | null;
      tracksSynced: number;
      bytesTransferred: number;
      status: string;
    }>
  >;
  getSyncedItems: (mountPoint: string) => Promise<
    Array<{
      id: string;
      name: string;
      type: 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre';
    }>
  >;
  analyzeDiff: (options: {
    serverUrl: string;
    apiKey: string;
    userId: string;
    itemIds: string[];
    itemTypes: Record<string, 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre'>;
    destinationPath: string;
    options: {
      convertToMp3: boolean;
      bitrate: '128k' | '192k' | '320k';
      coverArtMode: 'off' | 'embed' | 'companion';
    };
  }) => Promise<{
    success: boolean;
    items: Array<{
      itemId: string;
      itemName: string;
      itemType: string;
      changes: Array<{ trackId: string; trackName: string; changeType: string }>;
      summary: {
        new: number;
        metadataChanged: number;
        removed: number;
        pathChanged: number;
        unchanged: number;
      };
    }>;
    totals: {
      newTracks: number;
      metadataChanged: number;
      removed: number;
      pathChanged: number;
      unchanged: number;
    };
    errors?: string[];
  }>;
  removeItems: (options: {
    serverUrl: string;
    apiKey: string;
    userId: string;
    itemIds: string[];
    itemTypes: Record<string, 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre'>;
    destinationPath: string;
  }) => Promise<{ removed: number; errors: string[] }>;
  clearDestination: (options: {
    serverUrl: string;
    apiKey: string;
    userId: string;
    destinationPath: string;
  }) => Promise<{ deleted: number; errors: string[] }>;
  saveSession: (data: string) => Promise<{ success: boolean; reason?: string }>;
  loadSession: () => Promise<string | null>;
  clearSession: () => Promise<void>;
  logError: (message: string) => void;
  logWarn: (message: string) => void;
  logInfo: (message: string) => void;
  getLogPath: () => Promise<string>;
  /** ORAIN-0727: open the system file manager on the current log file. */
  openLogFolder: () => Promise<{ success: boolean; error?: string }>;
  reportBug: () => Promise<{ success: boolean; error?: string }>;
  checkForUpdates: (force?: boolean) => Promise<{
    updateAvailable: boolean;
    latestVersion: string;
    releaseUrl: string;
    managedBySnap: boolean;
  }>;
  /** ORAIN-0573: true when running inside a snap. */
  isSnap: () => Promise<boolean>;
  /** ORAIN-0590: true when an OS-backed encryption provider is available. */
  isSessionStorageAvailable: () => Promise<boolean>;
  /**
   * ORAIN-0578, reduced in ORAIN-0590: list snap interfaces whose plug
   * isn't connected, each with the exact `sudo snap connect
   * <snap>:<interface>` command. Empty `interfaces` array outside snap OR
   * when every probe reports connected/unknown — call sites should treat
   * it as "nothing to show".
   *
   * `password-manager-service` is intentionally absent: the session
   * provider switched to `secret-tool` (ORAIN-0590), which routes through
   * the Secret portal without the plug. `hardware-observe` is also absent:
   * USB detection under snap uses polling only (ORAIN-0591). `mount-observe`
   * is also absent: nested mount detection uses `st_dev`/`statfs` instead
   * of `/proc/mounts` (ORAIN-0592).
   */
  checkSnapPermissions: () => Promise<{
    isSnap: boolean;
    snapName: string | null;
    interfaces: Array<{
      interface: 'removable-media';
      status: 'missing';
      command: string;
    }>;
  }>;
  getPreferences: () => Promise<{ analyticsEnabled: boolean }>;
  setPreferences: (prefs: { analyticsEnabled?: boolean }) => Promise<void>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    api: Api;
  }
}
