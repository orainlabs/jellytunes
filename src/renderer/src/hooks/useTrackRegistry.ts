/**
 * useTrackRegistry - In-memory cache for track metadata
 *
 * Avoids repeated Jellyfin API calls by caching track info per item.
 * Global cache across devices, per-device synced track state.
 * Tick-based estimation for immediate UI without HTTP calls.
 */

import { logger } from '@/utils/logger';

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
  /** Track duration in seconds */
  durationSeconds?: number;
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
  // RunTimeTicks per item (from library fetch — no extra HTTP calls)
  itemTicks: Map<string, number>;
  // Item types by id (for batch fetch)
  itemTypes: Map<string, 'artist' | 'albumArtist' | 'album' | 'playlist'>;
  // Whether background fetch is in-flight for a given device+selection key
  isBackgroundFetching: Map<string, boolean>;
  // AbortController for cancelling in-flight background fetches
  backgroundAbortControllers: Map<string, AbortController>;
}

const LOSSLESS_FORMATS = new Set(['flac', 'wav', 'aiff', 'alac', 'wv', 'ape']);
const FALLBACK_LOSSLESS_BPS = 900000; // ~900kbps for lossless
const FALLBACK_COMPRESSED_BPS = 192000; // ~192kbps for compressed audio

/**
 * Estimation constant: bytes per tick for lossless (≈280 kbps).
 * More optimistic than true lossless to avoid overestimation when
 * the library contains non-lossless content (MP3, AAC, OGG, etc.).
 * 1 tick = 100 nanoseconds = 10_000_000 ticks per second.
 * 280 kbps = 35_000 bytes/s → 35_000 / 10_000_000 = 0.0035 bytes/tick.
 */
export const BYTES_PER_TICK_LOSSLESS = 0.0035;

/**
 * Estimation constants: bytes per tick for MP3 conversion.
 * 1 tick = 100 nanoseconds = 10_000_000 ticks per second.
 * MP3 bytes/second = bitrate_bps / 8.
 */
export const BYTES_PER_TICK_MP3: Record<string, number> = {
  '128k': 0.0016, // 128_000 / 8 / 10_000_000 = 0.0016
  '192k': 0.0024, // 192_000 / 8 / 10_000_000 = 0.0024
  '320k': 0.004, // 320_000 / 8 / 10_000_000 = 0.004
};

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

/**
 * Estimate size from RunTimeTicks when track data is not cached.
 * Used for immediate UI feedback before background fetch completes.
 */
function estimateSizeFromTicks(ticks: number, convertToMp3: boolean, bitrate?: string): number {
  if (!ticks || ticks <= 0) return 0;
  if (convertToMp3) {
    const bytesPerTick = bitrate
      ? (BYTES_PER_TICK_MP3[bitrate] ?? BYTES_PER_TICK_MP3['192k'])
      : BYTES_PER_TICK_MP3['192k'];
    return Math.round(ticks * bytesPerTick);
  }
  return Math.round(ticks * BYTES_PER_TICK_LOSSLESS);
}

export function createTrackRegistry() {
  const state: TrackRegistryState = {
    trackMap: new Map(),
    itemTracks: new Map(),
    deviceSyncedTracks: new Map(),
    isLoadingDevice: new Map(),
    generation: 0,
    itemTicks: new Map(),
    itemTypes: new Map(),
    isBackgroundFetching: new Map(),
    backgroundAbortControllers: new Map(),
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
   * Store RunTimeTicks for items (already available from library fetch — no extra HTTP calls).
   * Also store item type for batch fetch lookup.
   */
  const setItemTicks = (
    items: Array<{
      id: string;
      ticks: number;
      type: 'artist' | 'albumArtist' | 'album' | 'playlist';
    }>,
  ) => {
    for (const item of items) {
      state.itemTicks.set(item.id, item.ticks);
      state.itemTypes.set(item.id, item.type);
    }
  };

  /**
   * Store item types for batch fetch lookup.
   */
  const setItemTypes = (
    items: Array<{ id: string; type: 'artist' | 'albumArtist' | 'album' | 'playlist' }>,
  ) => {
    for (const item of items) {
      state.itemTypes.set(item.id, item.type);
    }
  };

  /**
   * @deprecated Use {@link fetchTracksForItems} instead. This function is no longer
   * called from the renderer after ORAIN-0478 — background fetch now uses
   * fetchTracksForItems exclusively.
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
      logger.warn(`getTracksForItem errors: ${JSON.stringify(result.errors)}`);
    }

    const trackIds: string[] = [];
    for (const track of result.tracks) {
      state.trackMap.set(track.id, track);
      trackIds.push(track.id);
    }
    state.itemTracks.set(itemId, trackIds);
  }

  /**
   * Background batch fetch for tracks using Jellyfin batch endpoints.
   * Uses albumIds / AlbumArtistIds with Limit=1000 + pagination.
   * Cancels previous fetch if selection changes.
   * @returns true if fetch succeeded, false if cancelled or failed.
   */
  const fetchTracksForItems = async (
    itemIds: string[],
    devicePath: string,
    jellyfinConfig: { serverUrl: string; apiKey: string; userId: string },
  ): Promise<boolean> => {
    // Cancel any in-flight fetch for this device
    const prevController = state.backgroundAbortControllers.get(devicePath);
    if (prevController) {
      prevController.abort();
    }

    const controller = new AbortController();
    state.backgroundAbortControllers.set(devicePath, controller);
    state.isBackgroundFetching.set(devicePath, true);

    try {
      const itemTypesRecord = Object.fromEntries(state.itemTypes.entries()) as Record<
        string,
        'artist' | 'album' | 'playlist' | 'albumArtist'
      >;
      const result = await window.api.getTracksForItems({
        serverUrl: jellyfinConfig.serverUrl,
        apiKey: jellyfinConfig.apiKey,
        userId: jellyfinConfig.userId,
        itemIds,
        itemTypes: itemTypesRecord,
      });

      if (controller.signal.aborted) return false;

      if (result.errors.length > 0) {
        logger.warn(`getTracksForItems batch errors: ${JSON.stringify(result.errors)}`);
      }

      for (const track of result.tracks) {
        if (controller.signal.aborted) return false;
        state.trackMap.set(track.id, track);
      }

      // Group tracks by parent item (parentItemId = artist/playlist id, albumId = album id)
      const itemTrackGroups = new Map<string, string[]>();
      for (const track of result.tracks) {
        const parentId = track.parentItemId ?? '';
        if (!parentId) continue;
        const group = itemTrackGroups.get(parentId) ?? [];
        group.push(track.id);
        itemTrackGroups.set(parentId, group);
      }

      for (const [itemId, trackIds] of itemTrackGroups) {
        if (controller.signal.aborted) return false;
        state.itemTracks.set(itemId, trackIds);
      }

      // Mark items with 0 tracks as fetched so they aren't re-fetched on next selection
      for (const itemId of itemIds) {
        if (!state.itemTracks.has(itemId)) state.itemTracks.set(itemId, []);
      }

      return true;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return false;
      logger.warn(`fetchTracksForItems failed: ${err}`);
      // On failure, leave tick estimate; button will be enabled
      return false;
    } finally {
      if (!controller.signal.aborted) {
        state.isBackgroundFetching.delete(devicePath);
        state.backgroundAbortControllers.delete(devicePath);
      }
    }
  };

  /**
   * Calculate total size for selected items on a device.
   * Uses tick-based estimation for uncached items (immediate, no HTTP calls).
   * When convertToMp3=true, never fetches — always estimates.
   */
  const calculateSize = (
    selectedItems: Set<string>,
    devicePath: string,
    convertToMp3: boolean,
    bitrate?: string,
  ): { total: number | null; isTickEstimate: boolean } => {
    const syncedTracks = state.deviceSyncedTracks.get(devicePath);
    if (!syncedTracks) return { total: null, isTickEstimate: false };

    let total = 0;
    let usedTicks = false;

    for (const itemId of selectedItems) {
      if (state.itemTracks.has(itemId)) {
        // Tracks fetched from server — use real sizes (may be 0 if artist has no indexed albums)
        const trackIds = state.itemTracks.get(itemId)!;
        for (const trackId of trackIds) {
          const synced = syncedTracks.get(trackId);
          const info = state.trackMap.get(trackId);

          if (synced) {
            // Already synced - estimate if converting to MP3
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
      } else {
        // Not yet fetched — use tick-based estimation
        const ticks = state.itemTicks.get(itemId) ?? 0;
        total += estimateSizeFromTicks(ticks, convertToMp3, bitrate);
        if (ticks > 0) usedTicks = true;
      }
    }

    return { total: total > 0 ? total : null, isTickEstimate: usedTicks };
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
   * Count synced tracks for a specific item from deviceSyncedTracks.
   * Needed for artist-type items whose tracks are stored under albumId (parentItemId),
   * not under artistId, so getItemTrackIds(artistId) returns [].
   */
  const countSyncedItemTracks = (itemId: string, devicePath: string): number => {
    const syncedTracks = state.deviceSyncedTracks.get(devicePath);
    if (!syncedTracks) return 0;
    let count = 0;
    for (const { itemId: trackedItemId } of syncedTracks.values()) {
      if (trackedItemId === itemId) count++;
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

  const countRemoveTracks = (toDeleteIds: string[], devicePath: string): number => {
    const syncedTracks = state.deviceSyncedTracks.get(devicePath);
    if (!syncedTracks || toDeleteIds.length === 0) return 0;
    const deleteSet = new Set(toDeleteIds);
    let count = 0;
    for (const { itemId } of syncedTracks.values()) {
      if (deleteSet.has(itemId)) count++;
    }
    return count;
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
    state.itemTicks.clear();
    state.itemTypes.clear();
    state.isBackgroundFetching.clear();
    // Abort any in-flight background fetches
    for (const controller of state.backgroundAbortControllers.values()) {
      controller.abort();
    }
    state.backgroundAbortControllers.clear();
    // Note: deviceSyncedTracks is NOT cleared — it contains DB data that's still valid
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
    // Abort any background fetch for this device
    const controller = state.backgroundAbortControllers.get(devicePath);
    if (controller) {
      controller.abort();
      state.backgroundAbortControllers.delete(devicePath);
    }
    state.isBackgroundFetching.delete(devicePath);
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

  /** Returns true if tracks for this item have been fetched (even if 0 tracks). */
  const hasItemTracks = (itemId: string): boolean => state.itemTracks.has(itemId);

  /**
   * Get the registered type for an item (from setItemTicks/setItemTypes), if known.
   * Used to decide whether a newly-selected item can be batch-fetched.
   */
  const getItemType = (
    itemId: string,
  ): 'artist' | 'albumArtist' | 'album' | 'playlist' | undefined => {
    return state.itemTypes.get(itemId);
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

  const TICKS_PER_SECOND = 10_000_000;

  /**
   * Calculate total duration for selected items, deduplicating shared tracks.
   * Falls back to RunTimeTicks in two cases (same pattern as calculateSize):
   * 1. No tracks cached at all for the item
   * 2. Tracks cached but none have durationSeconds (loaded from device DB without duration)
   * Returns total duration in seconds.
   */
  const calculateDuration = (selectedItems: Set<string>): number => {
    const seenTrackIds = new Set<string>();
    let totalSeconds = 0;

    for (const itemId of selectedItems) {
      const trackIds = state.itemTracks.get(itemId);

      if (trackIds && trackIds.length > 0) {
        let itemSeconds = 0;
        for (const trackId of trackIds) {
          if (seenTrackIds.has(trackId)) continue;
          seenTrackIds.add(trackId);
          const info = state.trackMap.get(trackId);
          if (info?.durationSeconds) itemSeconds += info.durationSeconds;
        }
        if (itemSeconds > 0) {
          totalSeconds += itemSeconds;
        } else {
          // Tracks present but no durationSeconds — fall back to item ticks
          const ticks = state.itemTicks.get(itemId) ?? 0;
          if (ticks > 0) totalSeconds += ticks / TICKS_PER_SECOND;
        }
      } else {
        // No cached tracks — fall back to item-level RunTimeTicks
        const ticks = state.itemTicks.get(itemId) ?? 0;
        if (ticks > 0) totalSeconds += ticks / TICKS_PER_SECOND;
      }
    }
    return totalSeconds;
  };

  return {
    loadDeviceSyncedTracks,
    ensureItemTracks,
    setItemTicks,
    setItemTypes,
    fetchTracksForItems,
    calculateSize,
    countNewTracks,
    countRemoveBytes,
    countRemoveTracks,
    countSyncedItemTracks,
    getSyncedMusicBytes,
    invalidateAll,
    invalidateItem,
    invalidateDevice,
    isDeviceLoading,
    getItemTrackIds,
    hasItemTracks,
    getItemType,
    hasFlacOrM4a,
    calculateDuration,
  };
}

export type TrackRegistry = ReturnType<typeof createTrackRegistry>;

// Singleton instance shared across the app
let registryInstance: TrackRegistry | null = null;

export function getTrackRegistry(): TrackRegistry {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- singleton pattern: null check is explicit
  if (registryInstance === null) {
    registryInstance = createTrackRegistry();
  }
  return registryInstance;
}
