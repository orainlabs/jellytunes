import { useState } from 'react'
import type { JellyfinConfig, Artist, Album, Playlist, Bitrate, SyncProgressInfo, PreviewData } from '../appTypes'
import type { SyncedItemInfo } from './useDeviceSelections'
import { getTrackRegistry } from './useTrackRegistry'
import { logger } from '../utils/logger'

interface UseSyncOptions {
  jellyfinConfig: JellyfinConfig | null
  userId: string | null
  selectedTracks: Set<string>
  previouslySyncedItems: Set<string>
  syncedItemsInfo: SyncedItemInfo[]
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
  setPreviouslySyncedItems: (items: SyncedItemInfo[]) => void
  revalidateDevice: () => Promise<void>
}

export function useSync({
  jellyfinConfig,
  userId,
  selectedTracks,
  previouslySyncedItems,
  syncedItemsInfo,
  artists,
  albums,
  playlists,
  setPreviouslySyncedItems,
  revalidateDevice,
}: UseSyncOptions) {
  const registry = getTrackRegistry()
  const [syncFolder, setSyncFolder] = useState<string | null>(null)
  const [convertToMp3, setConvertToMp3] = useState(false)
  const [bitrate, setBitrate] = useState<Bitrate>('192k')
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<SyncProgressInfo | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [previewData, setPreviewData] = useState<PreviewData | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [syncSuccessData, setSyncSuccessData] = useState<{
    tracksCopied: number; tracksSkipped: number; tracksRetagged: number; removed: number; errors: string[]
  } | null>(null)

  const handleSelectSyncFolder = async (path?: string): Promise<void> => {
    if (path) {
      setSyncFolder(path)
      return
    }
    const folder = await window.api.selectFolder()
    if (folder) setSyncFolder(folder)
  }

  const buildItemTypesMap = () => {
    const artistIds = artists.filter(a => selectedTracks.has(a.Id)).map(a => a.Id)
    const albumIds = albums.filter(a => selectedTracks.has(a.Id)).map(a => a.Id)
    const playlistIds = playlists.filter(p => selectedTracks.has(p.Id)).map(p => p.Id)
    const map: Record<string, 'artist' | 'album' | 'playlist'> = {}
    const names: Record<string, string> = {}
    artistIds.forEach(id => { if (id) map[id] = 'artist' })
    albumIds.forEach(id => { if (id) map[id] = 'album' })
    playlistIds.forEach(id => { if (id) map[id] = 'playlist' })
    artists.filter(a => selectedTracks.has(a.Id)).forEach(a => { names[a.Id] = a.Name })
    albums.filter(a => selectedTracks.has(a.Id)).forEach(a => { names[a.Id] = a.Name })
    playlists.filter(p => selectedTracks.has(p.Id)).forEach(p => { names[p.Id] = p.Name })
    return { artistIds, albumIds, playlistIds, map, names }
  }

  // Items that are synced but user has deselected → will be removed from device
  const buildToDeleteIds = () => {
    return [...previouslySyncedItems].filter(id => !selectedTracks.has(id))
  }

  // Build a type map for items to delete, using in-memory arrays first then DB info as fallback
  const buildDeleteTypesMap = (toDeleteIds: string[]): Record<string, 'artist' | 'album' | 'playlist'> => {
    const syncedInfoMap = new Map(syncedItemsInfo.map(i => [i.id, i]))
    const map: Record<string, 'artist' | 'album' | 'playlist'> = {}
    toDeleteIds.forEach(id => {
      if (artists.find(a => a.Id === id)) map[id] = 'artist'
      else if (albums.find(a => a.Id === id)) map[id] = 'album'
      else if (playlists.find(p => p.Id === id)) map[id] = 'playlist'
      else if (syncedInfoMap.has(id)) map[id] = syncedInfoMap.get(id)!.type
    })
    return map
  }

  const executeSyncNow = async (): Promise<void> => {
    if (!syncFolder || !jellyfinConfig || !userId) return
    setShowPreview(false)
    setIsSyncing(true)
    setSyncProgress({ current: 0, total: 0, file: 'Validating...', phase: 'fetching' })

    const unsubscribe = window.api.onSyncProgress((progress) => {
      setSyncProgress(prev => prev ? {
        ...prev,
        current: progress.current,
        total: progress.total,
        file: progress.currentFile,
        phase: progress.phase,
        bytesProcessed: progress.bytesProcessed,
        totalBytes: progress.totalBytes,
        warning: progress.warning,
      } : null)
      // Clean isCancelling when sync ends
      if (progress.phase === 'complete' || progress.phase === 'error' || progress.phase === 'cancelled') {
        setSyncProgress(prev => prev ? { ...prev, isCancelling: false } : null)
      }
    })

    try {
      const { artistIds, albumIds, playlistIds, map, names } = buildItemTypesMap()
      const selectedIds = [...artistIds, ...albumIds, ...playlistIds].filter(Boolean)
      const toDeleteIds = buildToDeleteIds()

      if (toDeleteIds.length > 0) {
        setSyncProgress({ current: 0, total: 0, file: 'Removing deselected items...', phase: 'fetching' })
        const deleteTypesMap = buildDeleteTypesMap(toDeleteIds)
        await window.api.removeItems({
          serverUrl: jellyfinConfig.url,
          apiKey: jellyfinConfig.apiKey,
          userId,
          itemIds: toDeleteIds,
          itemTypes: deleteTypesMap,
          destinationPath: syncFolder,
        })
      }

      // Delete-only operation: nothing left to sync
      if (selectedIds.length === 0) {
        unsubscribe?.()
        setSyncProgress(null)
        setIsSyncing(false)
        const updatedItems = await window.api.getSyncedItems(syncFolder)
        setPreviouslySyncedItems(updatedItems)
        alert(`Sync complete!\n\nRemoved: ${toDeleteIds.length} item(s)\nNothing left to sync.`)
        return
      }

      const result = await window.api.startSync2({
        serverUrl: jellyfinConfig.url,
        apiKey: jellyfinConfig.apiKey,
        userId,
        itemIds: selectedIds,
        itemTypes: map,
        itemNames: names,
        destinationPath: syncFolder,
        options: { convertToMp3, bitrate },
      })

      unsubscribe?.()
      setSyncProgress(null)
      setIsSyncing(false)

      if (result.success) {
        const updatedItems = await window.api.getSyncedItems(syncFolder)
        setPreviouslySyncedItems(updatedItems)
        setSyncSuccessData({
          tracksCopied: result.tracksCopied,
          tracksSkipped: result.tracksSkipped ?? 0,
          tracksRetagged: result.tracksRetagged ?? 0,
          removed: toDeleteIds.length,
          errors: result.errors,
        })
        // Re-run analyzeDiff in background to update out-of-sync indicators
        revalidateDevice()
      } else {
        setSyncSuccessData({ tracksCopied: 0, tracksSkipped: 0, tracksRetagged: 0, removed: 0, errors: result.errors })
      }
    } catch (error) {
      unsubscribe?.()
      logger.error('Sync error: ' + (error instanceof Error ? error.message : String(error)))
      setSyncProgress(null)
      setIsSyncing(false)
      alert('Sync error: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  const handleStartSync = async (): Promise<void> => {
    if (!syncFolder) { alert('Please select a sync destination folder first'); return }
    if (!jellyfinConfig || !userId) { alert('Not connected to Jellyfin'); return }

    const toDeleteIds = buildToDeleteIds()
    if (selectedTracks.size === 0 && toDeleteIds.length === 0) {
      alert('Please select at least one item to sync')
      return
    }

    // Delete-only: skip estimate and go straight to sync
    if (selectedTracks.size === 0) {
      executeSyncNow()
      return
    }

    const { artistIds, albumIds, playlistIds, map } = buildItemTypesMap()
    const selectedIds = [...artistIds, ...albumIds, ...playlistIds].filter(Boolean)

    // Ensure tracks are loaded for all selected items before computing preview.
    // Items toggled from library view may not have had ensureItemTracks called yet
    // (lastOpts.itemTypes didn't include them at toggle time → 0 tracks in registry).
    const toFetch = [...selectedTracks].filter(id => map[id] && registry.getItemTrackIds(id).length === 0)
    if (toFetch.length > 0) {
      setIsLoadingPreview(true)
      try {
        await Promise.all(
          toFetch.map(id => registry.ensureItemTracks(id, map[id], {
            serverUrl: jellyfinConfig.url,
            apiKey: jellyfinConfig.apiKey,
            userId,
          }))
        )
      } catch { /* show modal with available data on error */ } finally {
        setIsLoadingPreview(false)
      }
    }

    // Use registry for instant size calculation (no network call)
    const totalBytes = registry.calculateSize(selectedTracks, syncFolder, convertToMp3, bitrate) ?? 0
    const newTrackCount = registry.countNewTracks(selectedTracks, syncFolder)
    const willRemoveCount = toDeleteIds.length

    // Call analyzeDiff for accurate breakdown of new/updated/removed tracks
    // items that are already synced will be analyzed for changes
    let newTracksCount = newTrackCount
    let newTracksBytes = totalBytes
    let updatedTracksCount = 0
    let updatedTracksBytes = 0
    let willRemoveBytes = 0

    if (selectedIds.length > 0 && jellyfinConfig) {
      try {
        const diffResult = await window.api.analyzeDiff({
          serverUrl: jellyfinConfig.url,
          apiKey: jellyfinConfig.apiKey,
          userId,
          itemIds: selectedIds,
          itemTypes: map,
          destinationPath: syncFolder,
          options: { convertToMp3, bitrate, coverArtMode: 'embed' },
        })
        if (diffResult.success) {
          const { newTracks, metadataChanged } = diffResult.totals
          updatedTracksCount = metadataChanged
          newTracksCount = newTracks
          // Estimate bytes proportionally using track count ratio
          if (newTrackCount > 0 && newTracks > 0) {
            newTracksBytes = Math.round(totalBytes * (newTracks / (newTracks + metadataChanged)))
            updatedTracksBytes = totalBytes - newTracksBytes
          }
          // Remove bytes from items being deleted — use registry to compute
          if (willRemoveCount > 0) {
            let removeBytes = 0
            for (const id of toDeleteIds) {
              const trackIds = registry.getItemTrackIds(id)
              for (const tid of trackIds) {
                const synced = (registry as { deviceSyncedTracks?: Map<string, Map<string, { fileSize: number; itemId: string }>> }).deviceSyncedTracks?.get(syncFolder)?.get(tid)
                if (synced) removeBytes += synced.fileSize
              }
            }
            willRemoveBytes = removeBytes
          }
        }
      } catch { /* ignore diff errors, use registry estimates */ }
    }

    setPreviewData({
      trackCount: newTracksCount + updatedTracksCount,
      totalBytes: newTracksBytes + updatedTracksBytes,
      formatBreakdown: {},
      newTracksCount,
      newTracksBytes,
      updatedTracksCount,
      updatedTracksBytes,
      willRemoveCount,
      willRemoveBytes,
    })
    setShowPreview(true)
  }

  const handleCancelSync = async (): Promise<void> => {
    setSyncProgress(prev => prev ? { ...prev, isCancelling: true } : null)
    try {
      await window.api.cancelSync()
    } catch (error) {
      logger.error('Cancel sync error: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  return {
    syncFolder,
    setSyncFolder,
    convertToMp3,
    setConvertToMp3,
    bitrate,
    setBitrate,
    isSyncing,
    syncProgress,
    showPreview,
    setShowPreview,
    previewData,
    isLoadingPreview,
    syncSuccessData,
    setSyncSuccessData,
    handleSelectSyncFolder,
    executeSyncNow,
    handleStartSync,
    handleCancelSync,
  }
}
