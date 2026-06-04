import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type {
  ActiveSection,
  LibraryTab,
  Artist,
  AlbumArtist,
  Album,
  Playlist,
  Genre,
  Bitrate,
} from './appTypes';
import { assertExhaustive } from './utils/assertExhaustive';

import { AppHeader } from './components/AppHeader';
import { SyncSuccessModal } from './components/SyncSuccessModal';
import { Sidebar } from './components/Sidebar';
import { LibraryContent } from './components/LibraryContent';
import { DeviceSyncPanel } from './components/DeviceSyncPanel';
import { FooterStats } from './components/FooterStats';
import { ConnectingScreen } from './components/ConnectingScreen';
import { LoginScreen } from './components/LoginScreen';
import { UserSelectorScreen } from './components/UserSelectorScreen';

import { useDevices } from './hooks/useDevices';
import { useTabSearch, UseTabSearchProvider } from './hooks/useTabSearch';
import { useDeviceSelections } from './hooks/useDeviceSelections';
import { useLibrary } from './hooks/useLibrary';
import { useSync } from './hooks/useSync';
import { useJellyfinConnection } from './hooks/useJellyfinConnection';
import { useSavedDestinations } from './hooks/useSavedDestinations';
import { getTrackRegistry } from './hooks/useTrackRegistry';
import { buildItemTypes, buildItemIds } from './utils/selectionTypes';

function AppConnected({
  connection,
}: {
  connection: ReturnType<typeof useJellyfinConnection>;
}): JSX.Element {
  const [activeSection, setActiveSection] = useState<ActiveSection>('library');
  const [isRemovingDestination, setIsRemovingDestination] = useState(false);
  const [switchToast, setSwitchToast] = useState<string | null>(null);

  const { devices: usbDevices, refresh: refreshDevices } = useDevices();
  const {
    destinations: savedDestinations,
    addDestination,
    removeDestination,
    updateDestination: saveDestPrefs,
  } = useSavedDestinations();

  const lib = useLibrary(connection.jellyfinConfig, connection.userId);

  useEffect(() => {
    if (connection.isConnected && connection.jellyfinConfig && connection.userId) {
      void lib.loadLibrary(
        connection.jellyfinConfig.url,
        connection.jellyfinConfig.apiKey,
        connection.userId,
      );
      void lib.loadStats(
        connection.jellyfinConfig.url,
        connection.jellyfinConfig.apiKey,
        connection.userId,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.isConnected]);

  const deviceSelections = useDeviceSelections();
  const registry = useMemo(() => getTrackRegistry(), []);
  const hasFlacOrM4a = useMemo(
    () => registry.hasFlacOrM4a(deviceSelections.selectedTracks),
    [registry, deviceSelections.selectedTracks],
  );

  const { searchQueries, setSearchQuery, setActiveTab, searchResults, isSearching, searchError } =
    useTabSearch();

  // Get the search query for the currently active tab
  const currentTabSearchQuery =
    lib.activeLibrary === 'genres' ? '' : searchQueries[lib.activeLibrary];

  // Clear search for the current tab
  const handleClearSearch = useCallback(() => {
    setSearchQuery('', lib.activeLibrary);
  }, [setSearchQuery, lib.activeLibrary]);

  // Persistent cache of full item objects found via search
  const searchItemCacheRef = useRef<{
    artists: Map<string, Artist>;
    albumArtists: Map<string, AlbumArtist>;
    albums: Map<string, Album>;
    playlists: Map<string, Playlist>;
    genres: Map<string, Genre>;
  }>({
    artists: new Map(),
    albumArtists: new Map(),
    albums: new Map(),
    playlists: new Map(),
    genres: new Map(),
  });

  // Clear cache on disconnect so stale data doesn't carry over to next server
  useEffect(() => {
    if (!connection.isConnected) {
      searchItemCacheRef.current = {
        artists: new Map(),
        albumArtists: new Map(),
        albums: new Map(),
        playlists: new Map(),
        genres: new Map(),
      };
    }
  }, [connection.isConnected]);

  // Accumulate search result objects into cache
  useEffect(() => {
    if (!searchResults) return;
    searchResults.artists.forEach((a) => searchItemCacheRef.current.artists.set(a.Id, a));
    searchResults.albumArtists.forEach((a) => searchItemCacheRef.current.albumArtists.set(a.Id, a));
    searchResults.albums.forEach((a) => searchItemCacheRef.current.albums.set(a.Id, a));
    searchResults.playlists.forEach((p) => searchItemCacheRef.current.playlists.set(p.Id, p));
    searchResults.genres.forEach((g) => searchItemCacheRef.current.genres.set(g.Id, g));
  }, [searchResults]);

  // Merge paginated arrays with cached search objects (dedup by Id)
  function mergeWithCache<T extends { Id: string }>(base: T[], extra: T[]): T[] {
    const map = new Map(base.map((x) => [x.Id, x]));
    extra.forEach((x) => {
      if (!map.has(x.Id)) map.set(x.Id, x);
    });
    return [...map.values()];
  }
  const extArtists = mergeWithCache(lib.artists, [...searchItemCacheRef.current.artists.values()]);
  const extAlbumArtists = mergeWithCache(lib.albumArtists, [
    ...searchItemCacheRef.current.albumArtists.values(),
  ]);
  const extAlbums = mergeWithCache(lib.albums, [...searchItemCacheRef.current.albums.values()]);
  const extPlaylists = mergeWithCache(lib.playlists, [
    ...searchItemCacheRef.current.playlists.values(),
  ]);
  const extGenres = mergeWithCache(lib.genres, [...searchItemCacheRef.current.genres.values()]);

  const sync = useSync({
    jellyfinConfig: connection.jellyfinConfig,
    userId: connection.userId,
    selectedTracks: deviceSelections.selectedTracks,
    selectedArtists: deviceSelections.selectedArtists,
    selectedAlbumArtists: deviceSelections.selectedAlbumArtists,
    previouslySyncedItems: deviceSelections.previouslySyncedItems,
    syncedItemsInfo: deviceSelections.syncedItemsInfo,
    outOfSyncItems: deviceSelections.outOfSyncItems,
    artists: extArtists,
    albumArtists: extAlbumArtists,
    albums: extAlbums,
    playlists: extPlaylists,
    genres: extGenres,
    isTickEstimate: deviceSelections.isTickEstimate,
    revalidateDevice: deviceSelections.revalidateDevice,
    setPreviouslySyncedItems: (items) => {
      if (deviceSelections.activeDevicePath) {
        void deviceSelections.updateSyncedItems(deviceSelections.activeDevicePath, items);
      }
    },
  });

  // Bidirectional sync inference: artist ↔ albums
  const inferredSyncedItems = useMemo(() => {
    const artistIds = new Set(extArtists.map((a) => a.Id));
    const albumIds = new Set(extAlbums.map((a) => a.Id));
    const result = new Set(deviceSelections.previouslySyncedItems);

    // Rule 1: If an artist is synced, infer all their albums as synced
    // Use AlbumArtist field on albums to match artist name
    for (const id of deviceSelections.previouslySyncedItems) {
      if (artistIds.has(id)) {
        const artist = extArtists.find((a) => a.Id === id);
        if (artist) {
          const matchingAlbums = extAlbums.filter(
            (a) => a.AlbumArtist?.toLowerCase() === artist.Name.toLowerCase(),
          );
          for (const album of matchingAlbums) {
            if (albumIds.has(album.Id)) result.add(album.Id);
          }
        }
      }
    }

    // Rule 2: If all albums of an artist are synced (based on ChildCount), infer the artist as synced
    for (const artist of extArtists) {
      // Use ChildCount (number of albums for this artist) from Jellyfin
      const childCount = artist.ChildCount ?? 0;
      if (childCount === 0) continue;
      const matchingAlbums = extAlbums.filter(
        (a) => a.AlbumArtist?.toLowerCase() === artist.Name.toLowerCase(),
      );
      const syncedCount = matchingAlbums.filter((a) =>
        deviceSelections.previouslySyncedItems.has(a.Id),
      ).length;
      if (syncedCount >= childCount) result.add(artist.Id);
    }

    return result;
  }, [deviceSelections.previouslySyncedItems, extArtists, extAlbums]);

  // Typed synced sets for artists/albumArtists tabs — prevents cross-leak where
  // syncing X as 'artist' makes X show as "will remove" in Album Artists tab.
  const syncedArtistIds = useMemo(
    () =>
      new Set(deviceSelections.syncedItemsInfo.filter((i) => i.type === 'artist').map((i) => i.id)),
    [deviceSelections.syncedItemsInfo],
  );
  const syncedAlbumArtistIds = useMemo(
    () =>
      new Set(
        deviceSelections.syncedItemsInfo.filter((i) => i.type === 'albumArtist').map((i) => i.id),
      ),
    [deviceSelections.syncedItemsInfo],
  );

  useEffect(() => {
    if (activeSection === 'library' && connection.jellyfinConfig && connection.userId) {
      void lib.loadTab(lib.activeLibrary);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.activeLibrary, activeSection, connection.jellyfinConfig, connection.userId]);

  const handleLibraryTab = (tab: LibraryTab) => {
    setActiveSection('library');
    setActiveTab(tab);
    lib.handleTabChange(tab);
  };

  const handleDestinationClick = async (
    path: string,
    forcedConvert?: boolean,
    forcedBitrate?: Bitrate,
    forcedCover?: 'off' | 'embed' | 'companion',
  ) => {
    if (!connection.jellyfinConfig || !connection.userId) return;

    // Inform the user their pending (unsynced) selections are preserved when switching devices
    const currentPath = sync.syncFolder;
    if (currentPath && path !== currentPath) {
      const pendingCount = [...deviceSelections.selectedTracks].filter(
        (id) => !deviceSelections.previouslySyncedItems.has(id),
      ).length;
      if (pendingCount > 0) {
        const name = getDestinationName(currentPath);
        setSwitchToast(
          `${pendingCount} item${pendingCount !== 1 ? 's' : ''} still pending sync on ${name}`,
        );
        setTimeout(() => setSwitchToast(null), 3000);
      }
    }

    setActiveSection('device');
    sync.setSyncFolder(path);
    // Build itemIds from selected items; itemTypes covers all library items so the
    // registry always has correct types for items selected after device activation.
    // ORAIN-0551: iterate the typed sets instead of the union `selectedTracks` so
    // a shared id (present in both extArtists and extAlbumArtists) is only added
    // once. ORAIN-0554: route itemTypes by the typed set the id was selected in,
    // not by the registry's last-write-wins fallback — otherwise a shared id
    // clicked from the Artists tab still arrived at the sync engine typed
    // 'albumArtist', and DeviceSyncPanel showed the wrong label.
    const selectedArtists = deviceSelections.selectedArtists;
    const selectedAlbumArtists = deviceSelections.selectedAlbumArtists;
    const selectedOthers = new Set<string>();
    for (const id of deviceSelections.selectedTracks) {
      if (!selectedArtists.has(id) && !selectedAlbumArtists.has(id)) selectedOthers.add(id);
    }
    const itemTypes = buildItemTypes({
      selectedArtists,
      selectedAlbumArtists,
      extArtists,
      extAlbumArtists,
      extAlbums,
      extPlaylists,
    });
    const itemIds = buildItemIds({
      selectedArtists,
      selectedAlbumArtists,
      selectedOthers,
      extArtists,
      extAlbumArtists,
      extAlbums,
      extPlaylists,
    });
    // ORAIN-0535: append genres. Genres live in `selectedTracks` (the union) and
    // share ids with nothing else in this codebase, so no typed set is required —
    // typing + ordering are applied directly against `extGenres`.
    for (const g of extGenres) {
      if (deviceSelections.selectedTracks.has(g.Id)) {
        itemIds.push(g.Id);
        itemTypes[g.Id] = 'genre';
      }
    }

    // Load saved prefs for this destination (or use global defaults)
    // forced* params come from handleAddFolder where state hasn't flushed yet;
    // otherwise fall back to localStorage via savedDestinations.find
    const savedDest = savedDestinations.find((d) => d.path === path);
    const savedConvert = forcedConvert ?? savedDest?.convertToMp3 ?? sync.convertToMp3;
    const savedBitrate = forcedBitrate ?? savedDest?.bitrate ?? sync.bitrate;
    const savedCover = forcedCover ?? savedDest?.coverArtMode ?? 'embed';

    // Sync global state to saved prefs so the panel shows correct values on arrival
    if (
      savedDest &&
      (savedConvert !== sync.convertToMp3 ||
        savedBitrate !== sync.bitrate ||
        savedCover !== sync.coverArtMode)
    ) {
      sync.setConvertToMp3(savedConvert);
      sync.setBitrate(savedBitrate);
      sync.setCoverArtMode(savedCover);
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
      // RunTimeTicks from library fetch — enables instant tick-based size estimation
      itemTicks: {
        ...Object.fromEntries(extArtists.map((a) => [a.Id, a.RunTimeTicks ?? 0])),
        ...Object.fromEntries(extAlbums.map((a) => [a.Id, a.RunTimeTicks ?? 0])),
        ...Object.fromEntries(extPlaylists.map((p) => [p.Id, p.RunTimeTicks ?? 0])),
        ...Object.fromEntries(extAlbumArtists.map((a) => [a.Id, a.RunTimeTicks ?? 0])),
      },
    });
  };

  const handleAddFolder = async () => {
    const folder = await window.api.selectFolder();
    if (!folder) return;
    const saved = addDestination(folder);
    // addDestination is synchronous — saved has the (possibly new) dest with current prefs
    const savedConvert = saved.convertToMp3 ?? sync.convertToMp3;
    const savedBitrate = saved.bitrate ?? sync.bitrate;
    const savedCover = saved.coverArtMode ?? 'embed';
    if (savedConvert !== sync.convertToMp3 || savedBitrate !== sync.bitrate) {
      sync.setConvertToMp3(savedConvert);
      sync.setBitrate(savedBitrate);
    }
    if (savedCover !== sync.coverArtMode) {
      sync.setCoverArtMode(savedCover);
    }
    void handleDestinationClick(folder, savedConvert, savedBitrate, savedCover);
  };

  const handleRemoveDestination = async (
    path: string,
    deleteFiles: boolean,
    onDone: () => void,
  ) => {
    if (deleteFiles && connection.jellyfinConfig && connection.userId) {
      setIsRemovingDestination(true);
      await window.api.clearDestination({
        serverUrl: connection.jellyfinConfig.url,
        apiKey: connection.jellyfinConfig.apiKey,
        userId: connection.userId,
        destinationPath: path,
      });
      setIsRemovingDestination(false);
    }
    const dest = savedDestinations.find((d) => d.path === path);
    if (dest) removeDestination(dest.id);
    deviceSelections.removeDevice(path);
    if (deviceSelections.activeDevicePath === path) {
      setActiveSection('library');
      sync.setSyncFolder(null);
    }
    onDone();
  };

  const getDestinationName = (path: string): string => {
    const usbMatch = usbDevices
      .flatMap((d) =>
        d.mountpoints.map((mp) => ({
          name: d.productName ?? d.displayName ?? 'USB Device',
          path: mp.path,
        })),
      )
      .find((d) => d.path === path);
    if (usbMatch) return usbMatch.name;
    const saved = savedDestinations.find((d) => d.path === path);
    if (saved) return saved.name;
    return path.split('/').filter(Boolean).pop() ?? path;
  };

  const isUsbDevice = (path: string) =>
    usbDevices.some((d) => d.mountpoints.some((mp) => mp.path === path));

  const isSavedDestination = (path: string) => savedDestinations.some((d) => d.path === path);

  // Selection summary for the active device (use extended arrays to count search-selected items)
  const selectedArtistsCount = extArtists.filter((a) =>
    deviceSelections.selectedTracks.has(a.Id),
  ).length;
  const selectedAlbumArtistsCount = extAlbumArtists.filter((a) =>
    deviceSelections.selectedTracks.has(a.Id),
  ).length;
  const selectedAlbumsCount = extAlbums.filter((a) =>
    deviceSelections.selectedTracks.has(a.Id),
  ).length;
  const selectedPlaylistsCount = extPlaylists.filter((p) =>
    deviceSelections.selectedTracks.has(p.Id),
  ).length;
  const selectedGenresCount = extGenres.filter((g) =>
    deviceSelections.selectedTracks.has(g.Id),
  ).length;

  // ORAIN-0384: Selection summary only for the currently active tab (not mixed types)
  // ORAIN-0399: Refactored to eliminate unreachable guard in countForTab closure
  const selectedCount = (() => {
    switch (lib.activeLibrary) {
      case 'artists':
        return selectedArtistsCount;
      case 'albumArtists':
        return selectedAlbumArtistsCount;
      case 'albums':
        return selectedAlbumsCount;
      case 'playlists':
        return selectedPlaylistsCount;
      case 'genres':
        return selectedGenresCount;
      default:
        return 0;
    }
  })();

  const selectedLabel = (() => {
    switch (lib.activeLibrary) {
      case 'artists':
        return selectedCount !== 1 ? 'artists' : 'artist';
      case 'albumArtists':
        return selectedCount !== 1 ? 'album artists' : 'album artist';
      case 'albums':
        return selectedCount !== 1 ? 'albums' : 'album';
      case 'playlists':
        return selectedCount !== 1 ? 'playlists' : 'playlist';
      case 'genres':
        return selectedCount !== 1 ? 'genres' : 'genre';
      default:
        return '';
    }
  })();

  const getSelectionSummary = (): string => {
    if (selectedCount === 0) return 'None selected';
    // ORAIN-0393: Warn on unexpected activeLibrary value to help detect bugs early
    if (!selectedLabel) {
      console.warn(`Unexpected activeLibrary value: ${lib.activeLibrary}`);
      return 'None selected';
    }
    return `${selectedCount} ${selectedLabel} selected`;
  };

  // Select All - fetches all items from library via pagination
  const [isSelectingAll, setIsSelectingAll] = useState(false);

  const selectAllInCurrentView = useCallback(async () => {
    setIsSelectingAll(true);
    try {
      // Fetch all items from library via pagination
      // Pass the item type so selectAllItems can register types BEFORE selection,
      // fixing the threshold guard bypass (ORAIN-0494)
      await lib.selectAllWithCompleteSet(
        lib.activeLibrary,
        (allIds) => {
          // IDs come directly from Jellyfin — no need to validate against locally-loaded
          // lib.artists/albums/playlists (which is a stale closure capturing only the
          // first PAGE_SIZE items and would silently drop all unloaded pages).
          // Use selectAllItems to register types before selection so threshold guard works.
          const itemType = (() => {
            switch (lib.activeLibrary) {
              case 'artists':
                return 'artist' as const;
              case 'albumArtists':
                return 'albumArtist' as const;
              case 'albums':
                return 'album' as const;
              case 'playlists':
                return 'playlist' as const;
              case 'genres':
                return 'genre' as const;
              default:
                // Compile-time safety: if a new library tab is added without updating this switch,
                // TypeScript will error here because `lib.activeLibrary` is no longer `never`.
                return assertExhaustive(lib.activeLibrary);
            }
          })();
          deviceSelections.selectAllItems(allIds, itemType);
        },
        (errors, selectedCount) => {
          // Notify user of partial errors
          lib.setError(
            `Select all: ${selectedCount} items selected, ${errors.length} page(s) failed`,
          );
        },
      );
    } finally {
      setIsSelectingAll(false);
    }
  }, [lib, deviceSelections]);

  // While a sync is running, lock the view to the syncing device
  const effectiveSection = sync.isSyncing ? 'device' : activeSection;
  const effectiveDevicePath =
    sync.isSyncing && sync.syncFolder ? sync.syncFolder : deviceSelections.activeDevicePath;

  return (
    <div className="h-screen flex flex-col bg-surface text-on_surface">
      <AppHeader
        isConnected={connection.isConnected}
        serverUrl={connection.jellyfinConfig?.url}
        onDisconnect={connection.disconnect}
        isSyncing={sync.isSyncing}
      />

      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          activeSection={activeSection}
          activeLibrary={lib.activeLibrary}
          activeDestinationPath={deviceSelections.activeDevicePath}
          stats={lib.stats}
          pagination={lib.pagination}
          artists={lib.artists}
          albumArtists={lib.albumArtists}
          albums={lib.albums}
          playlists={lib.playlists}
          genres={lib.genres}
          onLibraryTab={handleLibraryTab}
          usbDevices={usbDevices}
          savedDestinations={savedDestinations}
          onDestinationClick={handleDestinationClick}
          onAddFolder={handleAddFolder}
          onRefreshDevices={refreshDevices}
          onRefreshLibrary={async () => {
            await lib.refreshLibrary();
            // Clear stale registry tracks and re-run analyzeDiff
            await deviceSelections.onLibraryRefresh();
          }}
          onRemoveDestination={(path, deleteFiles, onDone) =>
            handleRemoveDestination(path, deleteFiles, onDone)
          }
          isRemovingDestination={isRemovingDestination}
          isSyncing={sync.isSyncing}
        />

        <div className="flex-1 overflow-hidden flex flex-col relative">
          {switchToast && (
            <div
              className="absolute top-3 left-1/2 -translate-x-1/2 z-20 px-4 py-2
              bg-surface_container_low border border-secondary_container/60 rounded-lg
              text-body-md text-on_surface_variant shadow-lg pointer-events-none whitespace-nowrap"
            >
              {switchToast}
            </div>
          )}
          {effectiveSection === 'library' ? (
            <LibraryContent
              activeLibrary={lib.activeLibrary}
              artists={lib.artists}
              albumArtists={lib.albumArtists}
              albums={lib.albums}
              playlists={lib.playlists}
              genres={lib.genres}
              pagination={lib.pagination}
              selectedTracks={deviceSelections.selectedTracks}
              selectedArtists={deviceSelections.selectedArtists}
              selectedAlbumArtists={deviceSelections.selectedAlbumArtists}
              syncedArtistIds={syncedArtistIds}
              syncedAlbumArtistIds={syncedAlbumArtistIds}
              previouslySyncedItems={inferredSyncedItems}
              outOfSyncItems={deviceSelections.outOfSyncItems}
              isLoadingMore={lib.isLoadingMore || isSelectingAll}
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
              searchQuery={currentTabSearchQuery}
              onSearchChange={(q) => setSearchQuery(q, lib.activeLibrary)}
              onClearSearch={handleClearSearch}
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
                lyricsMode={sync.lyricsMode}
                hasFlacOrM4a={hasFlacOrM4a}
                isSyncing={sync.isSyncing}
                isActivatingDevice={deviceSelections.isActivatingDevice}
                syncProgress={sync.syncProgress}
                selectedTracks={deviceSelections.selectedTracks}
                selectedArtists={deviceSelections.selectedArtists}
                selectedAlbumArtists={deviceSelections.selectedAlbumArtists}
                syncedItemsInfo={deviceSelections.syncedItemsInfo}
                outOfSyncItems={deviceSelections.outOfSyncItems}
                artists={extArtists}
                albumArtists={extAlbumArtists}
                albums={extAlbums}
                playlists={extPlaylists}
                genres={extGenres}
                showPreview={sync.showPreview}
                previewData={sync.previewData}
                syncedMusicBytes={deviceSelections.syncedMusicBytes ?? undefined}
                projectedAudioBytes={deviceSelections.projectedAudioBytes}
                estimatedSizeBytes={deviceSelections.estimatedSizeBytes}
                isTickEstimate={deviceSelections.isTickEstimate}
                isLoadingSize={deviceSelections.isLoadingSize}
                onToggleItem={deviceSelections.toggleItem}
                onToggleConvert={() => {
                  const willBeOn = !sync.convertToMp3;
                  sync.setConvertToMp3(willBeOn);
                  deviceSelections.updateConvertOptions(willBeOn, sync.bitrate);
                  const destId = savedDestinations.find(
                    (d) => d.path === deviceSelections.activeDevicePath,
                  )?.id;
                  if (destId) saveDestPrefs(destId, { convertToMp3: willBeOn });
                }}
                onBitrateChange={(b) => {
                  deviceSelections.updateConvertOptions(sync.convertToMp3, b);
                  sync.setBitrate(b);
                  const destId = savedDestinations.find(
                    (d) => d.path === deviceSelections.activeDevicePath,
                  )?.id;
                  if (destId) saveDestPrefs(destId, { bitrate: b });
                }}
                onCoverArtModeChange={(m) => {
                  deviceSelections.updateConvertOptions(sync.convertToMp3, sync.bitrate, m);
                  sync.setCoverArtMode(m);
                  const destId = savedDestinations.find(
                    (d) => d.path === deviceSelections.activeDevicePath,
                  )?.id;
                  if (destId) saveDestPrefs(destId, { coverArtMode: m });
                }}
                onLyricsModeChange={(m) => sync.setLyricsMode(m)}
                onStartSync={sync.handleStartSync}
                onCancelSync={sync.handleCancelSync}
                onCancelPreview={() => sync.setShowPreview(false)}
                onConfirmSync={sync.executeSyncNow}
                onRemoveDestination={(deleteFiles) =>
                  handleRemoveDestination(effectiveDevicePath!, deleteFiles, () => {})
                }
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
        activeDeviceName={
          deviceSelections.activeDevicePath
            ? getDestinationName(deviceSelections.activeDevicePath)
            : null
        }
        isUsbDevice={
          deviceSelections.activeDevicePath ? isUsbDevice(deviceSelections.activeDevicePath) : false
        }
        onGoToDevice={() => setActiveSection('device')}
        isSyncing={sync.isSyncing}
      />

      {sync.syncSuccessData && (
        <SyncSuccessModal
          tracksCopied={sync.syncSuccessData.tracksCopied}
          tracksSkipped={sync.syncSuccessData.tracksSkipped}
          tracksRetagged={sync.syncSuccessData.tracksRetagged}
          lyricsAdded={sync.syncSuccessData.lyricsAdded}
          removed={sync.syncSuccessData.removed}
          errors={sync.syncSuccessData.errors}
          lyricsMode={sync.syncSuccessData.lyricsMode}
          onClose={() => sync.setSyncSuccessData(null)}
        />
      )}
    </div>
  );
}

function App(): JSX.Element {
  const connection = useJellyfinConnection((_url, _apiKey, _userId) => {});

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
    );
  }

  if (connection.showUserSelector && connection.pendingConfig) {
    return (
      <UserSelectorScreen
        users={connection.users}
        serverUrl={connection.pendingConfig.url}
        onSelect={connection.handleUserSelect}
        onCancel={connection.handleUserSelectorCancel}
      />
    );
  }

  if (connection.isConnecting)
    return <ConnectingScreen serverUrl={connection.urlInput || undefined} />;

  return (
    <UseTabSearchProvider jellyfinConfig={connection.jellyfinConfig} userId={connection.userId}>
      <AppConnected connection={connection} />
    </UseTabSearchProvider>
  );
}

export default App;
