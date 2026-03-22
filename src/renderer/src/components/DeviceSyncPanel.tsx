import { useEffect, useState } from 'react'
import { HardDrive, Folder, Loader2, Trash2, Music, RefreshCw, X } from 'lucide-react'
import type { Artist, Album, Playlist, Bitrate, SyncProgressInfo, PreviewData } from '../appTypes'
import type { SyncedItemInfo } from '../hooks/useDeviceSelections'
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

type ItemState = 'new' | 'synced' | 'remove'

interface SyncItem {
  id: string
  name: string
  type: 'artist' | 'album' | 'playlist'
  state: ItemState
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
  syncedItemsInfo: SyncedItemInfo[]
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
  showPreview: boolean
  previewData: PreviewData | null
  onToggleItem: (id: string) => void
  onToggleConvert: () => void
  onBitrateChange: (b: Bitrate) => void
  onStartSync: () => void
  onCancelSync: () => void
  onCancelPreview: () => void
  onConfirmSync: () => void
  onRemoveDestination?: () => void
}

const STATE_LABEL: Record<ItemState, string> = {
  new: 'New',
  synced: 'Synced',
  remove: 'Will remove',
}

const STATE_COLOR: Record<ItemState, string> = {
  new: 'bg-jf-cyan',
  synced: 'bg-green-400',
  remove: 'bg-red-400',
}

const STATE_TEXT: Record<ItemState, string> = {
  new: 'text-jf-cyan',
  synced: 'text-green-400',
  remove: 'text-red-400',
}

function ConfirmRemove({ name, onConfirm, onCancel }: { name: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 p-2 bg-red-900/20 border border-red-800/50 rounded-lg text-sm">
      <span className="text-red-300 flex-1">Remove <strong>{name}</strong> from destinations?</span>
      <button onClick={onCancel} className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded transition-colors">Cancel</button>
      <button onClick={onConfirm} className="px-2 py-1 text-xs bg-red-700 hover:bg-red-600 text-white rounded transition-colors">Remove</button>
    </div>
  )
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
  syncedItemsInfo,
  artists,
  albums,
  playlists,
  showPreview,
  previewData,
  onToggleItem,
  onToggleConvert,
  onBitrateChange,
  onStartSync,
  onCancelSync,
  onCancelPreview,
  onConfirmSync,
  onRemoveDestination,
}: DeviceSyncPanelProps): JSX.Element {
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null)
  const [loadingInfo, setLoadingInfo] = useState(true)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [filesystemType, setFilesystemType] = useState<string>('unknown')

  useEffect(() => {
    setDeviceInfo(null)
    setLoadingInfo(true)
    setFilesystemType('unknown')
    Promise.all([
      window.api.getDeviceInfo(destinationPath).catch(() => null),
      window.api.getFilesystem(destinationPath).catch(() => 'unknown'),
    ]).then(([info, fs]) => {
      if (info?.total) setDeviceInfo(info)
      setFilesystemType(fs ?? 'unknown')
    }).finally(() => setLoadingInfo(false))
  }, [destinationPath])

  // Build sync item list
  // Synced items come from DB (available even if not loaded in library)
  const syncedIds = new Set(syncedItemsInfo.map(i => i.id))
  const syncItems: SyncItem[] = []

  // Synced/remove: iterate DB records — always available regardless of library state
  for (const item of syncedItemsInfo) {
    const selected = selectedTracks.has(item.id)
    syncItems.push({ id: item.id, name: item.name, type: item.type, state: selected ? 'synced' : 'remove' })
  }

  // New: selected but not yet synced — only available if loaded from library
  const addNewItems = <T extends { Id: string; Name: string }>(items: T[], type: SyncItem['type']) => {
    for (const item of items) {
      if (selectedTracks.has(item.Id) && !syncedIds.has(item.Id)) {
        syncItems.push({ id: item.Id, name: item.Name, type, state: 'new' })
      }
    }
  }
  addNewItems(artists, 'artist')
  addNewItems(albums, 'album')
  addNewItems(playlists, 'playlist')

  const groups: [ItemState, string][] = [
    ['new', 'New'],
    ['synced', 'On device'],
    ['remove', 'Will remove'],
  ]

  const usedPct = deviceInfo ? Math.round((deviceInfo.used / deviceInfo.total) * 100) : null
  const Icon = isUsbDevice ? HardDrive : Folder
  const isFat32 = filesystemType === 'fat32'
  const isExFat = filesystemType === 'exfat'
  const fsLabel: Record<string, string> = {
    fat32: 'FAT32', exfat: 'exFAT', ntfs: 'NTFS', apfs: 'APFS', 'hfs+': 'HFS+', ext4: 'ext4',
  }

  return (
    <>
      <div data-testid="sync-panel" className="flex-1 overflow-auto p-6 max-w-2xl">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-jf-bg-mid rounded-xl flex items-center justify-center">
              <Icon className="w-6 h-6 text-jf-cyan" />
            </div>
            <div>
              <h2 className="text-xl font-semibold">{destinationName}</h2>
              <p className="text-xs text-zinc-500 font-mono mt-0.5">{destinationPath}</p>
            </div>
          </div>
          {isSaved && onRemoveDestination && !confirmingRemove && !isSyncing && (
            <button
              onClick={() => setConfirmingRemove(true)}
              className="p-2 text-zinc-600 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
              title="Remove destination"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Filesystem badge */}
        {filesystemType !== 'unknown' && (
          <div className={`flex items-center gap-2 mb-4 px-3 py-2 rounded-lg text-xs ${isFat32 ? 'bg-yellow-900/30 border border-yellow-700/40 text-yellow-300' : 'bg-jf-bg-mid border border-jf-border text-zinc-500'}`}>
            <span className={`font-mono font-semibold ${isFat32 ? 'text-yellow-400' : ''}`}>{fsLabel[filesystemType] ?? filesystemType.toUpperCase()}</span>
            {isFat32 && <span>· Filenames will be sanitized for FAT32 compatibility (trailing dots/spaces removed, reserved names prefixed)</span>}
            {isExFat && <span>· exFAT — no file size limit, compatible with most devices</span>}
          </div>
        )}

        {/* Confirm remove */}
        {confirmingRemove && (
          <div className="mb-4">
            <ConfirmRemove
              name={destinationName}
              onConfirm={() => { setConfirmingRemove(false); onRemoveDestination?.() }}
              onCancel={() => setConfirmingRemove(false)}
            />
          </div>
        )}

        {/* Space bar */}
        {loadingInfo ? (
          <div className="bg-jf-bg-mid rounded-xl p-4 border border-jf-border mb-4 h-16 animate-pulse" />
        ) : deviceInfo ? (
          <div data-testid="storage-bar" className="bg-jf-bg-mid rounded-xl p-4 border border-jf-border mb-4">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-zinc-400">Storage</span>
              <span className="text-zinc-300">{formatBytes(deviceInfo.free)} free of {formatBytes(deviceInfo.total)}</span>
            </div>
            <div className="w-full bg-[#2a3a4d] rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all ${usedPct! > 90 ? 'bg-red-500' : usedPct! > 70 ? 'bg-yellow-500' : 'bg-jf-purple'}`}
                style={{ width: `${usedPct}%` }}
              />
            </div>
          </div>
        ) : null}

        {/* Sync items — grouped, each toggleable */}
        <div className="bg-jf-bg-mid rounded-xl border border-jf-border mb-4 overflow-hidden">
          {syncItems.length === 0 ? (
            <div className="p-6 text-center text-zinc-500 text-sm">
              <Music className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p>No items selected</p>
              <p className="text-xs mt-1 text-zinc-600">Select artists, albums or playlists from the library</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-800 max-h-60 overflow-y-auto">
              {groups.map(([state, label]) => {
                const items = syncItems.filter(i => i.state === state)
                if (items.length === 0) return null
                return (
                  <div key={state} className="p-4">
                    <p className={`text-xs font-medium uppercase tracking-wider mb-2 flex items-center gap-1.5 ${STATE_TEXT[state]}`}>
                      {state === 'new' && <RefreshCw className="w-3 h-3" />}
                      {state === 'remove' && <X className="w-3 h-3" />}
                      {label} · {items.length}
                    </p>
                    <div className="space-y-1">
                      {items.map(item => (
                        <button
                          key={item.id}
                          onClick={() => !isSyncing && onToggleItem(item.id)}
                          disabled={isSyncing}
                          className="w-full flex items-center gap-2 text-sm py-1 px-2 rounded hover:bg-zinc-800 disabled:hover:bg-transparent disabled:cursor-default transition-colors text-left group"
                        >
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATE_COLOR[item.state]}`} />
                          <span className={`flex-1 truncate ${item.state === 'remove' ? 'line-through opacity-50' : ''}`}>
                            {item.name}
                          </span>
                          <span className="text-xs text-zinc-600 flex-shrink-0">{item.type}</span>
                          <span className="text-xs text-zinc-600 opacity-0 group-hover:opacity-100 flex-shrink-0">
                            {item.state === 'remove' ? 'undo' : 'remove'}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-zinc-600 mt-2 px-2">
                      {state === 'new' && 'Click an item to remove it from this sync'}
                      {state === 'synced' && 'Click an item to remove it from device'}
                      {state === 'remove' && 'Click an item to keep it on device'}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Convert to MP3 */}
        <div className="bg-jf-bg-mid rounded-xl p-4 border border-jf-border mb-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium">Convert to MP3</span>
              <p className="text-xs text-zinc-500 mt-0.5">
                {convertToMp3 ? `FLAC/lossless → MP3 ${bitrate}` : 'Copy files as-is'}
              </p>
            </div>
            <button
              data-testid="mp3-toggle"
              onClick={onToggleConvert}
              disabled={isSyncing}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-default ${convertToMp3 ? 'bg-jf-purple' : 'bg-zinc-600'}`}
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
                  disabled={isSyncing}
                  className={`px-2.5 py-1 text-xs rounded-lg disabled:cursor-default disabled:opacity-50 ${bitrate === b ? 'bg-jf-purple text-white' : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'}`}
                >
                  {b}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Sync / Cancel button */}
        {isSyncing ? (
          <button
            data-testid="cancel-sync-button"
            onClick={onCancelSync}
            className="w-full bg-red-600 hover:bg-red-700 py-3 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
          >
            <X className="w-4 h-4" /> Cancel Sync
          </button>
        ) : (
          <button
            data-testid="sync-button"
            onClick={onStartSync}
            disabled={isLoadingPreview || syncItems.length === 0}
            className="w-full bg-jf-purple hover:bg-jf-purple-dark disabled:bg-zinc-700 disabled:text-zinc-500 py-3 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
          >
            {isLoadingPreview ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Calculating...</>
            ) : (
              `Sync to ${destinationName}`
            )}
          </button>
        )}

        {syncProgress && (
          <div className="mt-4 p-4 bg-jf-bg-mid rounded-xl border border-jf-border">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-zinc-400">Progress</span>
              <span>{syncProgress.current} / {syncProgress.total}</span>
            </div>
            <div data-testid="sync-progress-bar" className="w-full bg-[#2a3a4d] rounded-full h-1.5 mb-2">
              <div
                className="bg-jf-purple h-1.5 rounded-full transition-all"
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
