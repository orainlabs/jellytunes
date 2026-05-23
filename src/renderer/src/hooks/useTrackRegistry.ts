/**
 * useTrackRegistry - In-memory cache for track metadata
 *
 * Avoids repeated Jellyfin API calls by caching track info per item.
 * Global cache across devices, per-device synced track state.
 */

export interface TrackInfo {
  id: string;
  name: string;
  path: string;
  size?: number;
  format: string;
  bitrate?: number;
  album?: string;
  artists?: string[];
  albumArtist?: string;
  parentItemId?: string;
}

export interface SyncedTrackRecord {
  trackId: string;
  itemId: string;
  fileSize: number;
  destinationPath: string;
}

interface TrackRegistryState {
  // Global: track info by trackId
  trackMap: Map<string, TrackInfo>;
  // Global: trackIds by itemId
  itemTracks: Map<string, string[]>;
  // Per device: synced tracks with DB file sizes
  deviceSyncedTracks: Map<string, Map<string, { fileSize: number; itemId: string }>>;
  // Loading state per device
  isLoadingDevice: Map<string, boolean>;
  // Generation counter for library refresh invalidation
  generation: number;
}

const LOSSLESS_FORMATS = new Set(['flac', 'wav', 'aiff', 'alac', 'wv', 'ape']);
const FALLBACK_LOSSLESS_BPS = 900000; // ~900kbps for lossless
const FALLBACK_COMPRESSED_BPS = 192000; // ~192kbps for compressed audio

function estimateMp3Size(
  originalBytes: number,
  originalBitrate?: number,
  targetBitrate?: string,
  format?: string,
): number {
  if (!originalBytes) return 0;
  const target = targetBitrate === '128k' ? 128000 : targetBitrate === '320k' ? 320000 : 192000;
  if (originalBitrate) {
    return Math.round(originalBytes * (target / originalBitrate));
  }
  // No bitrate available — use format to pick a sensible fallback
  const isLossless = format ? LOSSLESS_FORMATS.has(format.toLowerCase()) : true;
  const source = isLossless ? FALLBACK_LOSSLESS_BPS : FALLBACK_COMPRESSED_BPS;
  return Math.round(originalBytes * (target / source));
}

export function createTrackRegistry() {
  const state: TrackRegistryState = {
    trackMap: new Map(),
    itemTracks: new Map(),
    deviceSyncedTracks: new Map(),
    isLoadingDevice: new Map(),
    generation: 0,
  };

  // Pending fetches to dedupe concurrent requests for the same item
  const pendingFetches = new Map<string, Promise<void>>();

  /**
   * Load synced tracks for a device from DB.
   * Also populates itemTracks for synced items so calculateSize works without Jellyfin calls.
   * Pass forceReload=true to refresh after a sync completes.
   */
  const loadDeviceSyncedTracks = async (devicePath: string, forceReload = false): Promise<void> => {
    if (!forceReload && state.deviceSyncedTracks.has(devicePath)) {
      // Already loaded, just mark as not loading
      state.isLoadingDevice.set(devicePath, false);
      return;
    }

    state.isLoadingDevice.set(devicePath, true);

    try {
      const records = await window.api.getSyncedTracks(devicePath);
      const syncedMap = new Map<string, { fileSize: number; itemId: string }>();
      // Also build itemTracks from DB records (itemId → trackId[])
      const itemTracksFromDb = new Map<string, string[]>();
      for (const rec of records) {
        syncedMap.set(rec.trackId, { fileSize: rec.fileSize, itemId: rec.itemId });
        const existing = itemTracksFromDb.get(rec.itemId) ?? [];
        existing.push(rec.trackId);
        itemTracksFromDb.set(rec.itemId, existing);
      }
      state.deviceSyncedTracks.set(devicePath, syncedMap);
      // Merge into itemTracks (don't overwrite entries already fetched from Jellyfin)
      for (const [itemId, trackIds] of itemTracksFromDb) {
        if (!state.itemTracks.has(itemId)) {
          state.itemTracks.set(itemId, trackIds);
        }
      }
    } finally {
      state.isLoadingDevice.set(devicePath, false);
    }
  };

  /**
   * Fetch tracks for an item from Jellyfin if not already cached
   */
  const ensureItemTracks = async (
    itemId: string,
    itemType: 'artist' | 'album' | 'playlist',
    jellyfinConfig: { serverUrl: string; apiKey: string; userId: string },
  ): Promise<void> => {
    // Already have this item's tracks?
    if (state.itemTracks.has(itemId)) return;

    // Already fetching this item?
    if (pendingFetches.has(itemId)) {
      return pendingFetches.get(itemId)!;
    }

    const currentGen = state.generation;
    const p = _fetchAndStore(itemId, itemType, jellyfinConfig, currentGen).finally(() =>
      pendingFetches.delete(itemId),
    );
    pendingFetches.set(itemId, p);
    return p;
  };

  async function _fetchAndStore(
    itemId: string,
    itemType: 'artist' | 'album' | 'playlist',
    jellyfinConfig: { serverUrl: string; apiKey: string; userId: string },
    generation: number,
  ): Promise<void> {
    // Check if stale before fetching
    if (generation !== state.generation) return;

    const result = await window.api.getTracksForItem({
      serverUrl: jellyfinConfig.serverUrl,
      apiKey: jellyfinConfig.apiKey,
      userId: jellyfinConfig.userId,
      itemId,
      itemType,
    });

    // Check again after fetch in case generation changed during the async call
    if (generation !== state.generation) return;

    if (result.errors.length > 0) {
      console.warn('getTracksForItem errors:', result.errors);
    }

    const trackIds: string[] = [];
    for (const track of result.tracks) {
      state.trackMap.set(track.id, track);
      trackIds.push(track.id);
    }
    state.itemTracks.set(itemId, trackIds);
  }

  /**
   * Calculate total size for selected items on a device
   */
  const calculateSize = (
    selectedItems: Set<string>,
    devicePath: string,
    convertToMp3: boolean,
    bitrate?: string,
  ): number | null => {
    const syncedTracks = state.deviceSyncedTracks.get(devicePath);
    if (!syncedTracks) return null; // device not loaded yet

    let total = 0;
    for (const itemId of selectedItems) {
      const trackIds = state.itemTracks.get(itemId);
      if (!trackIds) continue; // item not loaded yet

      for (const trackId of trackIds) {
        const synced = syncedTracks.get(trackId);
        const info = state.trackMap.get(trackId);

        if (synced) {
          // Already synced - estimate if converting to MP3
          const info = state.trackMap.get(trackId);
          total += convertToMp3
            ? estimateMp3Size(synced.fileSize, info?.bitrate, bitrate, info?.format)
            : synced.fileSize;
        } else if (info?.size) {
          // Not synced yet - use server size
          total += convertToMp3
            ? estimateMp3Size(info.size, info.bitrate, bitrate, info?.format)
            : info.size;
        }
      }
    }
    return total;
  };

  /**
   * Get track count for selected items (new tracks only, not already synced)
   */
  const countNewTracks = (selectedItems: Set<string>, devicePath: string): number => {
    const syncedTracks = state.deviceSyncedTracks.get(devicePath);
    if (!syncedTracks) return 0;

    let count = 0;
    for (const itemId of selectedItems) {
      const trackIds = state.itemTracks.get(itemId);
      if (!trackIds) continue;

      for (const trackId of trackIds) {
        if (!syncedTracks.has(trackId)) {
          count++;
        }
      }
    }
    return count;
  };

  /**
   * Compute total bytes of tracks belonging to items being removed.
   * Iterates deviceSyncedTracks to find tracks whose itemId is in the delete set.
   */
  const countRemoveBytes = (toDeleteIds: string[], devicePath: string): number => {
    const syncedTracks = state.deviceSyncedTracks.get(devicePath);
    if (!syncedTracks || toDeleteIds.length === 0) return 0;
    const deleteSet = new Set(toDeleteIds);
    let total = 0;
    for (const { fileSize, itemId } of syncedTracks.values()) {
      if (deleteSet.has(itemId)) total += fileSize;
    }
    return total;
  };

  /**
   * Get total size of already-synced tracks for a device
   */
  const getSyncedMusicBytes = (devicePath: string): number => {
    const syncedTracks = state.deviceSyncedTracks.get(devicePath);
    if (!syncedTracks) return 0;
    let total = 0;
    for (const { fileSize } of syncedTracks.values()) {
      total += fileSize;
    }
    return total;
  };

  /**
   * Invalidate all cached data (library refresh)
   */
  const invalidateAll = () => {
    state.generation++;
    state.itemTracks.clear();
    state.trackMap.clear();
    // Note: deviceSyncedTracks is NOT cleared - it contains DB data that's still valid
    pendingFetches.clear();
  };

  /**
   * Invalidate tracks for a specific item (force re-fetch on next selection)
   */
  const invalidateItem = (itemId: string) => {
    state.itemTracks.delete(itemId);
    // Note: we keep trackMap entries as they may still be referenced by deviceSyncedTracks
  };

  /**
   * Invalidate device state (on disconnect)
   */
  const invalidateDevice = (devicePath: string) => {
    state.deviceSyncedTracks.delete(devicePath);
    state.isLoadingDevice.delete(devicePath);
  };

  /**
   * Check if a device's synced tracks are loaded
   */
  const isDeviceLoading = (devicePath: string): boolean => {
    return state.isLoadingDevice.get(devicePath) ?? false;
  };

  /**
   * Get all cached track IDs for an item
   */
  const getItemTrackIds = (itemId: string): string[] => {
    return state.itemTracks.get(itemId) ?? [];
  };

  /**
   * Check if any selected item has at least one FLAC or M4A track.
   * Returns true when lyricsMode='embed' would embed plain text (no timestamps).
   */
  const hasFlacOrM4a = (selectedItemIds: Set<string>): boolean => {
    const lossyOrLossless = new Set(['flac', 'm4a', 'alac']);
    for (const itemId of selectedItemIds) {
      const trackIds = state.itemTracks.get(itemId);
      if (!trackIds) continue;
      for (const trackId of trackIds) {
        const info = state.trackMap.get(trackId);
        if (info?.format && lossyOrLossless.has(info.format.toLowerCase())) {
          return true;
        }
      }
    }
    return false;
  };

  return {
    loadDeviceSyncedTracks,
    ensureItemTracks,
    calculateSize,
    countNewTracks,
    countRemoveBytes,
    getSyncedMusicBytes,
    invalidateAll,
    invalidateItem,
    invalidateDevice,
    isDeviceLoading,
    getItemTrackIds,
    hasFlacOrM4a,
  };
}

export type TrackRegistry = ReturnType<typeof createTrackRegistry>;

// Singleton instance shared across the app
let registryInstance: TrackRegistry | null = null;

export function getTrackRegistry(): TrackRegistry {
  registryInstance ??= createTrackRegistry();
  return registryInstance;
}
