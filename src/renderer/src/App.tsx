import { useState, useEffect } from 'react'
import type { ActiveSection, LibraryTab } from './appTypes'

import { AppHeader } from './components/AppHeader'
import { SearchBar } from './components/SearchBar'
import { Sidebar } from './components/Sidebar'
import { LibraryContent } from './components/LibraryContent'
import { SearchResults } from './components/SearchResults'
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

  const sync = useSync({
    jellyfinConfig: connection.jellyfinConfig,
    userId: connection.userId,
    selectedTracks: deviceSelections.selectedTracks,
    previouslySyncedItems: deviceSelections.previouslySyncedItems,
    artists: lib.artists,
    albums: lib.albums,
    playlists: lib.playlists,
    itemTypeIndexRef: lib.itemTypeIndexRef,
    setPreviouslySyncedItems: (ids: Set<string>) => {
      if (deviceSelections.activeDevicePath) {
        deviceSelections.updateSyncedItems(deviceSelections.activeDevicePath, ids)
      }
    },
  })

  const { searchQuery, setSearchQuery, searchResults, isSearching } = useSearch(
    connection.jellyfinConfig,
    connection.userId
  )

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

  // Selection summary for the active device
  const selectedArtistsCount = lib.artists.filter(a => deviceSelections.selectedTracks.has(a.Id)).length
  const selectedAlbumsCount = lib.albums.filter(a => deviceSelections.selectedTracks.has(a.Id)).length
  const selectedPlaylistsCount = lib.playlists.filter(p => deviceSelections.selectedTracks.has(p.Id)).length

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

  if (connection.isConnecting) return <ConnectingScreen />

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
      <AppHeader isConnected={connection.isConnected} onDisconnect={connection.disconnect} />

      {activeSection === 'library' && (
        <SearchBar value={searchQuery} onChange={setSearchQuery} />
      )}

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
          {activeSection === 'library' && searchQuery.length >= 2 ? (
            <main className="flex-1 p-6 overflow-auto">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-semibold">Search Results</h2>
              </div>
              <SearchResults
                query={searchQuery}
                isSearching={isSearching}
                results={searchResults}
                selectedTracks={deviceSelections.selectedTracks}
                onToggle={deviceSelections.toggleItem}
              />
            </main>
          ) : activeSection === 'library' ? (
            <LibraryContent
              activeLibrary={lib.activeLibrary}
              artists={lib.artists}
              albums={lib.albums}
              playlists={lib.playlists}
              pagination={lib.pagination}
              selectedTracks={deviceSelections.selectedTracks}
              previouslySyncedItems={deviceSelections.previouslySyncedItems}
              isLoadingMore={lib.isLoadingMore}
              searchQuery={searchQuery}
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
            />
          ) : activeSection === 'device' && deviceSelections.activeDevicePath ? (
            <main className="flex-1 overflow-auto flex flex-col p-6">
              <DeviceSyncPanel
                destinationPath={deviceSelections.activeDevicePath}
                destinationName={getDestinationName(deviceSelections.activeDevicePath)}
                isUsbDevice={isUsbDevice(deviceSelections.activeDevicePath)}
                isSaved={isSavedDestination(deviceSelections.activeDevicePath)}
                convertToMp3={sync.convertToMp3}
                bitrate={sync.bitrate}
                isSyncing={sync.isSyncing}
                isLoadingPreview={sync.isLoadingPreview}
                syncProgress={sync.syncProgress}
                selectedTracks={deviceSelections.selectedTracks}
                previouslySyncedItems={deviceSelections.previouslySyncedItems}
                artists={lib.artists}
                albums={lib.albums}
                playlists={lib.playlists}
                showPreview={sync.showPreview}
                previewData={sync.previewData}
                onToggleItem={deviceSelections.toggleItem}
                onToggleConvert={() => sync.setConvertToMp3(v => !v)}
                onBitrateChange={sync.setBitrate}
                onStartSync={sync.handleStartSync}
                onCancelPreview={() => sync.setShowPreview(false)}
                onConfirmSync={sync.executeSyncNow}
                onRemoveDestination={() => handleRemoveDestination(deviceSelections.activeDevicePath!)}
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
