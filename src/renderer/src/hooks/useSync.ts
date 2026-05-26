import { useState } from 'react';
import type {
  JellyfinConfig,
  Artist,
  Album,
  Playlist,
  Bitrate,
  SyncProgressInfo,
  PreviewData,
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
  previouslySyncedItems: Set<string>;
  syncedItemsInfo: SyncedItemInfo[];
  outOfSyncItems: Set<string>;
  artists: Artist[];
  albums: Album[];
  playlists: Playlist[];
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
  previouslySyncedItems,
  syncedItemsInfo,
  outOfSyncItems,
  artists,
  albums,
  playlists,
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
    const artistIds = artists.filter((a) => selectedTracks.has(a.Id)).map((a) => a.Id);
    const albumIds = albums.filter((a) => selectedTracks.has(a.Id)).map((a) => a.Id);
    const playlistIds = playlists.filter((p) => selectedTracks.has(p.Id)).map((p) => p.Id);
    const map: Record<string, 'artist' | 'album' | 'playlist'> = {};
    const names: Record<string, string> = {};
    artistIds.forEach((id) => {
      if (id) map[id] = 'artist';
    });
    albumIds.forEach((id) => {
      if (id) map[id] = 'album';
    });
    playlistIds.forEach((id) => {
      if (id) map[id] = 'playlist';
    });
    artists
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
    return { artistIds, albumIds, playlistIds, map, names };
  };

  // Items that are synced but user has deselected → will be removed from device
  const buildToDeleteIds = () => {
    return [...previouslySyncedItems].filter((id) => !selectedTracks.has(id));
  };

  // Build a type map for items to delete, using in-memory arrays first then DB info as fallback
  const buildDeleteTypesMap = (
    toDeleteIds: string[],
  ): Record<string, 'artist' | 'album' | 'playlist'> => {
    const syncedInfoMap = new Map(syncedItemsInfo.map((i) => [i.id, i]));
    const map: Record<string, 'artist' | 'album' | 'playlist'> = {};
    toDeleteIds.forEach((id) => {
      if (artists.find((a) => a.Id === id)) map[id] = 'artist';
      else if (albums.find((a) => a.Id === id)) map[id] = 'album';
      else if (playlists.find((p) => p.Id === id)) map[id] = 'playlist';
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
      const { artistIds, albumIds, playlistIds, map, names } = buildItemTypesMap();
      const selectedIds = [...artistIds, ...albumIds, ...playlistIds].filter(Boolean);
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

    // Delete-only: skip preview and go straight to sync
    if (selectedTracks.size === 0) {
      void executeSyncNow();
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
      registry.calculateSize(newItemSet, syncFolder, convertToMp3, bitrate) ?? 0;
    const updatedTracksBytes =
      registry.calculateSize(updatedItemSet, syncFolder, convertToMp3, bitrate) ?? 0;
    const alreadySyncedBytes =
      registry.calculateSize(alreadySyncedItemSet, syncFolder, convertToMp3, bitrate) ?? 0;
    const willRemoveCount = toDeleteIds.length;
    const willRemoveBytes = registry.countRemoveBytes(toDeleteIds, syncFolder);

    // Deduplicated track counts by category
    // Use itemTrackMap (deduplicated) if available, otherwise 0.
    // If itemTrackMap has no entry for an item, all its tracks were already
    // counted via earlier items — they don't contribute to this category's unique total.
    const newTracksCount = newItemIds.reduce(
      (sum, id) => sum + (itemTrackMap.get(id)?.size ?? 0),
      0,
    );
    const updatedTracksCount = updatedItemIds.reduce(
      (sum, id) => sum + (itemTrackMap.get(id)?.size ?? 0),
      0,
    );
    const alreadySyncedTracksCount = alreadySyncedItemIds.reduce(
      (sum, id) => sum + (itemTrackMap.get(id)?.size ?? 0),
      0,
    );

    setPreviewData({
      trackCount: seenTrackIds.size,
      totalBytes: newTracksBytes + updatedTracksBytes + alreadySyncedBytes,
      totalDurationSeconds,
      formatBreakdown: {},
      newTracksCount,
      newTracksBytes,
      updatedTracksCount,
      updatedTracksBytes,
      alreadySyncedCount: alreadySyncedTracksCount,
      alreadySyncedBytes,
      willRemoveCount,
      willRemoveBytes,
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
