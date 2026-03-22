import { useState, useEffect, useRef } from 'react'
import type { ActiveSection, LibraryTab, Artist, Album, Playlist } from './appTypes'

import { AppHeader } from './components/AppHeader'
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

  const { devices: usbDevices, refresh: refreshDevices } = useDevices()
  const { destinations: savedDestinations, addDestination, removeDestination } = useSavedDestinations()

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
    artists: extArtists,
    albums: extAlbums,
    playlists: extPlaylists,
    setPreviouslySyncedItems: (items) => {
      if (deviceSelections.activeDevicePath) {
        deviceSelections.updateSyncedItems(deviceSelections.activeDevicePath, items)
      }
    },
  })

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

  const handleDestinationClick = async (path: string) => {
    setActiveSection('device')
    sync.setSyncFolder(path)
    await deviceSelections.activateDevice(path)
  }

  const handleAddFolder = async () => {
    const folder = await window.api.selectFolder()
    if (!folder) return
    addDestination(folder)
    handleDestinationClick(folder)
  }

  const handleRemoveDestination = (path: string) => {
    const dest = savedDestinations.find(d => d.path === path)
    if (dest) removeDestination(dest.id)
    deviceSelections.removeDevice(path)
    if (deviceSelections.activeDevicePath === path) {
      setActiveSection('library')
      sync.setSyncFolder(null)
    }
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

  const totalSelectedCount = deviceSelections.selectedTracks.size

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
    <div className="h-screen flex flex-col bg-jf-bg-dark text-zinc-100">
      <AppHeader isConnected={connection.isConnected} serverUrl={connection.jellyfinConfig?.url} onDisconnect={connection.disconnect} />

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
        />

        <div className="flex-1 overflow-hidden flex flex-col">
          {effectiveSection === 'library' ? (
            <LibraryContent
              activeLibrary={lib.activeLibrary}
              artists={lib.artists}
              albums={lib.albums}
              playlists={lib.playlists}
              pagination={lib.pagination}
              selectedTracks={deviceSelections.selectedTracks}
              previouslySyncedItems={deviceSelections.previouslySyncedItems}
              isLoadingMore={lib.isLoadingMore}
              error={lib.error}
              onToggle={deviceSelections.toggleItem}
              onSelectAll={selectAllInCurrentView}
              onClearSelection={deviceSelections.clearSelection}
              onClearError={() => lib.setError(null)}
              onLoadMore={lib.loadMore}
              selectionSummary={getSelectionSummary()}
              contentScrollRef={lib.contentScrollRef}
              activeDeviceName={deviceSelections.activeDevicePath ? getDestinationName(deviceSelections.activeDevicePath) : null}
              isUsbDevice={deviceSelections.activeDevicePath ? isUsbDevice(deviceSelections.activeDevicePath) : false}
              onGoToDevice={() => setActiveSection('device')}
              serverUrl={connection.jellyfinConfig?.url}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              searchResults={searchResults}
              isSearching={isSearching}
              searchError={searchError}
            />
          ) : effectiveSection === 'device' && effectiveDevicePath ? (
            <main className="flex-1 overflow-auto flex flex-col p-6">
              <DeviceSyncPanel
                destinationPath={effectiveDevicePath}
                destinationName={getDestinationName(effectiveDevicePath)}
                isUsbDevice={isUsbDevice(effectiveDevicePath)}
                isSaved={isSavedDestination(effectiveDevicePath)}
                convertToMp3={sync.convertToMp3}
                bitrate={sync.bitrate}
                isSyncing={sync.isSyncing}
                isLoadingPreview={sync.isLoadingPreview}
                syncProgress={sync.syncProgress}
                selectedTracks={deviceSelections.selectedTracks}
                syncedItemsInfo={deviceSelections.syncedItemsInfo}
                artists={extArtists}
                albums={extAlbums}
                playlists={extPlaylists}
                showPreview={sync.showPreview}
                previewData={sync.previewData}
                onToggleItem={deviceSelections.toggleItem}
                onToggleConvert={() => sync.setConvertToMp3(v => !v)}
                onBitrateChange={sync.setBitrate}
                onStartSync={sync.handleStartSync}
                onCancelSync={sync.handleCancelSync}
                onCancelPreview={() => sync.setShowPreview(false)}
                onConfirmSync={sync.executeSyncNow}
                onRemoveDestination={() => handleRemoveDestination(effectiveDevicePath!)}
              />
            </main>
          ) : (
            <main className="flex-1 flex items-center justify-center text-zinc-600">
              <div className="text-center">
                <p className="text-lg mb-2">Select a device or folder</p>
                <p className="text-sm">Choose from the sidebar or add a new folder</p>
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
      />
    </div>
  )
}

export default App
