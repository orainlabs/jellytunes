import { useState, useEffect, useRef, useMemo } from 'react'
import type { ActiveSection, LibraryTab, Artist, Album, Playlist, Bitrate } from './appTypes'

import { AppHeader } from './components/AppHeader'
import { SyncSuccessModal } from './components/SyncSuccessModal'
import { Sidebar } from './components/Sidebar'
import { LibraryContent } from './components/LibraryContent'
import { DeviceSyncPanel } from './components/DeviceSyncPanel'
import { FooterStats } from './components/FooterStats'
import { ConnectingScreen } from './components/ConnectingScreen'
import { LoginScreen } from './components/LoginScreen'
import { UserSelectorScreen } from './components/UserSelectorScreen'

import { useDevices } from './hooks/useDevices'
import { useSearch } from './hooks/useSearch'
import { useDeviceSelections } from './hooks/useDeviceSelections'
import { useLibrary } from './hooks/useLibrary'
import { useSync } from './hooks/useSync'
import { useJellyfinConnection } from './hooks/useJellyfinConnection'
import { useSavedDestinations } from './hooks/useSavedDestinations'

function App(): JSX.Element {
  const [activeSection, setActiveSection] = useState<ActiveSection>('library')
  const [isRemovingDestination, setIsRemovingDestination] = useState(false)
  const [switchToast, setSwitchToast] = useState<string | null>(null)

  const { devices: usbDevices, refresh: refreshDevices } = useDevices()
  const { destinations: savedDestinations, addDestination, removeDestination, updateDestination: saveDestPrefs } = useSavedDestinations()

  const connection = useJellyfinConnection((_url, _apiKey, _userId) => {})

  const lib = useLibrary(connection.jellyfinConfig, connection.userId)

  useEffect(() => {
    if (connection.isConnected && connection.jellyfinConfig && connection.userId) {
      lib.loadLibrary(connection.jellyfinConfig.url, connection.jellyfinConfig.apiKey, connection.userId)
      lib.loadStats(connection.jellyfinConfig.url, connection.jellyfinConfig.apiKey, connection.userId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.isConnected])

  const deviceSelections = useDeviceSelections()

  const { searchQuery, setSearchQuery, searchResults, isSearching, searchError } = useSearch(
    connection.jellyfinConfig,
    connection.userId
  )

  // Persistent cache of full item objects found via search
  const searchItemCacheRef = useRef<{
    artists: Map<string, Artist>
    albums: Map<string, Album>
    playlists: Map<string, Playlist>
  }>({ artists: new Map(), albums: new Map(), playlists: new Map() })

  // Clear cache on disconnect so stale data doesn't carry over to next server
  useEffect(() => {
    if (!connection.isConnected) {
      searchItemCacheRef.current = { artists: new Map(), albums: new Map(), playlists: new Map() }
    }
  }, [connection.isConnected])

  // Accumulate search result objects into cache
  useEffect(() => {
    if (!searchResults) return
    searchResults.artists.forEach(a => searchItemCacheRef.current.artists.set(a.Id, a))
    searchResults.albums.forEach(a => searchItemCacheRef.current.albums.set(a.Id, a))
    searchResults.playlists.forEach(p => searchItemCacheRef.current.playlists.set(p.Id, p))
  }, [searchResults])

  // Merge paginated arrays with cached search objects (dedup by Id)
  function mergeWithCache<T extends { Id: string }>(base: T[], extra: T[]): T[] {
    const map = new Map(base.map(x => [x.Id, x]))
    extra.forEach(x => { if (!map.has(x.Id)) map.set(x.Id, x) })
    return [...map.values()]
  }
  const extArtists = mergeWithCache(lib.artists, [...searchItemCacheRef.current.artists.values()])
  const extAlbums = mergeWithCache(lib.albums, [...searchItemCacheRef.current.albums.values()])
  const extPlaylists = mergeWithCache(lib.playlists, [...searchItemCacheRef.current.playlists.values()])

  const sync = useSync({
    jellyfinConfig: connection.jellyfinConfig,
    userId: connection.userId,
    selectedTracks: deviceSelections.selectedTracks,
    previouslySyncedItems: deviceSelections.previouslySyncedItems,
    syncedItemsInfo: deviceSelections.syncedItemsInfo,
    outOfSyncItems: deviceSelections.outOfSyncItems,
    artists: extArtists,
    albums: extAlbums,
    playlists: extPlaylists,
    revalidateDevice: deviceSelections.revalidateDevice,
    setPreviouslySyncedItems: (items) => {
      if (deviceSelections.activeDevicePath) {
        deviceSelections.updateSyncedItems(deviceSelections.activeDevicePath, items)
      }
    },
  })

  // Bidirectional sync inference: artist ↔ albums
  const inferredSyncedItems = useMemo(() => {
    const artistIds = new Set(extArtists.map(a => a.Id))
    const albumIds = new Set(extAlbums.map(a => a.Id))
    const result = new Set(deviceSelections.previouslySyncedItems)

    // Rule 1: If an artist is synced, infer all their albums as synced
    for (const id of deviceSelections.previouslySyncedItems) {
      if (artistIds.has(id)) {
        const artist = extArtists.find(a => a.Id === id)
        if (artist) {
          const key = artist.Name.toLowerCase()
          const albumSet = lib.artistAlbumMap.get(key)
          if (albumSet) {
            for (const albumId of albumSet) {
              if (albumIds.has(albumId)) result.add(albumId)
            }
          }
        }
      }
    }

    // Rule 2: If all albums of an artist are synced, infer the artist as synced
    for (const [artistNameLower, albumSet] of lib.artistAlbumMap) {
      const artist = extArtists.find(a => a.Name.toLowerCase() === artistNameLower)
      if (!artist) continue
      const allAlbumIds = [...albumSet].filter(id => albumIds.has(id))
      if (allAlbumIds.length === 0) continue
      const allSynced = allAlbumIds.every(id => deviceSelections.previouslySyncedItems.has(id))
      if (allSynced) result.add(artist.Id)
    }

    return result
  }, [deviceSelections.previouslySyncedItems, extArtists, extAlbums, lib.artistAlbumMap])

  useEffect(() => {
    if (activeSection === 'library' && connection.jellyfinConfig && connection.userId) {
      lib.loadTab(lib.activeLibrary)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.activeLibrary, activeSection, connection.jellyfinConfig, connection.userId])

  const handleLibraryTab = (tab: LibraryTab) => {
    setActiveSection('library')
    lib.handleTabChange(tab)
  }

  const handleDestinationClick = async (
    path: string,
    forcedConvert?: boolean,
    forcedBitrate?: Bitrate,
    forcedCover?: 'off' | 'embed' | 'companion'
  ) => {
    if (!connection.jellyfinConfig || !connection.userId) return

    // Inform the user their pending (unsynced) selections are preserved when switching devices
    const currentPath = sync.syncFolder
    if (currentPath && path !== currentPath) {
      const pendingCount = [...deviceSelections.selectedTracks].filter(
        id => !deviceSelections.previouslySyncedItems.has(id)
      ).length
      if (pendingCount > 0) {
        const name = getDestinationName(currentPath)
        setSwitchToast(`${pendingCount} item${pendingCount !== 1 ? 's' : ''} still pending sync on ${name}`)
        setTimeout(() => setSwitchToast(null), 3000)
      }
    }

    setActiveSection('device')
    sync.setSyncFolder(path)
    // Build itemIds/itemTypes from selected library items
    const selected = deviceSelections.selectedTracks
    const itemIds: string[] = []
    const itemTypes: Record<string, 'artist' | 'album' | 'playlist'> = {}
    for (const a of extArtists) { if (selected.has(a.Id)) { itemIds.push(a.Id); itemTypes[a.Id] = 'artist' } }
    for (const a of extAlbums) { if (selected.has(a.Id)) { itemIds.push(a.Id); itemTypes[a.Id] = 'album' } }
    for (const p of extPlaylists) { if (selected.has(p.Id)) { itemIds.push(p.Id); itemTypes[p.Id] = 'playlist' } }

    // Load saved prefs for this destination (or use global defaults)
    // forced* params come from handleAddFolder where state hasn't flushed yet;
    // otherwise fall back to localStorage via savedDestinations.find
    const savedDest = savedDestinations.find(d => d.path === path)
    const savedConvert = forcedConvert ?? savedDest?.convertToMp3 ?? sync.convertToMp3
    const savedBitrate = forcedBitrate ?? savedDest?.bitrate ?? sync.bitrate
    const savedCover = forcedCover ?? savedDest?.coverArtMode ?? 'embed'

    // Sync global state to saved prefs so the panel shows correct values on arrival
    if (savedDest && (savedConvert !== sync.convertToMp3 || savedBitrate !== sync.bitrate)) {
      sync.setConvertToMp3(savedConvert)
      sync.setBitrate(savedBitrate)
      sync.setCoverArtMode(savedCover)
    }

    await deviceSelections.activateDevice(path, {
      serverUrl: connection.jellyfinConfig.url,
      apiKey: connection.jellyfinConfig.apiKey,
      userId: connection.userId,
      itemIds,
      itemTypes,
      convertToMp3: savedConvert,
      bitrate: savedBitrate,
      coverArtMode: savedCover,
    })
  }

  const handleAddFolder = async () => {
    const folder = await window.api.selectFolder()
    if (!folder) return
    const saved = addDestination(folder)
    // addDestination is synchronous — saved has the (possibly new) dest with current prefs
    const savedConvert = saved.convertToMp3 ?? sync.convertToMp3
    const savedBitrate = saved.bitrate ?? sync.bitrate
    const savedCover = saved.coverArtMode ?? 'embed'
    if (savedConvert !== sync.convertToMp3 || savedBitrate !== sync.bitrate) {
      sync.setConvertToMp3(savedConvert)
      sync.setBitrate(savedBitrate)
    }
    if (savedCover !== sync.coverArtMode) {
      sync.setCoverArtMode(savedCover)
    }
    handleDestinationClick(folder, savedConvert, savedBitrate, savedCover)
  }

  const handleRemoveDestination = async (path: string, deleteFiles: boolean, onDone: () => void) => {
    if (deleteFiles && connection.jellyfinConfig && connection.userId) {
      setIsRemovingDestination(true)
      await window.api.clearDestination({
        serverUrl: connection.jellyfinConfig.url,
        apiKey: connection.jellyfinConfig.apiKey,
        userId: connection.userId,
        destinationPath: path,
      })
      setIsRemovingDestination(false)
    }
    const dest = savedDestinations.find(d => d.path === path)
    if (dest) removeDestination(dest.id)
    deviceSelections.removeDevice(path)
    if (deviceSelections.activeDevicePath === path) {
      setActiveSection('library')
      sync.setSyncFolder(null)
    }
    onDone()
  }

  const getDestinationName = (path: string): string => {
    const usbMatch = usbDevices
      .flatMap(d => d.mountpoints.map(mp => ({ name: d.productName || d.displayName || 'USB Device', path: mp.path })))
      .find(d => d.path === path)
    if (usbMatch) return usbMatch.name
    const saved = savedDestinations.find(d => d.path === path)
    if (saved) return saved.name
    return path.split('/').filter(Boolean).pop() ?? path
  }

  const isUsbDevice = (path: string) =>
    usbDevices.some(d => d.mountpoints.some(mp => mp.path === path))

  const isSavedDestination = (path: string) =>
    savedDestinations.some(d => d.path === path)

  // Selection summary for the active device (use extended arrays to count search-selected items)
  const selectedArtistsCount = extArtists.filter(a => deviceSelections.selectedTracks.has(a.Id)).length
  const selectedAlbumsCount = extAlbums.filter(a => deviceSelections.selectedTracks.has(a.Id)).length
  const selectedPlaylistsCount = extPlaylists.filter(p => deviceSelections.selectedTracks.has(p.Id)).length

  const getSelectionSummary = (): string => {
    const parts: string[] = []
    if (selectedArtistsCount > 0) parts.push(`${selectedArtistsCount} artist${selectedArtistsCount !== 1 ? 's' : ''}`)
    if (selectedAlbumsCount > 0) parts.push(`${selectedAlbumsCount} album${selectedAlbumsCount !== 1 ? 's' : ''}`)
    if (selectedPlaylistsCount > 0) parts.push(`${selectedPlaylistsCount} playlist${selectedPlaylistsCount !== 1 ? 's' : ''}`)
    return parts.length > 0 ? parts.join(', ') : 'None selected'
  }

  const selectAllInCurrentView = () => {
    const items = lib.activeLibrary === 'artists' ? lib.artists
      : lib.activeLibrary === 'albums' ? lib.albums
      : lib.playlists
    deviceSelections.selectItems(items)
  }

  // While a sync is running, lock the view to the syncing device
  const effectiveSection = sync.isSyncing ? 'device' : activeSection
  const effectiveDevicePath = sync.isSyncing && sync.syncFolder
    ? sync.syncFolder
    : deviceSelections.activeDevicePath

  if (!connection.isConnected && !connection.isConnecting && !connection.showUserSelector) {
    return (
      <LoginScreen
        urlInput={connection.urlInput}
        apiKeyInput={connection.apiKeyInput}
        error={connection.error}
        onUrlChange={connection.setUrlInput}
        onApiKeyChange={connection.setApiKeyInput}
        onSubmit={connection.connectToJellyfin}
      />
    )
  }

  if (connection.showUserSelector && connection.pendingConfig) {
    return (
      <UserSelectorScreen
        users={connection.users}
        serverUrl={connection.pendingConfig.url}
        onSelect={connection.handleUserSelect}
        onCancel={connection.handleUserSelectorCancel}
      />
    )
  }

  if (connection.isConnecting) return <ConnectingScreen serverUrl={connection.urlInput || undefined} />

  return (
    <div className="h-screen flex flex-col bg-surface text-on_surface">
      <AppHeader isConnected={connection.isConnected} serverUrl={connection.jellyfinConfig?.url} onDisconnect={connection.disconnect} isSyncing={sync.isSyncing} />

      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          activeSection={activeSection}
          activeLibrary={lib.activeLibrary}
          activeDestinationPath={deviceSelections.activeDevicePath}
          stats={lib.stats}
          pagination={lib.pagination}
          artists={lib.artists}
          albums={lib.albums}
          playlists={lib.playlists}
          usbDevices={usbDevices}
          savedDestinations={savedDestinations}
          onLibraryTab={handleLibraryTab}
          onDestinationClick={handleDestinationClick}
          onAddFolder={handleAddFolder}
          onRefreshDevices={refreshDevices}
          onRefreshLibrary={async () => {
            await lib.refreshLibrary()
            // Clear stale registry tracks and re-run analyzeDiff
            await deviceSelections.onLibraryRefresh()
          }}
          onRemoveDestination={(path, deleteFiles, onDone) => handleRemoveDestination(path, deleteFiles, onDone)}
          isRemovingDestination={isRemovingDestination}
          isSyncing={sync.isSyncing}
        />

        <div className="flex-1 overflow-hidden flex flex-col relative">
          {switchToast && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 px-4 py-2
              bg-surface_container_low border border-secondary_container/60 rounded-lg
              text-body-md text-on_surface_variant shadow-lg pointer-events-none whitespace-nowrap">
              {switchToast}
            </div>
          )}
          {effectiveSection === 'library' ? (
            <LibraryContent
              activeLibrary={lib.activeLibrary}
              artists={lib.artists}
              albums={lib.albums}
              playlists={lib.playlists}
              pagination={lib.pagination}
              selectedTracks={deviceSelections.selectedTracks}
              previouslySyncedItems={inferredSyncedItems}
              outOfSyncItems={deviceSelections.outOfSyncItems}
              isLoadingMore={lib.isLoadingMore}
              error={lib.error}
              onToggle={deviceSelections.toggleItem}
              onSelectAll={selectAllInCurrentView}
              onClearSelection={deviceSelections.clearSelection}
              onClearError={() => lib.setError(null)}
              onLoadMore={lib.loadMore}
              selectionSummary={getSelectionSummary()}
              contentScrollRef={lib.contentScrollRef}
              hasActiveDevice={!!deviceSelections.activeDevicePath}
              serverUrl={connection.jellyfinConfig?.url}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              searchResults={searchResults}
              isSearching={isSearching}
              searchError={searchError}
            />
          ) : effectiveSection === 'device' && effectiveDevicePath ? (
            <main className="flex-1 overflow-hidden">
              <DeviceSyncPanel
                destinationPath={effectiveDevicePath}
                destinationName={getDestinationName(effectiveDevicePath)}
                isUsbDevice={isUsbDevice(effectiveDevicePath)}
                isSaved={isSavedDestination(effectiveDevicePath)}
                convertToMp3={sync.convertToMp3}
                bitrate={sync.bitrate}
                coverArtMode={sync.coverArtMode}
                isSyncing={sync.isSyncing}
                isActivatingDevice={deviceSelections.isActivatingDevice}
                syncProgress={sync.syncProgress}
                selectedTracks={deviceSelections.selectedTracks}
                syncedItemsInfo={deviceSelections.syncedItemsInfo}
                outOfSyncItems={deviceSelections.outOfSyncItems}
                artists={extArtists}
                albums={extAlbums}
                playlists={extPlaylists}
                showPreview={sync.showPreview}
                previewData={sync.previewData}
                syncedMusicBytes={deviceSelections.syncedMusicBytes ?? undefined}
                estimatedSizeBytes={deviceSelections.estimatedSizeBytes}
                isLoadingSize={deviceSelections.isLoadingSize}
                onToggleItem={deviceSelections.toggleItem}
                onToggleConvert={() => {
                  const willBeOn = !sync.convertToMp3
                  sync.setConvertToMp3(willBeOn)
                  deviceSelections.updateConvertOptions(willBeOn, sync.bitrate)
                  const destId = savedDestinations.find(d => d.path === deviceSelections.activeDevicePath)?.id
                  if (destId) saveDestPrefs(destId, { convertToMp3: willBeOn })
                }}
                onBitrateChange={b => {
                  deviceSelections.updateConvertOptions(sync.convertToMp3, b)
                  sync.setBitrate(b)
                  const destId = savedDestinations.find(d => d.path === deviceSelections.activeDevicePath)?.id
                  if (destId) saveDestPrefs(destId, { bitrate: b })
                }}
                onCoverArtModeChange={m => {
                  deviceSelections.updateConvertOptions(sync.convertToMp3, sync.bitrate, m)
                  sync.setCoverArtMode(m)
                  const destId = savedDestinations.find(d => d.path === deviceSelections.activeDevicePath)?.id
                  if (destId) saveDestPrefs(destId, { coverArtMode: m })
                }}
                onStartSync={sync.handleStartSync}
                onCancelSync={sync.handleCancelSync}
                onCancelPreview={() => sync.setShowPreview(false)}
                onConfirmSync={sync.executeSyncNow}
                onRemoveDestination={(deleteFiles) => handleRemoveDestination(effectiveDevicePath!, deleteFiles, () => {})}
              />
            </main>
          ) : (
            <main className="flex-1 flex items-center justify-center text-zinc-600">
              <div className="text-center">
                <p className="text-title-md font-semibold mb-2">Select a device or folder</p>
                <p className="text-body-md">Choose from the sidebar or add a new folder</p>
              </div>
            </main>
          )}
        </div>
      </div>

      <FooterStats
        stats={lib.stats}
        pagination={lib.pagination}
        artists={lib.artists}
        albums={lib.albums}
        playlists={lib.playlists}
        activeDeviceName={deviceSelections.activeDevicePath ? getDestinationName(deviceSelections.activeDevicePath) : null}
        isUsbDevice={deviceSelections.activeDevicePath ? isUsbDevice(deviceSelections.activeDevicePath) : false}
        onGoToDevice={() => setActiveSection('device')}
        isSyncing={sync.isSyncing}
      />

      {sync.syncSuccessData && (
        <SyncSuccessModal
          tracksCopied={sync.syncSuccessData.tracksCopied}
          tracksSkipped={sync.syncSuccessData.tracksSkipped}
          tracksRetagged={sync.syncSuccessData.tracksRetagged}
          removed={sync.syncSuccessData.removed}
          errors={sync.syncSuccessData.errors}
          onClose={() => sync.setSyncSuccessData(null)}
        />
      )}
    </div>
  )
}

export default App
