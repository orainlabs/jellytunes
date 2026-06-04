import { useState } from 'react';
import type {
  JellyfinConfig,
  Artist,
  AlbumArtist,
  Album,
  Playlist,
  Genre,
  Bitrate,
  SyncProgressInfo,
  PreviewData,
  ItemPreview,
  CoverArtMode,
  LyricsMode,
} from '../appTypes';
import type { SyncedItemInfo } from './useDeviceSelections';
import { getTrackRegistry } from './useTrackRegistry';
import { logger } from '../utils/logger';

interface UseSyncOptions {
  jellyfinConfig: JellyfinConfig | null;
  userId: string | null;
  selectedTracks: Set<string>;
  selectedArtists: Set<string>;
  selectedAlbumArtists: Set<string>;
  previouslySyncedItems: Set<string>;
  syncedItemsInfo: SyncedItemInfo[];
  outOfSyncItems: Set<string>;
  artists: Artist[];
  albumArtists: AlbumArtist[];
  albums: Album[];
  playlists: Playlist[];
  genres: Genre[];
  /** True when size was estimated from ticks (fetch was skipped); track counts are unreliable */
  isTickEstimate: boolean;
  setPreviouslySyncedItems: (items: SyncedItemInfo[]) => void;
  revalidateDevice: (
    overrides?: Partial<{
      coverArtMode: CoverArtMode;
      convertToMp3: boolean;
      bitrate: Bitrate;
    }>,
  ) => Promise<void>;
}

export function useSync({
  jellyfinConfig,
  userId,
  selectedTracks,
  selectedArtists,
  selectedAlbumArtists,
  previouslySyncedItems,
  syncedItemsInfo,
  outOfSyncItems,
  artists,
  albumArtists,
  albums,
  playlists,
  genres,
  isTickEstimate,
  setPreviouslySyncedItems,
  revalidateDevice,
}: UseSyncOptions) {
  const registry = getTrackRegistry();
  const [syncFolder, setSyncFolder] = useState<string | null>(null);
  const [convertToMp3, setConvertToMp3] = useState(false);
  const [bitrate, setBitrate] = useState<Bitrate>('192k');
  const [coverArtMode, setCoverArtMode] = useState<CoverArtMode>('embed');
  const [lyricsMode, setLyricsMode] = useState<LyricsMode>('off');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgressInfo | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [syncSuccessData, setSyncSuccessData] = useState<{
    tracksCopied: number;
    tracksSkipped: number;
    tracksRetagged: number;
    lyricsAdded?: number;
    removed: number;
    errors: string[];
    lyricsMode?: string;
  } | null>(null);

  const handleSelectSyncFolder = async (path?: string): Promise<void> => {
    if (path) {
      setSyncFolder(path);
      return;
    }
    const folder = await window.api.selectFolder();
    if (folder) setSyncFolder(folder);
  };

  const buildItemTypesMap = () => {
    const artistIds = artists.filter((a) => selectedArtists.has(a.Id)).map((a) => a.Id);
    const albumArtistIds = albumArtists
      .filter((a) => selectedAlbumArtists.has(a.Id))
      .map((a) => a.Id);
    const albumIds = albums.filter((a) => selectedTracks.has(a.Id)).map((a) => a.Id);
    const playlistIds = playlists.filter((p) => selectedTracks.has(p.Id)).map((p) => p.Id);
    const genreIds = genres.filter((g) => selectedTracks.has(g.Id)).map((g) => g.Id);
    const map: Record<string, 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre'> = {};
    const names: Record<string, string> = {};
    artistIds.forEach((id) => {
      if (id) map[id] = 'artist';
    });
    albumArtistIds.forEach((id) => {
      if (id) map[id] = 'albumArtist';
    });
    albumIds.forEach((id) => {
      if (id) map[id] = 'album';
    });
    playlistIds.forEach((id) => {
      if (id) map[id] = 'playlist';
    });
    genreIds.forEach((id) => {
      if (id) map[id] = 'genre';
    });
    artists
      .filter((a) => selectedTracks.has(a.Id))
      .forEach((a) => {
        names[a.Id] = a.Name;
      });
    albumArtists
      .filter((a) => selectedTracks.has(a.Id))
      .forEach((a) => {
        names[a.Id] = a.Name;
      });
    albums
      .filter((a) => selectedTracks.has(a.Id))
      .forEach((a) => {
        names[a.Id] = a.Name;
      });
    playlists
      .filter((p) => selectedTracks.has(p.Id))
      .forEach((p) => {
        names[p.Id] = p.Name;
      });
    genres
      .filter((g) => selectedTracks.has(g.Id))
      .forEach((g) => {
        names[g.Id] = g.Name;
      });
    return { artistIds, albumArtistIds, albumIds, playlistIds, genreIds, map, names };
  };

  // Items that are synced but user has deselected → will be removed from device
  const buildToDeleteIds = () => {
    return [...previouslySyncedItems].filter((id) => !selectedTracks.has(id));
  };

  // Build a type map for items to delete, using in-memory arrays first then DB info as fallback
  const buildDeleteTypesMap = (
    toDeleteIds: string[],
  ): Record<string, 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre'> => {
    const syncedInfoMap = new Map(syncedItemsInfo.map((i) => [i.id, i]));
    const map: Record<string, 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre'> = {};
    toDeleteIds.forEach((id) => {
      if (artists.find((a) => a.Id === id)) map[id] = 'artist';
      else if (albumArtists.find((a) => a.Id === id)) map[id] = 'albumArtist';
      else if (albums.find((a) => a.Id === id)) map[id] = 'album';
      else if (playlists.find((p) => p.Id === id)) map[id] = 'playlist';
      else if (genres.find((g) => g.Id === id)) map[id] = 'genre';
      else if (syncedInfoMap.has(id)) map[id] = syncedInfoMap.get(id)!.type;
    });
    return map;
  };

  const executeSyncNow = async (): Promise<void> => {
    if (!syncFolder || !jellyfinConfig || !userId) return;
    setShowPreview(false);
    setIsSyncing(true);
    setSyncProgress({ current: 0, total: 0, file: 'Validating...', phase: 'fetching' });

    const unsubscribe = window.api.onSyncProgress((progress) => {
      setSyncProgress((prev) =>
        prev
          ? {
              ...prev,
              current: progress.current,
              total: progress.total,
              file: progress.currentFile,
              phase: progress.phase,
              bytesProcessed: progress.bytesProcessed,
              totalBytes: progress.totalBytes,
              warning: progress.warning,
            }
          : null,
      );
      // Clean isCancelling when sync ends
      if (
        progress.phase === 'complete' ||
        progress.phase === 'error' ||
        progress.phase === 'cancelled'
      ) {
        setSyncProgress((prev) => (prev ? { ...prev, isCancelling: false } : null));
      }
    });

    try {
      const { artistIds, albumArtistIds, albumIds, playlistIds, genreIds, map, names } =
        buildItemTypesMap();
      const selectedIds = [
        ...artistIds,
        ...albumArtistIds,
        ...albumIds,
        ...playlistIds,
        ...genreIds,
      ].filter(Boolean);
      const toDeleteIds = buildToDeleteIds();

      if (toDeleteIds.length > 0) {
        setSyncProgress({
          current: 0,
          total: 0,
          file: 'Removing deselected items...',
          phase: 'fetching',
        });
        const deleteTypesMap = buildDeleteTypesMap(toDeleteIds);
        await window.api.removeItems({
          serverUrl: jellyfinConfig.url,
          apiKey: jellyfinConfig.apiKey,
          userId,
          itemIds: toDeleteIds,
          itemTypes: deleteTypesMap,
          destinationPath: syncFolder,
        });
      }

      // Delete-only operation: nothing left to sync
      if (selectedIds.length === 0) {
        unsubscribe?.();
        setSyncProgress(null);
        setIsSyncing(false);
        const updatedItems = await window.api.getSyncedItems(syncFolder);
        setPreviouslySyncedItems(updatedItems);
        setSyncSuccessData({
          tracksCopied: 0,
          tracksSkipped: 0,
          tracksRetagged: 0,
          lyricsAdded: 0,
          removed: toDeleteIds.length,
          errors: [],
          lyricsMode,
        });
        return;
      }

      const result = await window.api.startSync2({
        serverUrl: jellyfinConfig.url,
        apiKey: jellyfinConfig.apiKey,
        userId,
        itemIds: selectedIds,
        itemTypes: map,
        itemNames: names,
        destinationPath: syncFolder,
        options: { convertToMp3, bitrate, coverArtMode, lyricsMode },
      });

      unsubscribe?.();
      setSyncProgress(null);
      setIsSyncing(false);

      if (result.success) {
        const updatedItems = await window.api.getSyncedItems(syncFolder);
        setPreviouslySyncedItems(updatedItems);
        setSyncSuccessData({
          tracksCopied: result.tracksCopied,
          tracksSkipped: result.tracksSkipped ?? 0,
          tracksRetagged: result.tracksRetagged ?? 0,
          lyricsAdded: result.lyricsAdded,
          removed: toDeleteIds.length,
          errors: result.errors,
          lyricsMode,
        });
        // Re-run analyzeDiff in background to update out-of-sync indicators
        // Pass current coverArtMode to avoid stale ref in revalidateDevice
        void revalidateDevice({ coverArtMode });
      } else {
        setSyncSuccessData({
          tracksCopied: 0,
          tracksSkipped: 0,
          tracksRetagged: 0,
          lyricsAdded: 0,
          removed: 0,
          errors: result.errors,
        });
      }
    } catch (error: unknown) {
      unsubscribe?.();
      logger.error('Sync error: ' + (error instanceof Error ? error.message : String(error)));
      setSyncProgress(null);
      setIsSyncing(false);
      setSyncSuccessData({
        tracksCopied: 0,
        tracksSkipped: 0,
        tracksRetagged: 0,
        lyricsAdded: 0,
        removed: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      });
    }
  };

  const handleStartSync = (): void => {
    if (!syncFolder) {
      setSyncSuccessData({
        tracksCopied: 0,
        tracksSkipped: 0,
        tracksRetagged: 0,
        lyricsAdded: 0,
        removed: 0,
        errors: ['Please select a sync destination folder first'],
      });
      return;
    }
    if (!jellyfinConfig || !userId) {
      setSyncSuccessData({
        tracksCopied: 0,
        tracksSkipped: 0,
        tracksRetagged: 0,
        lyricsAdded: 0,
        removed: 0,
        errors: ['Not connected to Jellyfin'],
      });
      return;
    }

    const toDeleteIds = buildToDeleteIds();
    if (selectedTracks.size === 0 && toDeleteIds.length === 0) {
      setSyncSuccessData({
        tracksCopied: 0,
        tracksSkipped: 0,
        tracksRetagged: 0,
        lyricsAdded: 0,
        removed: 0,
        errors: ['Please select at least one item to sync'],
      });
      return;
    }

    // Delete-only: show preview with will-remove info, then sync
    if (selectedTracks.size === 0) {
      const willRemoveBytes = registry.countRemoveBytes(toDeleteIds, syncFolder);
      const willRemoveDurationSeconds = registry.calculateDuration(new Set(toDeleteIds));
      setPreviewData({
        trackCount: 0,
        totalBytes: 0,
        totalDurationSeconds: 0,
        formatBreakdown: {},
        newTracksCount: 0,
        newTracksBytes: 0,
        updatedTracksCount: 0,
        updatedTracksBytes: 0,
        alreadySyncedCount: 0,
        alreadySyncedBytes: 0,
        willRemoveCount: registry.countRemoveTracks(toDeleteIds, syncFolder),
        willRemoveBytes,
        willRemoveDurationSeconds,
      });
      setShowPreview(true);
      return;
    }

    // ── Build preview from already-computed data (no network calls) ───────
    //
    // SyncPanel already knows the state of every item (new/synced/outOfSync/remove)
    // via activateDevice → analyzeDiff. We just read from registry + outOfSyncItems.
    //
    const syncedIds = new Set(syncedItemsInfo.map((i) => i.id));
    const newItemIds = [...selectedTracks].filter((id) => !syncedIds.has(id));
    const updatedItemIds = [...selectedTracks].filter((id) => outOfSyncItems.has(id));
    const alreadySyncedItemIds = [...selectedTracks].filter(
      (id) => syncedIds.has(id) && !outOfSyncItems.has(id),
    );

    // Deduplicated track IDs across all selected items
    const allItemIds = [...selectedTracks];
    const seenTrackIds = new Set<string>();
    const itemTrackMap = new Map<string, Set<string>>(); // itemId -> trackIds (for size calculation)

    for (const itemId of allItemIds) {
      const trackIds = registry.getItemTrackIds(itemId);
      const uniqueTrackIds = new Set<string>();
      for (const tid of trackIds) {
        if (!seenTrackIds.has(tid)) {
          seenTrackIds.add(tid);
          uniqueTrackIds.add(tid);
        }
      }
      if (uniqueTrackIds.size > 0) {
        itemTrackMap.set(itemId, uniqueTrackIds);
      }
    }

    // Calculate deduplicated total duration
    const totalDurationSeconds = registry.calculateDuration(selectedTracks);

    // Calculate sizes using deduplicated track sets per category
    const newItemSet = new Set(newItemIds);
    const updatedItemSet = new Set(updatedItemIds);
    const alreadySyncedItemSet = new Set(alreadySyncedItemIds);
    const newTracksBytes =
      registry.calculateSize(newItemSet, syncFolder, convertToMp3, bitrate).total ?? 0;
    const updatedTracksBytes =
      registry.calculateSize(updatedItemSet, syncFolder, convertToMp3, bitrate).total ?? 0;
    const alreadySyncedBytes =
      registry.calculateSize(alreadySyncedItemSet, syncFolder, convertToMp3, bitrate).total ?? 0;
    const willRemoveBytes = registry.countRemoveBytes(toDeleteIds, syncFolder);

    const getItemName = (id: string): string =>
      artists.find((a) => a.Id === id)?.Name ??
      albumArtists.find((a) => a.Id === id)?.Name ??
      albums.find((a) => a.Id === id)?.Name ??
      playlists.find((p) => p.Id === id)?.Name ??
      genres.find((g) => g.Id === id)?.Name ??
      id;

    const getItemTrackCount = (id: string): number => {
      // 1. Registry (tracks fetched from Jellyfin via background fetch)
      const fromRegistry = registry.getItemTrackIds(id).length;
      if (fromRegistry > 0) return fromRegistry;
      // 2. deviceSyncedTracks — works for album-type items (tracks stored under albumId in DB)
      const fromDevice = registry.countSyncedItemTracks(id, syncFolder);
      if (fromDevice > 0) return fromDevice;
      // 3. ChildCount from library data (track count for albums/playlists)
      const album = albums.find((a) => a.Id === id);
      if (album?.ChildCount) return album.ChildCount;
      const playlist = playlists.find((p) => p.Id === id);
      if (playlist?.ChildCount) return playlist.ChildCount;
      // 4. For artists: sum ChildCount across their albums (background fetch skipped when convertToMp3=true)
      const artist = artists.find((a) => a.Id === id);
      if (artist) {
        const total = albums
          .filter((a) => a.AlbumArtist === artist.Name)
          .reduce((sum, a) => sum + (a.ChildCount ?? 0), 0);
        if (total > 0) return total;
      }
      // 5. For album artists: sum ChildCount across their albums
      const albumArtist = albumArtists.find((a) => a.Id === id);
      if (albumArtist) {
        const total = albums
          .filter((a) => a.AlbumArtist === albumArtist.Name)
          .reduce((sum, a) => sum + (a.ChildCount ?? 0), 0);
        if (total > 0) return total;
      }
      return 0;
    };

    // isTickEstimate is the authoritative signal: when true, size was computed from
    // RunTimeTicks because the background fetch was skipped (>MAX_UNCACHED_FETCH_COUNT).
    // In that state, track counts from getItemTrackCount fallbacks are unreliable.
    const isTrackCountEstimate = isTickEstimate && newItemIds.length > 0;

    // Deduplicated track counts by category.
    // Prefer itemTrackMap (deduplication-aware) when available; fall back to
    // getItemTrackCount (ChildCount / registry) for items not yet fetched
    // (e.g. brand-new items when convertToMp3=true skips background fetch).
    const newTracksCount = newItemIds.reduce(
      (sum, id) => sum + (itemTrackMap.get(id)?.size ?? getItemTrackCount(id)),
      0,
    );
    const updatedTracksCount = updatedItemIds.reduce(
      (sum, id) => sum + (itemTrackMap.get(id)?.size ?? getItemTrackCount(id)),
      0,
    );
    const alreadySyncedTracksCount = alreadySyncedItemIds.reduce(
      (sum, id) => sum + (itemTrackMap.get(id)?.size ?? getItemTrackCount(id)),
      0,
    );
    const willRemoveCount = toDeleteIds.reduce(
      (sum, id) => sum + (itemTrackMap.get(id)?.size ?? getItemTrackCount(id)),
      0,
    );

    const buildItemPreviews = (
      ids: string[],
      getSizeBytes: (id: string) => number,
    ): ItemPreview[] =>
      ids.map((id) => ({
        id,
        name: getItemName(id),
        trackCount: getItemTrackCount(id),
        sizeBytes: getSizeBytes(id),
        durationSeconds: registry.calculateDuration(new Set([id])),
      }));

    const newItems = buildItemPreviews(
      newItemIds,
      (id) => registry.calculateSize(new Set([id]), syncFolder, convertToMp3, bitrate).total ?? 0,
    );
    const updatedItems = buildItemPreviews(
      updatedItemIds,
      (id) => registry.calculateSize(new Set([id]), syncFolder, convertToMp3, bitrate).total ?? 0,
    );
    const alreadySyncedItems = buildItemPreviews(
      alreadySyncedItemIds,
      (id) => registry.calculateSize(new Set([id]), syncFolder, convertToMp3, bitrate).total ?? 0,
    );
    const removedItems = buildItemPreviews(toDeleteIds, (id) =>
      registry.countRemoveBytes([id], syncFolder),
    );

    setPreviewData({
      trackCount: seenTrackIds.size,
      totalBytes: newTracksBytes + updatedTracksBytes + alreadySyncedBytes,
      totalDurationSeconds,
      formatBreakdown: {},
      newTracksCount,
      newTracksBytes,
      newTracksDurationSeconds: registry.calculateDuration(newItemSet),
      updatedTracksCount,
      updatedTracksBytes,
      updatedTracksDurationSeconds: registry.calculateDuration(updatedItemSet),
      alreadySyncedCount: alreadySyncedTracksCount,
      alreadySyncedBytes,
      alreadySyncedDurationSeconds: registry.calculateDuration(alreadySyncedItemSet),
      willRemoveCount,
      willRemoveBytes,
      willRemoveDurationSeconds: registry.calculateDuration(new Set(toDeleteIds)),
      newItems,
      updatedItems,
      alreadySyncedItems,
      removedItems,
      isTrackCountEstimate,
    });
    setShowPreview(true);
  };

  const handleCancelSync = async (): Promise<void> => {
    setSyncProgress((prev) => (prev ? { ...prev, isCancelling: true } : null));
    try {
      await window.api.cancelSync();
    } catch (error) {
      logger.error(
        'Cancel sync error: ' + (error instanceof Error ? error.message : String(error)),
      );
    }
  };

  return {
    syncFolder,
    setSyncFolder,
    convertToMp3,
    setConvertToMp3,
    bitrate,
    setBitrate,
    coverArtMode,
    setCoverArtMode,
    lyricsMode,
    setLyricsMode,
    isSyncing,
    syncProgress,
    showPreview,
    setShowPreview,
    previewData,
    syncSuccessData,
    setSyncSuccessData,
    handleSelectSyncFolder,
    executeSyncNow,
    handleStartSync,
    handleCancelSync,
  };
}
