import { useState, useCallback, useRef, useMemo, useReducer } from 'react';
import { getTrackRegistry } from './useTrackRegistry';
import { logger } from '@/utils/logger';

/** Threshold to prevent HTTP flood when selecting large numbers of items.
 *  Selecting >50 uncached items skips the batch fetch and relies on tick-based estimation.
 *  Users can deselect items below this threshold to trigger a real fetch. */
export const MAX_UNCACHED_FETCH_COUNT = 50;

/** Check if uncached fetch should be skipped due to exceeding threshold.
 *  Emits a logger.warn when threshold is exceeded.
 *  @returns true if fetch should be skipped, false if it should proceed */
export function shouldSkipUncachedFetch(uncachedIds: string[]): boolean {
  if (uncachedIds.length === 0) return true;
  if (uncachedIds.length > MAX_UNCACHED_FETCH_COUNT) {
    logger.warn(
      `[useDeviceSelections] Skipping fetch: ${uncachedIds.length} uncached items exceed threshold of ${MAX_UNCACHED_FETCH_COUNT}`,
    );
    return true;
  }
  return false;
}

export interface SyncedItemInfo {
  id: string;
  name: string;
  type: 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre';
}

interface DeviceState {
  selectedArtists: Set<string>;
  selectedAlbumArtists: Set<string>;
  selectedItems: Set<string>;
  syncedItems: Set<string>;
  syncedItemsInfo: SyncedItemInfo[];
  outOfSyncItems: Set<string>;
  syncedMusicBytes: number | null;
  isActivatingDevice: boolean;
}

const EMPTY: DeviceState = {
  selectedArtists: new Set(),
  selectedAlbumArtists: new Set(),
  selectedItems: new Set(),
  syncedItems: new Set(),
  syncedItemsInfo: [],
  outOfSyncItems: new Set(),
  syncedMusicBytes: null,
  isActivatingDevice: false,
};

/** ORAIN-0534: build unified selectedItems set from the typed subsets.
 *  Artists and album-artists live in their own sets to avoid cross-leak when the same
 *  Jellyfin ID appears in both views. selectedItems is the union used by downstream
 *  consumers (size estimation, fetch threshold, etc.) that don't care about the type. */
function unionSelections(
  artists: Set<string>,
  albumArtists: Set<string>,
  others: Set<string>,
): Set<string> {
  const result = new Set<string>();
  for (const id of artists) result.add(id);
  for (const id of albumArtists) result.add(id);
  for (const id of others) result.add(id);
  return result;
}

/** Build a cache key from path+options to detect unchanged re-activations */
function buildActivationKey(
  path: string,
  options?: {
    itemIds: string[];
    itemTypes: Record<string, 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre'>;
    convertToMp3: boolean;
    bitrate: '128k' | '192k' | '320k';
    coverArtMode?: 'off' | 'embed' | 'companion';
  },
): string | null {
  if (!options) return null;
  const sortedIds = [...options.itemIds].sort().join(',');
  return `${path}:${sortedIds}:${options.convertToMp3}:${options.bitrate}:${options.coverArtMode ?? 'embed'}`;
}

export function useDeviceSelections() {
  const registry = useMemo(() => getTrackRegistry(), []);
  // Bumped whenever registry internal state changes (tracks loaded) to re-trigger estimatedSizeBytes
  const [registryVersion, bumpRegistryVersion] = useReducer((v: number) => v + 1, 0);

  const [deviceStates, setDeviceStates] = useState<Map<string, DeviceState>>(new Map());
  const [activeDevicePath, setActiveDevicePath] = useState<string | null>(null);
  // Tracks in-flight ensureItemTracks calls so UI can show loading indicator
  const [sizeLoadingCount, setSizeLoadingCount] = useState(0);
  // Track last activation key to skip unnecessary re-analysis
  const lastActivationKeyRef = useRef<string | null>(null);
  // Track in-flight activation to avoid duplicate getSyncedItems calls
  const activatingRef = useRef<Set<string>>(new Set());
  // Store last activation options so revalidateDevice can reuse them
  const lastOptionsRef = useRef<Parameters<typeof activateDevice>[1] | null>(null);
  // Track previous convertToMp3 value to detect true→false transitions (launch background fetch)
  const prevConvertToMp3Ref = useRef<boolean | null>(null);
  // Debounce timer for fetchSelectedUncachedTracks — prevents HTTP flood on rapid selection
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeState = activeDevicePath ? (deviceStates.get(activeDevicePath) ?? EMPTY) : EMPTY;

  // Compute estimated size from registry (derived, not stored)
  // Returns { total, isTickEstimate } to avoid storing isTickEstimate separately
  const estimatedSizeResult = useMemo(() => {
    void registryVersion; // reactive dep: re-runs when tracks finish loading
    if (!activeDevicePath) return { total: null, isTickEstimate: false };
    const state = deviceStates.get(activeDevicePath);
    if (!state) return { total: null, isTickEstimate: false };
    const lastOpts = lastOptionsRef.current;
    if (!lastOpts) return { total: null, isTickEstimate: false };
    return registry.calculateSize(
      state.selectedItems,
      activeDevicePath,
      lastOpts.convertToMp3,
      lastOpts.bitrate,
    );
  }, [activeDevicePath, deviceStates, registry, registryVersion]);
  const estimatedSizeBytes = estimatedSizeResult.total;
  const isTickEstimate = estimatedSizeResult.isTickEstimate;

  // Projected audio bytes post-sync = what will exist on the device if the
  // user starts the sync right now. Equals:
  //   - estimatedSizeBytes if calculateSize returned a value (sum of bytes of
  //     currently selected items, including already-synced ones kept)
  //   - otherwise (nothing selected → everything synced is in WILL REMOVE):
  //     syncedMusicBytes - willRemoveBytes
  //
  // Excluding items in `remove` state is what makes the storage bar's Audio
  // segment show 0 when the user deselects every previously-synced item
  // (ORAIN-0528).
  const projectedAudioBytes = useMemo(() => {
    void registryVersion; // reactive dep: re-runs after scheduleSyncedMusicRecalc bumps version
    if (!activeDevicePath) return null;
    const state = deviceStates.get(activeDevicePath);
    if (!state?.syncedMusicBytes) return null;
    if (estimatedSizeBytes !== null && estimatedSizeBytes !== undefined) {
      // Selection has items — projected total comes from calculateSize.
      return estimatedSizeBytes;
    }
    // Nothing selected (or all selections had no resolvable tracks).
    // Audio post-sync = (kept synced bytes) = synced - bytes of removed items.
    const removedItemIds: string[] = [];
    for (const info of state.syncedItemsInfo) {
      if (!state.selectedItems.has(info.id)) removedItemIds.push(info.id);
    }
    const removeBytes = registry.countRemoveBytes(removedItemIds, activeDevicePath);
    return Math.max(0, state.syncedMusicBytes - removeBytes);
  }, [activeDevicePath, deviceStates, registry, registryVersion, estimatedSizeBytes]);

  // Schedule recalc of syncedMusicBytes after device load
  const scheduleSyncedMusicRecalc = useCallback(
    (devicePath: string) => {
      // Defer to next tick so deviceSyncedTracks has time to populate
      setTimeout(() => {
        const total = registry.getSyncedMusicBytes(devicePath);
        setDeviceStates((prev) => {
          const state = prev.get(devicePath);
          if (!state) return prev;
          return new Map(prev).set(devicePath, { ...state, syncedMusicBytes: total });
        });
        // Bump version so estimatedSizeBytes useMemo re-runs with newly loaded itemTracks
        bumpRegistryVersion();
      }, 0);
    },
    [registry],
  );

  // Activate a device: load its synced items and init selection on first visit
  const activateDevice = useCallback(
    async (
      path: string,
      options?: {
        serverUrl: string;
        apiKey: string;
        userId: string;
        itemIds: string[];
        itemTypes: Record<string, 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre'>;
        convertToMp3: boolean;
        bitrate: '128k' | '192k' | '320k';
        coverArtMode?: 'off' | 'embed' | 'companion';
        /** RunTimeTicks per item id — available from library fetch, no extra HTTP calls */
        itemTicks?: Record<string, number>;
      },
    ) => {
      // Store options so revalidateDevice can reuse them
      lastOptionsRef.current = options ?? null;
      // Sync convertToMp3 ref so true→false transition is detected correctly
      prevConvertToMp3Ref.current = options?.convertToMp3 ?? null;

      // Skip expensive re-analysis when re-activating the same path with identical options
      const key = buildActivationKey(path, options);
      if (key === lastActivationKeyRef.current && !activatingRef.current.has(path)) {
        setActiveDevicePath(path);
        return;
      }
      // Mark as activating to prevent concurrent duplicate calls for the same path
      activatingRef.current.add(path);
      lastActivationKeyRef.current = key;

      setActiveDevicePath(path);
      setDeviceStates((prev) => {
        const existing = prev.get(path);
        // Only show skeleton on first-ever load — re-activations update in background
        const isFirstLoad = !existing || existing.syncedItems.size === 0;
        if (existing) {
          return new Map(prev).set(path, { ...existing, isActivatingDevice: isFirstLoad });
        }
        return new Map(prev).set(path, {
          selectedArtists: new Set(),
          selectedAlbumArtists: new Set(),
          selectedItems: new Set(),
          syncedItems: new Set(),
          syncedItemsInfo: [],
          outOfSyncItems: new Set(),
          syncedMusicBytes: null,
          isActivatingDevice: true,
        });
      });

      // Load device synced tracks from DB — must complete before uncached check to avoid
      // re-fetching already-synced items on fresh app start (race condition ORAIN-0483)
      await registry.loadDeviceSyncedTracks(path);

      // Populate tick estimates from library data (already loaded, no HTTP calls needed).
      // Item ticks are stored in appTypes and used by calculateSize for instant estimation.
      if (options?.itemTicks) {
        const ticksArray: Array<{
          id: string;
          ticks: number;
          type: 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre';
        }> = Object.entries(options.itemTicks).map(([id, ticks]) => ({
          id,
          ticks,
          type: (options.itemTypes[id] ?? 'album') as
            | 'artist'
            | 'albumArtist'
            | 'album'
            | 'playlist'
            | 'genre',
        }));
        registry.setItemTicks(ticksArray);
      }
      // Genres have no RunTimeTicks so they are absent from itemTicks.
      // Register their types explicitly so fetchTracksForItems uses getGenreTracks.
      if (options?.itemTypes) {
        const genreEntries = Object.entries(options.itemTypes)
          .filter(([, type]) => type === 'genre')
          .map(([id]) => ({ id, type: 'genre' as const }));
        if (genreEntries.length > 0) registry.setItemTypes(genreEntries);
      }

      // Get already-synced items from local DB (no Jellyfin calls)
      const items = await window.api.getSyncedItems(path);
      const syncedIds = new Set(items.map((i: { id: string }) => i.id));

      // Only call analyzeDiff for items already on device (Bug A fix).
      // In fresh install syncedIds is empty → 0 Jellyfin calls.
      const idsToAnalyze = options?.itemIds.filter((id) => syncedIds.has(id)) ?? [];

      const outOfSyncResult = await (idsToAnalyze.length > 0 && options
        ? window.api
            .analyzeDiff({
              serverUrl: options.serverUrl,
              apiKey: options.apiKey,
              userId: options.userId,
              itemIds: idsToAnalyze,
              itemTypes: options.itemTypes,
              destinationPath: path,
              options: {
                convertToMp3: options.convertToMp3,
                bitrate: options.bitrate,
                coverArtMode: options.coverArtMode ?? 'embed',
              },
            })
            .then(
              (result: {
                success: boolean;
                items: Array<{
                  itemId: string;
                  summary: { metadataChanged: number; pathChanged: number };
                  subItems?: Array<{
                    itemId: string;
                    summary: { newTracks: number; metadataChanged: number; pathChanged: number };
                  }>;
                }>;
              }) => {
                if (!result.success) return null;
                const outOfSyncIds = new Set<string>();
                for (const item of result.items) {
                  if (item.summary.metadataChanged > 0 || item.summary.pathChanged > 0) {
                    outOfSyncIds.add(item.itemId);
                  }
                  if (item.subItems) {
                    for (const sub of item.subItems) {
                      if (
                        sub.summary.metadataChanged > 0 ||
                        sub.summary.pathChanged > 0 ||
                        sub.summary.newTracks > 0
                      ) {
                        outOfSyncIds.add(sub.itemId);
                      }
                    }
                  }
                }
                return outOfSyncIds;
              },
            )
            .catch(() => null)
        : Promise.resolve(null));

      const syncedSet = new Set(items.map((i: { id: string }) => i.id));
      const resolvedOutOfSync = outOfSyncResult ?? new Set<string>();
      setDeviceStates((prev) => {
        const existing = prev.get(path);
        // Only init selectedArtists/selectedAlbumArtists if this is the first load
        // Split syncedSet into artists and albumArtists based on itemTypes
        const newSelectedArtists =
          existing?.syncedItems.size === 0 && existing.selectedArtists.size === 0
            ? new Set(
                items
                  .filter((i: SyncedItemInfo) => i.type === 'artist')
                  .map((i: { id: string }) => i.id),
              )
            : (existing?.selectedArtists ??
              new Set(
                items
                  .filter((i: SyncedItemInfo) => i.type === 'artist')
                  .map((i: { id: string }) => i.id),
              ));
        const newSelectedAlbumArtists =
          existing?.syncedItems.size === 0 && existing.selectedAlbumArtists.size === 0
            ? new Set(
                items
                  .filter((i: SyncedItemInfo) => i.type === 'albumArtist')
                  .map((i: { id: string }) => i.id),
              )
            : (existing?.selectedAlbumArtists ??
              new Set(
                items
                  .filter((i: SyncedItemInfo) => i.type === 'albumArtist')
                  .map((i: { id: string }) => i.id),
              ));
        // Unified selectedItems: artists + albumArtists + preserved genres/albums/playlists.
        // Without preservation, re-runs of activateDevice (e.g., after sync or convert toggle)
        // would silently drop any genres/albums/playlists the user had selected.
        const selectedItems = new Set([...newSelectedArtists, ...newSelectedAlbumArtists]);
        // isSeeding: true only when no non-artist items have been user-selected yet.
        // "Non-artist items" = selectedItems minus the artist/albumArtist subsets.
        // Using selectedItems.size would wrongly block genre seeding when the user
        // clicked an artist during loading (artists live in selectedItems too).
        // Using selectedArtists.size alone would wrongly enable genre seeding after
        // the user clicked a genre during loading (genre lives in selectedItems, not selectedArtists).
        const existingNonArtistCount = existing
          ? [...existing.selectedItems].filter(
              (id) => !existing.selectedArtists.has(id) && !existing.selectedAlbumArtists.has(id),
            ).length
          : 0;
        const isSeeding =
          !existing || (existing.syncedItems.size === 0 && existingNonArtistCount === 0);
        if (isSeeding) {
          for (const item of items) {
            if (item.type !== 'artist' && item.type !== 'albumArtist') {
              selectedItems.add(item.id);
            }
          }
        } else {
          for (const id of existing.selectedItems) {
            if (!newSelectedArtists.has(id) && !newSelectedAlbumArtists.has(id)) {
              selectedItems.add(id);
            }
          }
        }
        return new Map(prev).set(path, {
          selectedArtists: newSelectedArtists,
          selectedAlbumArtists: newSelectedAlbumArtists,
          selectedItems,
          syncedItems: syncedSet,
          syncedItemsInfo: items,
          outOfSyncItems: resolvedOutOfSync,
          syncedMusicBytes: existing?.syncedMusicBytes ?? null,
          isActivatingDevice: false,
        });
      });

      // Recompute syncedMusicBytes after activation (re-activation may have new tracks)
      scheduleSyncedMusicRecalc(path);

      // Launch background batch fetch for uncached items when convertToMp3=false.
      // When convertToMp3=true, estimation is always tick-based (no fetch needed).
      // Estimation is already showing ~X GB from ticks immediately.
      if (options && !options.convertToMp3) {
        // Synced genres and playlists: always fetch from Jellyfin regardless of the uncached
        // threshold and regardless of whether they're currently loaded in the library UI.
        // (The user may not have navigated to that tab or paginated to that section yet.)
        //
        // loadDeviceSyncedTracks sets itemTracks from DB (hasItemTracks = true), so these
        // items would normally be excluded from uncachedIds. But the DB has no durationSeconds
        // column — calculateDuration returns 0 without trackMap entries populated by Jellyfin.
        //
        // We register types from SyncedItemInfo so fetchTracksForItems uses the correct
        // Jellyfin endpoint even when these items aren't loaded in the library yet.
        const syncedGenrePlaylists = items.filter(
          (i: SyncedItemInfo) => i.type === 'genre' || i.type === 'playlist',
        );
        if (syncedGenrePlaylists.length > 0) {
          registry.setItemTypes(
            syncedGenrePlaylists.map((i: SyncedItemInfo) => ({
              id: i.id,
              type: i.type as 'genre' | 'playlist',
            })),
          );
        }
        const syncedGenrePlaylistIds = new Set(
          syncedGenrePlaylists.map((i: SyncedItemInfo) => i.id),
        );

        const uncachedOther = options.itemIds.filter(
          (id) =>
            options.itemTypes[id] && !registry.hasItemTracks(id) && !syncedGenrePlaylistIds.has(id),
        );

        const toFetch = [
          ...syncedGenrePlaylistIds,
          ...(shouldSkipUncachedFetch(uncachedOther) ? [] : uncachedOther),
        ];

        if (toFetch.length > 0) {
          // Mark loading state — button stays disabled while background fetch runs
          setSizeLoadingCount((c) => c + 1);
          void registry
            .fetchTracksForItems(toFetch, path, {
              serverUrl: options.serverUrl,
              apiKey: options.apiKey,
              userId: options.userId,
            })
            .then((success) => {
              if (success) {
                bumpRegistryVersion();
              }
              // If fetch failed, button will be enabled with tick estimate (prefix ~)
            })
            .finally(() => setSizeLoadingCount((c) => c - 1));
        }
      }

      activatingRef.current.delete(path);
      setDeviceStates((prev) => {
        const state = prev.get(path);
        if (!state) return prev;
        return new Map(prev).set(path, { ...state, isActivatingDevice: false });
      });
    },
    [registry, scheduleSyncedMusicRecalc],
  );

  // Refresh synced items for a device after sync completes
  const updateSyncedItems = useCallback(
    async (path: string, items: SyncedItemInfo[]) => {
      setDeviceStates((prev) => {
        const state = prev.get(path) ?? EMPTY;
        const syncedItems = new Set(items.map((i) => i.id));
        return new Map(prev).set(path, { ...state, syncedItems, syncedItemsInfo: items });
      });
      // Force-reload device tracks from DB since sync changed them
      await registry.loadDeviceSyncedTracks(path, true);
      scheduleSyncedMusicRecalc(path);
    },
    [registry, scheduleSyncedMusicRecalc],
  );

  // Remove device state (on disconnect or remove)
  const removeDevice = useCallback(
    (path: string) => {
      registry.invalidateDevice(path);
      setDeviceStates((prev) => {
        const next = new Map(prev);
        next.delete(path);
        return next;
      });
      setActiveDevicePath((prev) => (prev === path ? null : prev));
    },
    [registry],
  );

  // Invalidate cache so next activateDevice call re-runs analysis (e.g., after library refresh)
  // Does NOT clear registry track data — use registry.invalidateAll() only for full library refresh
  const invalidateCache = useCallback(() => {
    lastActivationKeyRef.current = null;
  }, []);

  // Fetch + cache real track data for the currently-selected uncached items, so every
  // consumer (size bar, per-group size, duration, and track count in the sync preview)
  // reads real server data instead of tick estimates. Selecting items in the library used
  // to skip this — only activateDevice fetched — leaving newly-selected items with no
  // cached tracks (track count showed 0 while size/duration fell back to ticks).
  // No fetch when convertToMp3=true: estimation is always tick-based there.
  // fetchTracksForItems aborts any prior in-flight fetch for this device and refetches the
  // full uncached set, so rapid selection changes self-heal to the latest selection.
  const fetchSelectedUncachedTracks = useCallback(
    (selectedIds: Set<string>, path: string) => {
      const opts = lastOptionsRef.current;
      if (!opts || opts.convertToMp3) return;

      if (fetchDebounceRef.current !== null) clearTimeout(fetchDebounceRef.current);

      fetchDebounceRef.current = setTimeout(() => {
        fetchDebounceRef.current = null;
        const uncachedIds = [...selectedIds].filter(
          (id) => registry.getItemType(id) && !registry.hasItemTracks(id),
        );
        if (shouldSkipUncachedFetch(uncachedIds)) return;

        // Mark loading state — sync button stays disabled until real track data is cached
        setSizeLoadingCount((c) => c + 1);
        void registry
          .fetchTracksForItems(uncachedIds, path, {
            serverUrl: opts.serverUrl,
            apiKey: opts.apiKey,
            userId: opts.userId,
          })
          .then((success) => {
            if (success) bumpRegistryVersion();
          })
          .finally(() => setSizeLoadingCount((c) => c - 1));
      }, 500);
    },
    [registry],
  );

  const toggleItem = useCallback(
    (id: string, viewType?: 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre') => {
      if (!activeDevicePath) return;

      const current = deviceStates.get(activeDevicePath) ?? EMPTY;
      const itemType = registry.getItemType(id) as
        | 'artist'
        | 'albumArtist'
        | 'album'
        | 'playlist'
        | 'genre'
        | undefined;

      // ORAIN-0551: when the caller supplies the view type (e.g., LibraryContent
      // invoking toggle from the Artists or AlbumArtists tab), prefer that as the
      // routing target. This avoids the "last write wins" issue where the registry
      // overwrites the type of a shared id to 'albumArtist' (because the album-artist
      // list was registered second) and a click in the Artists view then routes to
      // the wrong set.
      const effectiveType: 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre' | undefined =
        viewType ?? itemType;

      const inArtists = current.selectedArtists.has(id);
      const inAlbumArtists = current.selectedAlbumArtists.has(id);
      const inItems = current.selectedItems.has(id);

      // Artist query (ArtistIds=X) is a superset of albumArtist query (AlbumArtistIds=X).
      // The same Jellyfin id must not live in both typed sets simultaneously.
      //
      // No-op: clicking albumArtist when artist already selected — artist already covers it.
      if (effectiveType === 'albumArtist' && inArtists) return;
      // Upgrade: clicking artist when albumArtist already selected — migrate to the superset.
      // The narrower albumArtist selection is replaced; next sync picks up additional tracks.
      const isUpgrade = effectiveType === 'artist' && inAlbumArtists && !inArtists;

      const wasSelected =
        effectiveType === 'artist'
          ? inArtists
          : effectiveType === 'albumArtist'
            ? inAlbumArtists
            : inItems || inArtists || inAlbumArtists;

      const newArtists = new Set(current.selectedArtists);
      const newAlbumArtists = new Set(current.selectedAlbumArtists);
      // Only carry over items that belong to neither typed set — avoids the stale-union
      // problem where deleting from newArtists alone left the id in the copied union.
      const newItems = new Set<string>();
      for (const oid of current.selectedItems) {
        if (!current.selectedArtists.has(oid) && !current.selectedAlbumArtists.has(oid)) {
          newItems.add(oid);
        }
      }
      if (wasSelected) {
        if (effectiveType === 'artist') {
          newArtists.delete(id);
        } else if (effectiveType === 'albumArtist') {
          newAlbumArtists.delete(id);
        } else {
          newArtists.delete(id);
          newAlbumArtists.delete(id);
          newItems.delete(id);
        }
      } else if (effectiveType === 'artist') {
        if (isUpgrade) newAlbumArtists.delete(id);
        newArtists.add(id);
        registry.setItemTypes([{ id, type: 'artist' }]);
      } else if (effectiveType === 'albumArtist') {
        newAlbumArtists.add(id);
        registry.setItemTypes([{ id, type: 'albumArtist' }]);
      } else {
        // album / playlist / genre / unknown — use the un-typed set
        newItems.add(id);
        // Register type so fetchTracksForItems uses the correct Jellyfin endpoint
        if (
          effectiveType === 'album' ||
          effectiveType === 'playlist' ||
          effectiveType === 'genre'
        ) {
          registry.setItemTypes([{ id, type: effectiveType }]);
        }
      }

      const next = unionSelections(newArtists, newAlbumArtists, newItems);

      setDeviceStates((prev) => {
        const state = prev.get(activeDevicePath) ?? EMPTY;
        // Recompute union from the *new* typed sets so removing from one set also
        // removes it from the unified view (avoids stale entries in selectedItems).
        const updatedSelectedItems = unionSelections(newArtists, newAlbumArtists, newItems);
        const updated: DeviceState = {
          ...state,
          selectedArtists: newArtists,
          selectedAlbumArtists: newAlbumArtists,
          selectedItems: updatedSelectedItems,
        };
        return new Map(prev).set(activeDevicePath, updated);
      });

      // On add, fetch real track data for any uncached selected items.
      if (!wasSelected) fetchSelectedUncachedTracks(next, activeDevicePath);
      bumpRegistryVersion();
    },
    [activeDevicePath, deviceStates, fetchSelectedUncachedTracks, registry],
  );

  const selectItems = useCallback(
    (items: Array<{ Id: string }>) => {
      if (!activeDevicePath) return;

      setDeviceStates((prev) => {
        const state = prev.get(activeDevicePath) ?? EMPTY;
        const newArtists = new Set(state.selectedArtists);
        const newAlbumArtists = new Set(state.selectedAlbumArtists);
        const newItems = new Set(state.selectedItems);
        items.forEach((i) => {
          const t = registry.getItemType(i.Id);
          if (t === 'artist') newArtists.add(i.Id);
          else if (t === 'albumArtist') newAlbumArtists.add(i.Id);
          else newItems.add(i.Id);
        });
        const selectedItems = unionSelections(newArtists, newAlbumArtists, newItems);
        return new Map(prev).set(activeDevicePath, {
          ...state,
          selectedArtists: newArtists,
          selectedAlbumArtists: newAlbumArtists,
          selectedItems,
        });
      });

      const next = new Set(items.map((i) => i.Id));
      // Fetch real track data for any uncached selected items.
      fetchSelectedUncachedTracks(next, activeDevicePath);
      bumpRegistryVersion();
    },
    [activeDevicePath, fetchSelectedUncachedTracks, registry],
  );

  // Select All: registers item types in registry BEFORE selection so that
  // fetchSelectedUncachedTracks threshold guard sees the full set of IDs.
  // Without this, getItemType returns undefined for items not yet in the
  // registry (only first ~50 items from initial load), causing the threshold
  // guard to be bypassed (ORAIN-0494).
  const selectAllItems = useCallback(
    (ids: string[], type: 'artist' | 'albumArtist' | 'album' | 'playlist' | 'genre') => {
      // Register all item types FIRST, before selectItems triggers threshold check
      registry.setItemTypes(ids.map((id) => ({ id, type })));
      // Now selectItems will see all types registered and threshold guard works correctly
      selectItems(ids.map((id) => ({ Id: id })));
    },
    [registry, selectItems],
  );

  const clearSelection = useCallback(() => {
    if (!activeDevicePath) return;
    setDeviceStates((prev) => {
      const state = prev.get(activeDevicePath) ?? EMPTY;
      return new Map(prev).set(activeDevicePath, {
        ...state,
        selectedArtists: new Set(),
        selectedAlbumArtists: new Set(),
        selectedItems: new Set(),
      });
    });
  }, [activeDevicePath]);

  // Invalidate cache AND re-run activation with last used params
  // Accept optional overrides so callers (like useSync after sync) can pass current state
  // to avoid stale ref values (e.g., coverArtMode changed via UI but ref not yet updated)
  const revalidateDevice = useCallback(
    async (
      overrides?: Partial<{
        coverArtMode: 'off' | 'embed' | 'companion';
        convertToMp3: boolean;
        bitrate: '128k' | '192k' | '320k';
      }>,
    ) => {
      if (!activeDevicePath) return;
      lastActivationKeyRef.current = null;

      // Build options: start with lastOptionsRef (which has required fields like serverUrl),
      // then overlay any provided overrides so explicit params win over stale ref values
      const baseOptions = lastOptionsRef.current;
      const mergedOptions = baseOptions
        ? {
            ...baseOptions,
            ...(overrides?.coverArtMode !== undefined && {
              coverArtMode: overrides.coverArtMode,
            }),
            ...(overrides?.convertToMp3 !== undefined && {
              convertToMp3: overrides.convertToMp3,
            }),
            ...(overrides?.bitrate !== undefined && { bitrate: overrides.bitrate }),
          }
        : undefined;

      await activateDevice(activeDevicePath, mergedOptions ?? undefined);
    },
    [activeDevicePath],
  );

  // Called on library refresh — clears stale item track data and re-runs analysis
  const onLibraryRefresh = useCallback(async () => {
    registry.invalidateAll();
    lastActivationKeyRef.current = null;
    if (activeDevicePath) {
      await activateDevice(activeDevicePath, lastOptionsRef.current ?? undefined);
    }
  }, [registry, activeDevicePath, activateDevice]);

  return {
    activeDevicePath,
    selectedTracks: activeState.selectedItems,
    selectedArtists: activeState.selectedArtists,
    selectedAlbumArtists: activeState.selectedAlbumArtists,
    previouslySyncedItems: activeState.syncedItems,
    syncedItemsInfo: activeState.syncedItemsInfo,
    outOfSyncItems: activeState.outOfSyncItems,
    estimatedSizeBytes,
    projectedAudioBytes,
    isTickEstimate,
    isLoadingSize: sizeLoadingCount > 0,
    syncedMusicBytes: activeState.syncedMusicBytes,
    isActivatingDevice: activeState.isActivatingDevice,
    activateDevice,
    updateSyncedItems,
    removeDevice,
    toggleItem,
    selectItems,
    selectAllItems,
    clearSelection,
    invalidateCache,
    revalidateDevice,
    onLibraryRefresh,
    updateConvertOptions: useCallback(
      (
        convertToMp3: boolean,
        bitrate: '128k' | '192k' | '320k',
        coverArtMode?: 'off' | 'embed' | 'companion',
      ) => {
        if (lastOptionsRef.current) {
          lastOptionsRef.current = {
            ...lastOptionsRef.current,
            convertToMp3,
            bitrate,
            coverArtMode: coverArtMode ?? lastOptionsRef.current.coverArtMode ?? 'embed',
          };
        }
        bumpRegistryVersion();

        // AC: when convertToMp3 changes from true→false, launch background batch fetch
        // for uncached items and show ~X GB immediately from ticks.
        if (
          prevConvertToMp3Ref.current === true &&
          convertToMp3 === false &&
          activeDevicePath &&
          lastOptionsRef.current
        ) {
          const opts = lastOptionsRef.current;
          const uncachedIds = opts.itemIds.filter(
            (id) => opts.itemTypes[id] && registry.getItemTrackIds(id).length === 0,
          );
          if (shouldSkipUncachedFetch(uncachedIds)) return;

          setSizeLoadingCount((c) => c + 1);
          void registry
            .fetchTracksForItems(uncachedIds, activeDevicePath, {
              serverUrl: opts.serverUrl,
              apiKey: opts.apiKey,
              userId: opts.userId,
            })
            .then((success) => {
              if (success) bumpRegistryVersion();
            })
            .finally(() => setSizeLoadingCount((c) => c - 1));
        }
        prevConvertToMp3Ref.current = convertToMp3;
      },
      [activeDevicePath, registry],
    ),
  };
}
