import { useState, useEffect } from 'react'
import type { ActiveSection, LibraryTab } from './appTypes'

import { AppHeader } from './components/AppHeader'
import { SearchBar } from './components/SearchBar'
import { Sidebar } from './components/Sidebar'
import { LibraryContent } from './components/LibraryContent'
import { SearchResults } from './components/SearchResults'
import { SyncPanel } from './components/SyncPanel'
import { DevicesPanel } from './components/DevicesPanel'
import { SyncPreviewModal } from './components/SyncPreviewModal'
import { FooterStats } from './components/FooterStats'
import { ConnectingScreen } from './components/ConnectingScreen'
import { LoginScreen } from './components/LoginScreen'
import { UserSelectorScreen } from './components/UserSelectorScreen'

import { useDevices } from './hooks/useDevices'
import { useSearch } from './hooks/useSearch'
import { useSelection } from './hooks/useSelection'
import { useLibrary } from './hooks/useLibrary'
import { useSync } from './hooks/useSync'
import { useJellyfinConnection } from './hooks/useJellyfinConnection'

function App(): JSX.Element {
  const [activeSection, setActiveSection] = useState<ActiveSection>('library')

  const devices = useDevices()

  const connection = useJellyfinConnection((_url, _apiKey, _userId) => {
    // loading is triggered by useEffect below once isConnected becomes true
  })

  const lib = useLibrary(connection.jellyfinConfig, connection.userId)

  // Load library once connection is established
  useEffect(() => {
    if (connection.isConnected && connection.jellyfinConfig && connection.userId) {
      lib.loadLibrary(connection.jellyfinConfig.url, connection.jellyfinConfig.apiKey, connection.userId)
      lib.loadStats(connection.jellyfinConfig.url, connection.jellyfinConfig.apiKey, connection.userId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.isConnected])

  const selection = useSelection(
    null,
    lib.artists,
    lib.albums,
    lib.playlists
  )

  const sync = useSync({
    jellyfinConfig: connection.jellyfinConfig,
    userId: connection.userId,
    selectedTracks: selection.selectedTracks,
    previouslySyncedItems: selection.previouslySyncedItems,
    artists: lib.artists,
    albums: lib.albums,
    playlists: lib.playlists,
    itemTypeIndexRef: lib.itemTypeIndexRef,
    setPreviouslySyncedItems: selection.setPreviouslySyncedItems,
  })

  const { searchQuery, setSearchQuery, searchResults, isSearching } = useSearch(
    connection.jellyfinConfig,
    connection.userId
  )

  // Load previously synced items when destination changes
  useEffect(() => {
    if (!sync.syncFolder) {
      selection.setPreviouslySyncedItems(new Set())
      return
    }
    window.api.getSyncedItems(sync.syncFolder).then((ids: string[]) => {
      const idSet = new Set(ids)
      selection.setPreviouslySyncedItems(idSet)
      selection.selectAll([...idSet].map(id => ({ Id: id })))
    }).catch(() => { /* ignore */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.syncFolder])

  // Load active tab when it changes
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

  const selectedArtistsCount = lib.artists.filter(a => selection.selectedTracks.has(a.Id)).length
  const selectedAlbumsCount = lib.albums.filter(a => selection.selectedTracks.has(a.Id)).length
  const selectedPlaylistsCount = lib.playlists.filter(p => selection.selectedTracks.has(p.Id)).length

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
    selection.selectAll(items)
  }

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

  if (connection.isConnecting) {
    return <ConnectingScreen />
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
      <AppHeader
        isConnected={connection.isConnected}
        onDisconnect={connection.disconnect}
      />

      <SearchBar value={searchQuery} onChange={setSearchQuery} />

      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          activeSection={activeSection}
          activeLibrary={lib.activeLibrary}
          stats={lib.stats}
          pagination={lib.pagination}
          artists={lib.artists}
          albums={lib.albums}
          playlists={lib.playlists}
          devices={devices}
          selectedCount={selection.selectedTracks.size}
          onLibraryTab={handleLibraryTab}
          onSyncClick={() => setActiveSection('sync')}
          onDevicesClick={() => setActiveSection('devices')}
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
                selectedTracks={selection.selectedTracks}
                onToggle={selection.toggleTrackSelection}
              />
            </main>
          ) : activeSection === 'library' ? (
            <LibraryContent
              activeLibrary={lib.activeLibrary}
              artists={lib.artists}
              albums={lib.albums}
              playlists={lib.playlists}
              pagination={lib.pagination}
              selectedTracks={selection.selectedTracks}
              previouslySyncedItems={selection.previouslySyncedItems}
              isLoadingMore={lib.isLoadingMore}
              searchQuery={searchQuery}
              error={lib.error}
              onToggle={selection.toggleTrackSelection}
              onSelectAll={selectAllInCurrentView}
              onClearSelection={selection.clearSelection}
              onClearError={() => lib.setError(null)}
              onLoadMore={lib.loadMore}
              selectionSummary={getSelectionSummary()}
              contentScrollRef={lib.contentScrollRef}
            />
          ) : activeSection === 'sync' ? (
            <main className="flex-1 overflow-auto">
              <SyncPanel
                syncFolder={sync.syncFolder}
                convertToMp3={sync.convertToMp3}
                bitrate={sync.bitrate}
                isSyncing={sync.isSyncing}
                isLoadingPreview={sync.isLoadingPreview}
                syncProgress={sync.syncProgress}
                selectionSummary={getSelectionSummary()}
                selectedCount={selection.selectedTracks.size}
                onSelectFolder={sync.handleSelectSyncFolder}
                onToggleConvert={() => sync.setConvertToMp3(v => !v)}
                onBitrateChange={sync.setBitrate}
                onStartSync={sync.handleStartSync}
              />
            </main>
          ) : (
            <main className="flex-1 overflow-auto">
              <DevicesPanel devices={devices} />
            </main>
          )}
        </div>
      </div>

      {sync.showPreview && sync.previewData && (
        <SyncPreviewModal
          data={sync.previewData}
          convertToMp3={sync.convertToMp3}
          bitrate={sync.bitrate}
          onCancel={() => sync.setShowPreview(false)}
          onConfirm={sync.executeSyncNow}
        />
      )}

      <FooterStats
        stats={lib.stats}
        pagination={lib.pagination}
        artists={lib.artists}
        albums={lib.albums}
        playlists={lib.playlists}
      />
    </div>
  )
}

export default App
