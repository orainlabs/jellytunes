import { useState } from 'react'
import type { JellyfinConfig, Artist, Album, Playlist, Bitrate, SyncProgressInfo, PreviewData } from '../appTypes'
import type { SyncedItemInfo } from './useDeviceSelections'
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
}: UseSyncOptions) {
  const [syncFolder, setSyncFolder] = useState<string | null>(null)
  const [convertToMp3, setConvertToMp3] = useState(false)
  const [bitrate, setBitrate] = useState<Bitrate>('192k')
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<SyncProgressInfo | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [previewData, setPreviewData] = useState<PreviewData | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)

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
    setSyncProgress({ current: 0, total: 0, file: 'Validating...' })

    const unsubscribe = window.api.onSyncProgress((progress) => {
      setSyncProgress({ current: progress.current, total: progress.total, file: progress.currentFile })
    })

    try {
      const { artistIds, albumIds, playlistIds, map, names } = buildItemTypesMap()
      const selectedIds = [...artistIds, ...albumIds, ...playlistIds].filter(Boolean)
      const toDeleteIds = buildToDeleteIds()

      if (toDeleteIds.length > 0) {
        setSyncProgress({ current: 0, total: 0, file: 'Removing deselected items...' })
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
        const deleteInfo = toDeleteIds.length > 0 ? `\nRemoved: ${toDeleteIds.length} item(s)` : ''
        const skippedInfo = result.tracksSkipped > 0 ? `\nSkipped (already up-to-date): ${result.tracksSkipped}` : ''
        alert(`Sync complete!\n\nTracks copied: ${result.tracksCopied}${skippedInfo}${deleteInfo}\nErrors: ${result.errors.length}\n\n${result.errors.length > 0 ? 'Errors:\n' + result.errors.slice(0, 5).join('\n') : ''}`)
      } else {
        alert(`Sync failed:\n\n${result.errors.join('\n')}`)
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

    setIsLoadingPreview(true)
    try {
      const { artistIds, albumIds, playlistIds, map } = buildItemTypesMap()
      const selectedIds = [...artistIds, ...albumIds, ...playlistIds].filter(Boolean)

      const [estimate, syncedItems] = await Promise.all([
        window.api.estimateSize({ serverUrl: jellyfinConfig.url, apiKey: jellyfinConfig.apiKey, userId, itemIds: selectedIds, itemTypes: map }),
        window.api.getSyncedItems(syncFolder),
      ])
      const syncedIdSet = new Set(syncedItems.map(i => i.id))
      const alreadySyncedCount = selectedIds.filter(id => syncedIdSet.has(id)).length
      const willRemoveCount = [...previouslySyncedItems].filter(id => !selectedTracks.has(id)).length
      setPreviewData({ ...estimate, alreadySyncedCount, willRemoveCount })
      setShowPreview(true)
    } catch (err) {
      logger.warn('Size estimation failed, proceeding without preview: ' + (err instanceof Error ? err.message : String(err)))
      executeSyncNow()
    } finally {
      setIsLoadingPreview(false)
    }
  }

  const handleCancelSync = async (): Promise<void> => {
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
    handleSelectSyncFolder,
    executeSyncNow,
    handleStartSync,
    handleCancelSync,
  }
}
