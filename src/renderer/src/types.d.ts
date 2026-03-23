import { ElectronAPI } from '@electron-toolkit/preload'

interface UsbDevice {
  device: string
  displayName: string
  size: number
  mountpoints: Array<{ path: string }>
  isRemovable: boolean
  vendorName?: string
  serialNumber?: string
  deviceInfo?: { total: number; free: number; used: number }
}

interface DeviceInfo {
  total: number
  free: number
  used: number
}

interface TrackInfo {
  id: string
  name: string
  path: string
  size: number
  format: string
}

interface SyncOptions {
  tracks: TrackInfo[]
  targetPath: string
  convertToMp3: boolean
  mp3Bitrate: string
}

interface SyncResult {
  success: boolean
  errors: string[]
  syncedFiles: number
}

interface SyncProgress {
  current: number
  total: number
  currentFile: string
  status: 'syncing' | 'completed' | 'cancelled'
}

interface Api {
  listUsbDevices: () => Promise<UsbDevice[]>
  getDeviceInfo: (devicePath: string) => Promise<DeviceInfo>
  getFilesystem: (devicePath: string) => Promise<string>
  getTrackSize: (trackPath: string) => Promise<number>
  getTrackFormat: (trackPath: string) => Promise<string>
  onUsbAttach: (callback: () => void) => (() => void) | undefined
  onUsbDetach: (callback: () => void) => (() => void) | undefined
  startSync: (options: SyncOptions) => Promise<SyncResult>
  startSync2: (options: {
    serverUrl: string;
    apiKey: string;
    userId: string;
    itemIds: string[];
    itemTypes: Record<string, 'artist' | 'album' | 'playlist'>;
    itemNames?: Record<string, string>;
    destinationPath: string;
    options?: {
      convertToMp3?: boolean;
      bitrate?: '128k' | '192k' | '320k';
    };
  }) => Promise<{ success: boolean; tracksCopied: number; tracksSkipped: number; tracksFailed: string[]; errors: string[]; totalSizeBytes?: number }>
  cancelSync: () => Promise<{ cancelled: boolean }>
  onSyncProgress: (callback: (progress: SyncProgress) => void) => (() => void) | undefined
  isFfmpegAvailable: () => Promise<boolean>
  getVersion: () => Promise<string>
  selectFolder: () => Promise<string | null>
  getFolderStats: (path: string) => Promise<{exists: boolean, isDirectory?: boolean, size?: number, modified?: string, error?: string}>
  estimateSize: (options: {
    serverUrl: string; apiKey: string; userId: string
    itemIds: string[]; itemTypes: Record<string, 'artist' | 'album' | 'playlist'>
  }) => Promise<{ trackCount: number; totalBytes: number; formatBreakdown: Record<string, number> }>
  getDeviceSyncInfo: (mountPoint: string) => Promise<{
    lastSync: string | null; totalTracks: number; totalBytes: number; syncCount: number
  } | null>
  getSyncHistory: () => Promise<Array<{
    id: number; deviceMountPoint: string; startedAt: string; completedAt: string | null
    tracksSynced: number; bytesTransferred: number; status: string
  }>>
  getSyncedItems: (mountPoint: string) => Promise<Array<{ id: string; name: string; type: 'artist' | 'album' | 'playlist' }>>
  removeItems: (options: {
    serverUrl: string; apiKey: string; userId: string
    itemIds: string[]; itemTypes: Record<string, 'artist' | 'album' | 'playlist'>
    destinationPath: string
  }) => Promise<{ removed: number; errors: string[] }>
  saveSession: (data: string) => Promise<void>
  loadSession: () => Promise<string | null>
  clearSession: () => Promise<void>
  logError: (message: string) => void
  logWarn: (message: string) => void
  logInfo: (message: string) => void
  getLogPath: () => Promise<string>
  reportBug: () => Promise<{ success: boolean; error?: string }>
  checkForUpdates: (force?: boolean) => Promise<{ updateAvailable: boolean; latestVersion: string; releaseUrl: string }>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
