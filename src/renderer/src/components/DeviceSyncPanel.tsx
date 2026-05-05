import { useEffect, useState } from 'react'
import { HardDrive, Folder, Loader2, Trash2, Music, RefreshCw, X, AlertCircle } from 'lucide-react'
import type { Artist, Album, Playlist, Bitrate, SyncProgressInfo, PreviewData } from '../appTypes'
import type { SyncedItemInfo } from '../hooks/useDeviceSelections'
import { SyncPreviewModal } from './SyncPreviewModal'
import { SyncProgressBar } from './SyncProgressBar'
import { RemoveFolderModal } from './RemoveFolderModal'
import { formatBytes } from '../utils/format'

interface DeviceInfoCache {
  info: DeviceInfo
  fs: string
  timestamp: number
}
const deviceInfoCache = new Map<string, DeviceInfoCache>()
const DEVICE_INFO_CACHE_TTL_MS = 60_000

interface DeviceInfo {
  total: number
  free: number
  used: number
}

type ItemState = 'new' | 'synced' | 'outOfSync' | 'remove'

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
  isActivatingDevice: boolean
  syncProgress: SyncProgressInfo | null
  selectedTracks: Set<string>
  syncedItemsInfo: SyncedItemInfo[]
  outOfSyncItems: Set<string>
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
  showPreview: boolean
  previewData: PreviewData | null
  syncedMusicBytes?: number
  estimatedSizeBytes?: number | null
  isLoadingSize?: boolean
  onToggleItem: (id: string) => void
  onToggleConvert: () => void
  onBitrateChange: (b: Bitrate) => void
  onStartSync: () => void
  onCancelSync: () => void
  onCancelPreview: () => void
  onConfirmSync: () => void
  onRemoveDestination?: (deleteFiles: boolean) => void
}

const STATE_COLOR: Record<ItemState, string> = {
  new: 'bg-primary_container',
  synced: 'bg-success',
  outOfSync: 'bg-warning',
  remove: 'bg-error',
}

const STATE_TEXT: Record<ItemState, string> = {
  new: 'text-primary',
  synced: 'text-success',
  outOfSync: 'text-warning',
  remove: 'text-error',
}

export function DeviceSyncPanel({
  destinationPath,
  destinationName,
  isUsbDevice,
  isSaved,
  convertToMp3,
  bitrate,
  isSyncing,
  isActivatingDevice,
  syncProgress,
  selectedTracks,
  syncedItemsInfo,
  outOfSyncItems,
  artists,
  albums,
  playlists,
  showPreview,
  previewData,
  syncedMusicBytes,
  estimatedSizeBytes,
  isLoadingSize,
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
  const [showRemoveModal, setShowRemoveModal] = useState(false)
  const [filesystemType, setFilesystemType] = useState<string>('unknown')

  useEffect(() => {
    setDeviceInfo(null)
    setLoadingInfo(true)
    setFilesystemType('unknown')
    const cacheKey = destinationPath
    const cached = deviceInfoCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < DEVICE_INFO_CACHE_TTL_MS) {
      setDeviceInfo(cached.info)
      setFilesystemType(cached.fs)
      setLoadingInfo(false)
      return
    }
    Promise.all([
      window.api.getDeviceInfo(destinationPath).catch(() => null),
      window.api.getFilesystem(destinationPath).catch(() => 'unknown'),
    ]).then(([info, fs]) => {
      if (info?.total) {
        setDeviceInfo(info)
        deviceInfoCache.set(cacheKey, { info, fs: fs ?? 'unknown', timestamp: Date.now() })
      }
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
    if (outOfSyncItems.has(item.id)) {
      // Out of sync items can be re-tagged without re-download
      syncItems.push({ id: item.id, name: item.name, type: item.type, state: selected ? 'outOfSync' : 'remove' })
    } else {
      syncItems.push({ id: item.id, name: item.name, type: item.type, state: selected ? 'synced' : 'remove' })
    }
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
    ['outOfSync', 'Out of sync'],
    ['remove', 'Will remove'],
  ]

  const audioBytes = estimatedSizeBytes ?? syncedMusicBytes ?? 0
  const otherFiles = deviceInfo ? Math.max(0, deviceInfo.used - (syncedMusicBytes ?? 0)) : null
  const otherPct = deviceInfo ? Math.round(((otherFiles ?? 0) / deviceInfo.total) * 100) : null
  // rawAudioPct is the true proportion — no cap so overflow is detectable
  const rawAudioPct = deviceInfo && audioBytes > 0 ? Math.round((audioBytes / deviceInfo.total) * 100) : null
  // Always show at least 1% so the bar is visible even when synced content is tiny
  const audioPct = rawAudioPct !== null ? Math.max(rawAudioPct, 1) : null
  const isOverCapacity = deviceInfo != null && (otherPct ?? 0) + (rawAudioPct ?? 0) > 100
  // free segment width is clamped to 0 when projected usage exceeds capacity
  const freeBarPct = Math.max(0, 100 - (otherPct ?? 0) - (rawAudioPct ?? 0))
  // projected free bytes after sync replaces the current synced audio
  const projectedFreeBytes = deviceInfo ? Math.max(0, deviceInfo.total - (otherFiles ?? 0) - audioBytes) : null
  const freeColorClass = isOverCapacity || freeBarPct < 5
    ? 'bg-error'
    : freeBarPct < 10
      ? 'bg-warning'
      : 'bg-success'
  const isAudioLoading = !!isLoadingSize
  const audioDisplayBytes = estimatedSizeBytes ?? syncedMusicBytes
  const Icon = isUsbDevice ? HardDrive : Folder
  const isFat32 = filesystemType === 'fat32'
  const fsLabel: Record<string, string> = {
    fat32: 'FAT32', exfat: 'exFAT', ntfs: 'NTFS', apfs: 'APFS', 'hfs+': 'HFS+', ext4: 'ext4',
  }

  return (
    <div className="flex flex-col h-full w-full">
      {/* ── Centering wrapper — max-width + centering ─ */}
      <div className="flex flex-col flex-1 min-h-0 w-full max-w-2xl mx-auto px-6">
      {/* ── Scrollable content ─────────────────────── */}
      <div
        data-testid="sync-panel"
        className={`flex-1 overflow-auto pt-6${isSyncing ? ' pointer-events-none select-none' : ''}`}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 bg-surface_container_low rounded-xl flex items-center justify-center flex-shrink-0">
              <Icon className="w-6 h-6 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-headline-md">{destinationName}</h2>
                {filesystemType !== 'unknown' && (
                  <span className={`text-label-sm px-2 py-0.5 rounded-full font-semibold ${isFat32 ? 'bg-warning_container text-warning border border-warning/30' : 'bg-surface_container_low text-on_surface_variant border border-outline_variant'}`}>
                    {fsLabel[filesystemType] ?? filesystemType.toUpperCase()}
                  </span>
                )}
              </div>
              <p className="text-mono-sm text-on_surface_variant mt-0.5 truncate">{destinationPath}</p>
            </div>
          </div>
          {isSaved && onRemoveDestination && !isSyncing && (
            <button
              onClick={() => setShowRemoveModal(true)}
              className="p-2 text-on_surface_variant/60 hover:text-error hover:bg-error_container rounded-lg transition-colors"
              title="Remove folder"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>


        {showRemoveModal && (
          <RemoveFolderModal
            name={destinationName}
            path={destinationPath}
            onCancel={() => setShowRemoveModal(false)}
            onConfirm={deleteFiles => {
              setShowRemoveModal(false)
              onRemoveDestination?.(deleteFiles)
            }}
          />
        )}

        {/* Space bar */}
        {loadingInfo || isActivatingDevice ? (
          <div className="bg-surface_container_low rounded-xl p-4 border border-outline_variant mb-4">
            <div className="flex justify-between mb-2">
              <span className="text-label-md uppercase">Storage</span>
              <div className="h-4 bg-surface_container_highest rounded w-32 animate-pulse mt-0.5" />
            </div>
            <div className="w-full bg-surface_container_highest rounded-full h-2 animate-pulse overflow-hidden flex" />
            <div className="h-4 bg-surface_container_highest rounded w-40 mt-1.5 animate-pulse" />
          </div>
        ) : deviceInfo ? (
          <div data-testid="storage-bar" className="bg-surface_container_low rounded-xl p-4 border border-outline_variant mb-4">
            <div className="flex justify-between text-body-md mb-2">
              <span className="text-label-md uppercase">Storage</span>
              <span className="text-body-sm text-on_surface" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatBytes(deviceInfo.total)} total</span>
            </div>
            <div className="w-full bg-surface_container_highest rounded-full h-2 overflow-hidden flex">
              {/* Other used segment — de-emphasised, least important */}
              <div
                className="h-2 bg-secondary_container transition-all"
                style={{ width: `${otherPct ?? 0}%` }}
              />
              {/* Audio segment — brand purple, most important; capped visually but overflow detected via isOverCapacity */}
              {audioPct != null && audioPct > 0 && (
                <div
                  className="h-2 bg-primary_container transition-all"
                  style={{ width: `${Math.min(audioPct, 100 - (otherPct ?? 0))}%` }}
                />
              )}
              {/* Free segment — color shifts to warning/error when space is low or over capacity */}
              <div
                className={`h-2 ${freeColorClass} transition-all`}
                style={{ width: `${freeBarPct}%` }}
              />
            </div>
            <div className="flex items-center gap-3 text-body-sm text-on_surface_variant mt-1.5" style={{ fontVariantNumeric: 'tabular-nums' }}>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm bg-secondary_container" />
                {otherFiles != null ? formatBytes(otherFiles) : '—'} Other
              </span>
              <span className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded-sm bg-primary_container${isAudioLoading ? ' animate-sizeSquarePulse' : ''}`} />
                <span className={isAudioLoading ? 'opacity-40' : ''}>
                  {audioDisplayBytes != null
                    ? `${convertToMp3 ? '~' : ''}${formatBytes(audioDisplayBytes)}`
                    : (isAudioLoading ? '—' : '0 B')} Audio{convertToMp3 && audioDisplayBytes != null ? ' (estimated)' : ''}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded-sm ${freeColorClass}`} />
                {isOverCapacity
                  ? <span className="text-error">Over capacity</span>
                  : <>{projectedFreeBytes != null ? formatBytes(projectedFreeBytes) : formatBytes(deviceInfo.free)} Free</>
                }
              </span>
            </div>
          </div>
        ) : (
          <div className="bg-surface_container_low rounded-xl p-4 border border-outline_variant mb-4 min-h-[6rem]" />
        )}

        {/* Sync items — grouped, each toggleable */}
        <div className="bg-surface_container_low rounded-xl border border-outline_variant mb-4 overflow-hidden">
          {syncItems.length === 0 ? (
            <div className="p-6 text-center text-on_surface_variant text-body-md">
              <Music className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p>No items selected</p>
              <p className="text-caption mt-1 text-on_surface_variant/60">Select artists, albums or playlists from the library</p>
            </div>
          ) : (
            <div className="divide-y divide-outline_variant/30 max-h-60 overflow-y-auto">
              {groups.map(([state, label]) => {
                const items = syncItems.filter(i => i.state === state)
                if (items.length === 0) return null
                return (
                  <div key={state} className="p-4">
                    <p className={`text-label-md uppercase mb-2 flex items-center gap-1.5 ${STATE_TEXT[state]}`}>
                      {state === 'new' && <RefreshCw className="w-3 h-3" />}
                      {state === 'outOfSync' && <RefreshCw className="w-3 h-3" />}
                      {state === 'remove' && <X className="w-3 h-3" />}
                      {label} · {items.length}
                    </p>
                    <div className="space-y-1">
                      {items.map(item => (
                        <button
                          key={item.id}
                          onClick={() => !isSyncing && onToggleItem(item.id)}
                          disabled={isSyncing}
                          className="w-full flex items-center gap-2 text-body-md py-1 px-2 rounded hover:bg-surface_container_high disabled:hover:bg-transparent disabled:cursor-default transition-colors text-left group"
                        >
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATE_COLOR[item.state]}`} />
                          <span className={`flex-1 truncate ${item.state === 'remove' ? 'line-through opacity-50' : ''}`}>
                            {item.name}
                          </span>
                          <span className="text-label-sm text-on_surface_variant flex-shrink-0">{item.type}</span>
                          <span className="text-label-sm text-on_surface_variant opacity-0 group-hover:opacity-100 flex-shrink-0">
                            {item.state === 'remove' ? 'undo' : 'remove'}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p className="text-label-sm text-on_surface_variant/60 mt-2 px-2">
                      {state === 'new' && 'Click an item to remove it from this sync'}
                      {state === 'synced' && 'Click an item to remove it from device'}
                      {state === 'outOfSync' && 'Click to remove from device (re-tag only if re-added)'}
                      {state === 'remove' && 'Click an item to keep it on device'}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Convert to MP3 */}
        <div className="bg-surface_container_low rounded-xl p-4 border border-outline_variant mb-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-body-md font-medium">Convert to MP3</span>
              <p className="text-caption text-on_surface_variant mt-0.5">
                {convertToMp3 ? `FLAC/lossless + MP3 above ${bitrate} → MP3 ${bitrate}` : 'Copy files as-is'}
              </p>
            </div>
            <button
              data-testid="mp3-toggle"
              onClick={onToggleConvert}
              disabled={isSyncing}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-default ${convertToMp3 ? 'bg-primary_container' : 'bg-surface_container_highest'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${convertToMp3 ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          {convertToMp3 && (
            <div className="flex items-center gap-2 mt-3">
              <span className="text-label-sm text-on_surface_variant">Bitrate:</span>
              {(['128k', '192k', '320k'] as const).map(b => (
                <button
                  key={b}
                  onClick={() => onBitrateChange(b)}
                  disabled={isSyncing}
                  className={`px-2.5 py-1 text-label-sm rounded-lg disabled:cursor-default disabled:opacity-50 ${bitrate === b ? 'bg-primary_container text-on_primary_container' : 'bg-surface_container_highest text-on_surface hover:bg-surface_bright'}`}
                >
                  {b}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Centering wrapper close ─────────────── */}
      </div>

      {/* ── Sticky footer — full-width border, centered content ── */}
      {!isSyncing && (
        <div className="flex-shrink-0 border-t border-outline_variant">
          <div className="max-w-2xl mx-auto px-6 pt-6 pb-6">
            <button
              data-testid="sync-button"
              onClick={onStartSync}
              disabled={isActivatingDevice || isLoadingSize || syncItems.length === 0}
              className="w-full bg-gradient-primary hover:bg-secondary_container disabled:bg-surface_container_highest disabled:text-on_surface_variant py-3 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
            >
              {isActivatingDevice || isLoadingSize ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Calculating sync state…</>
              ) : (
                `Sync to ${destinationName}`
              )}
            </button>
          </div>
        </div>
      )}

      {(isSyncing || syncProgress) && (
        <div className="flex-shrink-0 border-t border-outline_variant">
          <div className={`max-w-2xl mx-auto px-6 pt-6 pb-6${isSyncing ? ' pointer-events-none' : ''}`}>
            {syncProgress && (
              <div className="mb-4">
                <SyncProgressBar syncProgress={syncProgress} />
              </div>
            )}
            {syncProgress?.warning && (
              <div className="mb-4 flex items-center gap-2 px-4 py-3 rounded-xl bg-warning/20 border border-warning text-warning text-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>Cover art unavailable — some tracks may be missing album artwork</span>
              </div>
            )}
            {isSyncing && (
              <div className="pointer-events-auto">
                <button
                  data-testid="cancel-sync-button"
                  onClick={onCancelSync}
                  className="w-full bg-error hover:bg-error/80 text-on_error py-3 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
                >
                  <X className="w-4 h-4" /> Cancel Sync
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showPreview && previewData && (
        <SyncPreviewModal
          data={previewData}
          convertToMp3={convertToMp3}
          bitrate={bitrate}
          onCancel={onCancelPreview}
          onConfirm={onConfirmSync}
        />
      )}
    </div>
  )
}
