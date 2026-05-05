
export interface MockWindowApi {
  listUsbDevices: () => Promise<Array<{
    device: string
    displayName: string
    size: number
    mountpoints: Array<{ path: string }>
    isRemovable: boolean
    vendorName?: string
    serialNumber?: string
  }>>
  getDeviceInfo: (devicePath: string) => Promise<{ total: number; free: number; used: number }>
  getFilesystem: (devicePath: string) => Promise<string>
  getTrackSize: (trackPath: string) => Promise<number>
  getTrackFormat: (trackPath: string) => Promise<string>
  onUsbAttach: (callback: () => void) => () => void
  onUsbDetach: (callback: () => void) => () => void
  startSync: (options: {
    tracks: Array<{ id: string; name: string; path: string; size: number; format: string }>
    targetPath: string
    convertToMp3: boolean
    mp3Bitrate: string
  }) => Promise<{ success: boolean; errors: string[]; syncedFiles: number }>
  startSync2: (options: {
    serverUrl: string
    apiKey: string
    userId: string
    itemIds: string[]
    itemTypes: Record<string, 'artist' | 'album' | 'playlist'>
    itemNames?: Record<string, string>
    destinationPath: string
    options?: { convertToMp3?: boolean; bitrate?: '128k' | '192k' | '320k'; coverArtMode?: 'off' | 'embed' | 'companion' }
  }) => Promise<{ success: boolean; tracksCopied: number; tracksFailed: string[]; errors: string[]; tracksSkipped?: number }>
  cancelSync: () => Promise<{ cancelled: boolean }>
  onSyncProgress: (callback: (progress: {
    current: number
    total: number
    currentFile: string
    status: 'syncing' | 'completed' | 'cancelled'
    phase?: string
    bytesProcessed?: number
    totalBytes?: number
    warning?: string
  }) => void) => () => void
  isFfmpegAvailable: () => Promise<boolean>
  getVersion: () => Promise<string>
  selectFolder: () => Promise<string | null>
  getFolderStats: (folderPath: string) => Promise<{
    exists: boolean
    isDirectory?: boolean
    size?: number
    modified?: string
    error?: string
  }>
  estimateSize: (options: {
    serverUrl: string
    apiKey: string
    userId: string
    itemIds: string[]
    itemTypes: Record<string, 'artist' | 'album' | 'playlist'>
  }) => Promise<{ trackCount: number; totalBytes: number; formatBreakdown: Record<string, number> }>
  getDeviceSyncInfo: (mountPoint: string) => Promise<{
    lastSync: string | null
    totalTracks: number
    totalBytes: number
    syncCount: number
  } | null>
  getSyncHistory: () => Promise<Array<{
    id: number
    deviceMountPoint: string
    startedAt: string
    completedAt: string | null
    tracksSynced: number
    bytesTransferred: number
    status: string
  }>>
  getSyncedItems: (mountPoint: string) => Promise<Array<{ id: string; name: string; type: 'artist' | 'album' | 'playlist' }>>
  analyzeDiff: (options: {
    serverUrl: string
    apiKey: string
    userId: string
    itemIds: string[]
    itemTypes: Record<string, 'artist' | 'album' | 'playlist'>
    destinationPath: string
    options: { convertToMp3: boolean; bitrate: '128k' | '192k' | '320k'; coverArtMode: 'off' | 'embed' | 'companion' }
  }) => Promise<{
    success: boolean
    items: Array<{
      itemId: string
      itemName: string
      itemType: string
      changes: Array<{ trackId: string; trackName: string; changeType: string }>
      summary: { new: number; metadataChanged: number; removed: number; pathChanged: number; unchanged: number }
    }>
    totals: { newTracks: number; metadataChanged: number; removed: number; pathChanged: number; unchanged: number }
    errors?: string[]
  }>
  removeItems: (options: {
    serverUrl: string
    apiKey: string
    userId: string
    itemIds: string[]
    itemTypes: Record<string, 'artist' | 'album' | 'playlist'>
    destinationPath: string
  }) => Promise<{ removed: number; errors: string[] }>
  clearDestination: (options: {
    serverUrl: string
    apiKey: string
    userId: string
    destinationPath: string
  }) => Promise<{ deleted: number; errors: string[] }>
  saveSession: (data: string) => Promise<{ success: boolean; reason?: string }>
  loadSession: () => Promise<string | null>
  clearSession: () => Promise<void>
  logError: (message: string) => void
  logWarn: (message: string) => void
  logInfo: (message: string) => void
  getLogPath: () => Promise<string>
  reportBug: () => Promise<{ success: boolean; error?: string }>
  checkForUpdates: (force?: boolean) => Promise<{ updateAvailable: boolean; latestVersion: string; releaseUrl: string }>
}

export function createMockWindowApi(overrides?: Partial<MockWindowApi>): MockWindowApi {
  const defaultApi: MockWindowApi = {
    listUsbDevices: () => Promise.resolve([]),
    getDeviceInfo: () => Promise.resolve({ total: 0, free: 0, used: 0 }),
    getFilesystem: () => Promise.resolve('unknown'),
    getTrackSize: () => Promise.resolve(0),
    getTrackFormat: () => Promise.resolve('mp3'),
    onUsbAttach: () => () => {},
    onUsbDetach: () => () => {},
    startSync: () => Promise.resolve({ success: true, errors: [], syncedFiles: 0 }),
    startSync2: () => Promise.resolve({ success: true, tracksCopied: 0, tracksFailed: [], errors: [] }),
    cancelSync: () => Promise.resolve({ cancelled: true }),
    onSyncProgress: () => () => {},
    isFfmpegAvailable: () => Promise.resolve(true),
    getVersion: () => Promise.resolve('0.0.0'),
    selectFolder: () => Promise.resolve(null),
    getFolderStats: () => Promise.resolve({ exists: false }),
    estimateSize: () => Promise.resolve({ trackCount: 0, totalBytes: 0, formatBreakdown: {} }),
    getDeviceSyncInfo: () => Promise.resolve(null),
    getSyncHistory: () => Promise.resolve([]),
    getSyncedItems: () => Promise.resolve([]),
    analyzeDiff: () => Promise.resolve({ success: true, items: [], totals: { newTracks: 0, metadataChanged: 0, removed: 0, pathChanged: 0, unchanged: 0 } }),
    removeItems: () => Promise.resolve({ removed: 0, errors: [] }),
    clearDestination: () => Promise.resolve({ deleted: 0, errors: [] }),
    saveSession: () => Promise.resolve({ success: true }),
    loadSession: () => Promise.resolve(null),
    clearSession: () => Promise.resolve(),
    logError: () => {},
    logWarn: () => {},
    logInfo: () => {},
    getLogPath: () => Promise.resolve(''),
    reportBug: () => Promise.resolve({ success: false }),
    checkForUpdates: () => Promise.resolve({ updateAvailable: false, latestVersion: '', releaseUrl: '' }),
  }

  return { ...defaultApi, ...overrides }
}

export function createMockWindowApiForUseDeviceSelections(overrides?: Partial<MockWindowApi>): MockWindowApi {
  return createMockWindowApi({
    getSyncedItems: () => Promise.resolve([]),
    analyzeDiff: () => Promise.resolve({
      success: true,
      items: [],
      totals: { newTracks: 0, metadataChanged: 0, removed: 0, pathChanged: 0, unchanged: 0 },
    }),
    estimateSize: () => Promise.resolve({ trackCount: 0, totalBytes: 0, formatBreakdown: {} }),
    ...overrides,
  })
}

export function createMockWindowApiForUseSync(overrides?: Partial<MockWindowApi>): MockWindowApi {
  return createMockWindowApi({
    selectFolder: () => Promise.resolve('/mock/device'),
    estimateSize: () => Promise.resolve({ trackCount: 5, totalBytes: 1_000_000, formatBreakdown: { mp3: 1_000_000 } }),
    getSyncedItems: () => Promise.resolve([]),
    startSync2: () => Promise.resolve({ success: true, tracksCopied: 5, tracksFailed: [], errors: [], tracksSkipped: 0 }),
    removeItems: () => Promise.resolve({ removed: 0, errors: [] }),
    cancelSync: () => Promise.resolve({ cancelled: true }),
    onSyncProgress: () => () => {},
    ...overrides,
  })
}
