import { useEffect, useState } from 'react'
import { HardDrive, Folder, Loader2, Trash2, Music, RefreshCw, X } from 'lucide-react'
import type { Artist, Album, Playlist, Bitrate, SyncProgressInfo, PreviewData } from '../appTypes'
import { SyncPreviewModal } from './SyncPreviewModal'

interface DeviceInfo {
  total: number
  free: number
  used: number
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

interface SyncItem {
  id: string
  name: string
  type: 'artist' | 'album' | 'playlist'
  state: 'synced' | 'new' | 'remove'
}

interface DeviceSyncPanelProps {
  destinationPath: string
  destinationName: string
  isUsbDevice: boolean
  isSaved: boolean
  convertToMp3: boolean
  bitrate: Bitrate
  isSyncing: boolean
  isLoadingPreview: boolean
  syncProgress: SyncProgressInfo | null
  selectedTracks: Set<string>
  previouslySyncedItems: Set<string>
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
  showPreview: boolean
  previewData: PreviewData | null
  onToggleConvert: () => void
  onBitrateChange: (b: Bitrate) => void
  onStartSync: () => void
  onCancelPreview: () => void
  onConfirmSync: () => void
  onRemoveDestination?: () => void
}

export function DeviceSyncPanel({
  destinationPath,
  destinationName,
  isUsbDevice,
  isSaved,
  convertToMp3,
  bitrate,
  isSyncing,
  isLoadingPreview,
  syncProgress,
  selectedTracks,
  previouslySyncedItems,
  artists,
  albums,
  playlists,
  showPreview,
  previewData,
  onToggleConvert,
  onBitrateChange,
  onStartSync,
  onCancelPreview,
  onConfirmSync,
  onRemoveDestination,
}: DeviceSyncPanelProps): JSX.Element {
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null)

  useEffect(() => {
    setDeviceInfo(null)
    window.api.getDeviceInfo(destinationPath)
      .then(info => { if (info?.total) setDeviceInfo(info) })
      .catch(() => {/* ignore */})
  }, [destinationPath])

  // Compute sync state for each selected/previously-synced item
  const syncItems: SyncItem[] = []

  const addItems = <T extends { Id: string; Name: string }>(
    items: T[],
    type: 'artist' | 'album' | 'playlist'
  ) => {
    for (const item of items) {
      const isSelected = selectedTracks.has(item.Id)
      const wasSynced = previouslySyncedItems.has(item.Id)
      if (isSelected && wasSynced) syncItems.push({ id: item.Id, name: item.Name, type, state: 'synced' })
      else if (isSelected && !wasSynced) syncItems.push({ id: item.Id, name: item.Name, type, state: 'new' })
      else if (!isSelected && wasSynced) syncItems.push({ id: item.Id, name: item.Name, type, state: 'remove' })
    }
  }

  addItems(artists, 'artist')
  addItems(albums, 'album')
  addItems(playlists, 'playlist')

  const newItems = syncItems.filter(i => i.state === 'new')
  const syncedItems = syncItems.filter(i => i.state === 'synced')
  const removeItems = syncItems.filter(i => i.state === 'remove')

  const usedPct = deviceInfo ? Math.round((deviceInfo.used / deviceInfo.total) * 100) : null

  const Icon = isUsbDevice ? HardDrive : Folder

  return (
    <>
      <div className="flex-1 overflow-auto p-6 max-w-2xl">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-zinc-800 rounded-xl flex items-center justify-center">
              <Icon className="w-6 h-6 text-blue-400" />
            </div>
            <div>
              <h2 className="text-xl font-semibold">{destinationName}</h2>
              <p className="text-xs text-zinc-500 font-mono mt-0.5">{destinationPath}</p>
            </div>
          </div>
          {isSaved && onRemoveDestination && (
            <button
              onClick={onRemoveDestination}
              className="p-2 text-zinc-600 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
              title="Remove destination"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Space bar */}
        {deviceInfo ? (
          <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 mb-4">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-zinc-400">Storage</span>
              <span className="text-zinc-300">{formatBytes(deviceInfo.free)} free of {formatBytes(deviceInfo.total)}</span>
            </div>
            <div className="w-full bg-zinc-700 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all ${usedPct! > 90 ? 'bg-red-500' : usedPct! > 70 ? 'bg-yellow-500' : 'bg-blue-500'}`}
                style={{ width: `${usedPct}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 mb-4 h-16 animate-pulse" />
        )}

        {/* Sync items overview */}
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 mb-4 overflow-hidden">
          {syncItems.length === 0 ? (
            <div className="p-6 text-center text-zinc-500 text-sm">
              <Music className="w-8 h-8 mx-auto mb-2 opacity-40" />
              No items selected for sync
            </div>
          ) : (
            <div className="divide-y divide-zinc-800">
              {/* New items */}
              {newItems.length > 0 && (
                <div className="p-4">
                  <p className="text-xs font-medium text-blue-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <RefreshCw className="w-3 h-3" /> New · {newItems.length}
                  </p>
                  <div className="space-y-1">
                    {newItems.map(item => (
                      <div key={item.id} className="flex items-center gap-2 text-sm">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                        <span className="truncate">{item.name}</span>
                        <span className="text-xs text-zinc-600 ml-auto flex-shrink-0">{item.type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Already synced */}
              {syncedItems.length > 0 && (
                <div className="p-4">
                  <p className="text-xs font-medium text-green-400 uppercase tracking-wider mb-2">
                    Already synced · {syncedItems.length}
                  </p>
                  <div className="space-y-1">
                    {syncedItems.map(item => (
                      <div key={item.id} className="flex items-center gap-2 text-sm text-zinc-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
                        <span className="truncate">{item.name}</span>
                        <span className="text-xs text-zinc-600 ml-auto flex-shrink-0">{item.type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Will remove */}
              {removeItems.length > 0 && (
                <div className="p-4">
                  <p className="text-xs font-medium text-red-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <X className="w-3 h-3" /> Will remove · {removeItems.length}
                  </p>
                  <div className="space-y-1">
                    {removeItems.map(item => (
                      <div key={item.id} className="flex items-center gap-2 text-sm text-zinc-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
                        <span className="truncate line-through opacity-60">{item.name}</span>
                        <span className="text-xs text-zinc-600 ml-auto flex-shrink-0">{item.type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Convert to MP3 */}
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium">Convert to MP3</span>
              <p className="text-xs text-zinc-500 mt-0.5">
                {convertToMp3 ? `FLAC/lossless → MP3 ${bitrate}` : 'Copy files as-is'}
              </p>
            </div>
            <button
              onClick={onToggleConvert}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${convertToMp3 ? 'bg-blue-600' : 'bg-zinc-600'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${convertToMp3 ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          {convertToMp3 && (
            <div className="flex items-center gap-2 mt-3">
              <span className="text-xs text-zinc-400">Bitrate:</span>
              {(['128k', '192k', '320k'] as const).map(b => (
                <button
                  key={b}
                  onClick={() => onBitrateChange(b)}
                  className={`px-2.5 py-1 text-xs rounded-lg ${bitrate === b ? 'bg-blue-600 text-white' : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'}`}
                >
                  {b}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Sync button + progress */}
        <button
          onClick={onStartSync}
          disabled={isSyncing || isLoadingPreview || syncItems.length === 0}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-700 disabled:text-zinc-500 py-3 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
        >
          {isLoadingPreview ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Calculating...</>
          ) : isSyncing ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Syncing...</>
          ) : (
            'Start Sync'
          )}
        </button>

        {syncProgress && (
          <div className="mt-4 p-4 bg-zinc-900 rounded-xl border border-zinc-800">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-zinc-400">Progress</span>
              <span>{syncProgress.current} / {syncProgress.total}</span>
            </div>
            <div className="w-full bg-zinc-700 rounded-full h-1.5 mb-2">
              <div
                className="bg-blue-600 h-1.5 rounded-full transition-all"
                style={{ width: `${syncProgress.total > 0 ? (syncProgress.current / syncProgress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="text-xs text-zinc-500 truncate">{syncProgress.file}</p>
          </div>
        )}
      </div>

      {showPreview && previewData && (
        <SyncPreviewModal
          data={previewData}
          convertToMp3={convertToMp3}
          bitrate={bitrate}
          onCancel={onCancelPreview}
          onConfirm={onConfirmSync}
        />
      )}
    </>
  )
}
