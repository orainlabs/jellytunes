import { useState } from 'react'
import type { JellyfinConfig, Artist, Album, Playlist, Bitrate, SyncProgressInfo, PreviewData, ItemTypeIndex } from '../appTypes'

interface UseSyncOptions {
  jellyfinConfig: JellyfinConfig | null
  userId: string | null
  selectedTracks: Set<string>
  previouslySyncedItems: Set<string>
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
  itemTypeIndexRef: React.MutableRefObject<ItemTypeIndex>
  setPreviouslySyncedItems: (items: Set<string>) => void
}

export function useSync({
  jellyfinConfig,
  userId,
  selectedTracks,
  previouslySyncedItems,
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

  const handleSelectSyncFolder = async (): Promise<void> => {
    const folder = await window.api.selectFolder()
    if (folder) setSyncFolder(folder)
  }

  const buildItemTypesMap = () => {
    const artistIds = artists.filter(a => selectedTracks.has(a.Id)).map(a => a.Id)
    const albumIds = albums.filter(a => selectedTracks.has(a.Id)).map(a => a.Id)
    const playlistIds = playlists.filter(p => selectedTracks.has(p.Id)).map(p => p.Id)
    const map: Record<string, 'artist' | 'album' | 'playlist'> = {}
    artistIds.forEach(id => { if (id) map[id] = 'artist' })
    albumIds.forEach(id => { if (id) map[id] = 'album' })
    playlistIds.forEach(id => { if (id) map[id] = 'playlist' })
    return { artistIds, albumIds, playlistIds, map }
  }

  const buildToDeleteIds = () => {
    const visibleIds = new Set([
      ...artists.map(a => a.Id),
      ...albums.map(a => a.Id),
      ...playlists.map(p => p.Id),
    ])
    return [...previouslySyncedItems].filter(id => visibleIds.has(id) && !selectedTracks.has(id))
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
      const { artistIds, albumIds, playlistIds, map } = buildItemTypesMap()
      const selectedIds = [...artistIds, ...albumIds, ...playlistIds].filter(Boolean)
      const toDeleteIds = buildToDeleteIds()

      if (toDeleteIds.length > 0) {
        setSyncProgress({ current: 0, total: 0, file: 'Removing deselected items...' })
        const deleteTypesMap: Record<string, 'artist' | 'album' | 'playlist'> = {}
        toDeleteIds.forEach(id => {
          if (artists.find(a => a.Id === id)) deleteTypesMap[id] = 'artist'
          else if (albums.find(a => a.Id === id)) deleteTypesMap[id] = 'album'
          else if (playlists.find(p => p.Id === id)) deleteTypesMap[id] = 'playlist'
        })
        await window.api.removeItems({
          serverUrl: jellyfinConfig.url,
          apiKey: jellyfinConfig.apiKey,
          userId,
          itemIds: toDeleteIds,
          itemTypes: deleteTypesMap,
          destinationPath: syncFolder,
        })
      }

      const result = await window.api.startSync2({
        serverUrl: jellyfinConfig.url,
        apiKey: jellyfinConfig.apiKey,
        userId,
        itemIds: selectedIds,
        itemTypes: map,
        destinationPath: syncFolder,
        options: { convertToMp3, bitrate },
      })

      unsubscribe?.()
      setSyncProgress(null)
      setIsSyncing(false)

      if (result.success) {
        const updatedIds = await window.api.getSyncedItems(syncFolder)
        setPreviouslySyncedItems(new Set(updatedIds))
        const deleteInfo = toDeleteIds.length > 0 ? `\nRemoved: ${toDeleteIds.length} item(s)` : ''
        alert(`Sync complete!\n\nTracks copied: ${result.tracksCopied}${deleteInfo}\nErrors: ${result.errors.length}\n\n${result.errors.length > 0 ? 'Errors:\n' + result.errors.slice(0, 5).join('\n') : ''}`)
      } else {
        alert(`Sync failed:\n\n${result.errors.join('\n')}`)
      }
    } catch (error) {
      unsubscribe?.()
      console.error('Sync error:', error)
      setSyncProgress(null)
      setIsSyncing(false)
      alert('Sync error: ' + error)
    }
  }

  const handleStartSync = async (): Promise<void> => {
    if (!syncFolder) { alert('Please select a sync destination folder first'); return }
    if (selectedTracks.size === 0) { alert('Please select at least one item to sync'); return }
    if (!jellyfinConfig || !userId) { alert('Not connected to Jellyfin'); return }

    setIsLoadingPreview(true)
    try {
      const { artistIds, albumIds, playlistIds, map } = buildItemTypesMap()
      const selectedIds = [...artistIds, ...albumIds, ...playlistIds].filter(Boolean)

      const [estimate, syncedItems] = await Promise.all([
        window.api.estimateSize({ serverUrl: jellyfinConfig.url, apiKey: jellyfinConfig.apiKey, userId, itemIds: selectedIds, itemTypes: map }),
        window.api.getSyncedItems(syncFolder),
      ])
      const alreadySyncedCount = syncedItems.filter((id: string) => selectedIds.includes(id)).length
      const visibleIds = new Set([...artists.map(a => a.Id), ...albums.map(a => a.Id), ...playlists.map(p => p.Id)])
      const willRemoveCount = [...previouslySyncedItems].filter(id => visibleIds.has(id) && !selectedTracks.has(id)).length
      setPreviewData({ ...estimate, alreadySyncedCount, willRemoveCount })
      setShowPreview(true)
    } catch {
      executeSyncNow()
    } finally {
      setIsLoadingPreview(false)
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
  }
}
