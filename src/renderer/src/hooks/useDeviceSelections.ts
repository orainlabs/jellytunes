import { useState, useCallback, useRef, useMemo, useReducer } from 'react';
import { getTrackRegistry } from './useTrackRegistry';

/** Threshold to prevent HTTP flood when selecting large numbers of items.
 *  Selecting >50 uncached items skips the batch fetch and relies on tick-based estimation.
 *  Users can deselect items below this threshold to trigger a real fetch. */
export const MAX_UNCACHED_FETCH_COUNT = 50;

export interface SyncedItemInfo {
  id: string;
  name: string;
  type: 'artist' | 'album' | 'playlist';
}

interface DeviceState {
  selectedItems: Set<string>;
  syncedItems: Set<string>;
  syncedItemsInfo: SyncedItemInfo[];
  outOfSyncItems: Set<string>;
  syncedMusicBytes: number | null;
  isActivatingDevice: boolean;
}

const EMPTY: DeviceState = {
  selectedItems: new Set(),
  syncedItems: new Set(),
  syncedItemsInfo: [],
  outOfSyncItems: new Set(),
  syncedMusicBytes: null,
  isActivatingDevice: false,
};

/** Build a cache key from path+options to detect unchanged re-activations */
function buildActivationKey(
  path: string,
  options?: {
    itemIds: string[];
    itemTypes: Record<string, 'artist' | 'album' | 'playlist'>;
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
        itemTypes: Record<string, 'artist' | 'album' | 'playlist'>;
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
          type: 'artist' | 'album' | 'playlist';
        }> = Object.entries(options.itemTicks).map(([id, ticks]) => ({
          id,
          ticks,
          type: (options.itemTypes[id] ?? 'album') as 'artist' | 'album' | 'playlist',
        }));
        registry.setItemTicks(ticksArray);
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
        // Only init selectedItems if this is the first load
        const selectedItems =
          existing?.syncedItems.size === 0 && existing.selectedItems.size === 0
            ? new Set(syncedSet)
            : (existing?.selectedItems ?? new Set(syncedSet));
        return new Map(prev).set(path, {
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
        const uncachedIds = options.itemIds.filter(
          (id) => options.itemTypes[id] && !registry.hasItemTracks(id),
        );
        if (uncachedIds.length > 0) {
          // Threshold guard: skip fetch if too many uncached items to prevent HTTP flood.
          // When skipped, button stays enabled immediately with tick-based estimate (prefix ~).
          if (uncachedIds.length > MAX_UNCACHED_FETCH_COUNT) {
            console.warn(
              `[useDeviceSelections] Skipping fetch: ${uncachedIds.length} uncached items exceed threshold of ${MAX_UNCACHED_FETCH_COUNT}`,
            );
          } else {
            // Mark loading state — button stays disabled while background fetch runs
            setSizeLoadingCount((c) => c + 1);
            void registry
              .fetchTracksForItems(uncachedIds, path, {
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
        if (uncachedIds.length === 0) return;

        // Threshold guard: skip fetch if too many uncached items to prevent HTTP flood.
        // When skipped, button stays enabled immediately with tick-based estimate (prefix ~).
        if (uncachedIds.length > MAX_UNCACHED_FETCH_COUNT) {
          console.warn(
            `[useDeviceSelections] Skipping fetch: ${uncachedIds.length} uncached items exceed threshold of ${MAX_UNCACHED_FETCH_COUNT}`,
          );
          return;
        }

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
    (id: string) => {
      if (!activeDevicePath) return;

      const current = deviceStates.get(activeDevicePath) ?? EMPTY;
      const wasSelected = current.selectedItems.has(id);
      const next = new Set(current.selectedItems);
      if (wasSelected) next.delete(id);
      else next.add(id);

      setDeviceStates((prev) => {
        const state = prev.get(activeDevicePath) ?? EMPTY;
        const ns = new Set(state.selectedItems);
        if (ns.has(id)) ns.delete(id);
        else ns.add(id);
        return new Map(prev).set(activeDevicePath, { ...state, selectedItems: ns });
      });

      // On add, fetch real track data for any uncached selected items.
      if (!wasSelected) fetchSelectedUncachedTracks(next, activeDevicePath);
      bumpRegistryVersion();
    },
    [activeDevicePath, deviceStates, fetchSelectedUncachedTracks],
  );

  const selectItems = useCallback(
    (items: Array<{ Id: string }>) => {
      if (!activeDevicePath) return;

      const current = deviceStates.get(activeDevicePath) ?? EMPTY;
      const next = new Set(current.selectedItems);
      items.forEach((i) => next.add(i.Id));

      setDeviceStates((prev) => {
        const state = prev.get(activeDevicePath) ?? EMPTY;
        const ns = new Set(state.selectedItems);
        items.forEach((i) => ns.add(i.Id));
        return new Map(prev).set(activeDevicePath, { ...state, selectedItems: ns });
      });

      // Fetch real track data for any uncached selected items.
      fetchSelectedUncachedTracks(next, activeDevicePath);
      bumpRegistryVersion();
    },
    [activeDevicePath, deviceStates, fetchSelectedUncachedTracks],
  );

  const clearSelection = useCallback(() => {
    if (!activeDevicePath) return;
    setDeviceStates((prev) => {
      const state = prev.get(activeDevicePath) ?? EMPTY;
      return new Map(prev).set(activeDevicePath, { ...state, selectedItems: new Set() });
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
    previouslySyncedItems: activeState.syncedItems,
    syncedItemsInfo: activeState.syncedItemsInfo,
    outOfSyncItems: activeState.outOfSyncItems,
    estimatedSizeBytes,
    isTickEstimate,
    isLoadingSize: sizeLoadingCount > 0,
    syncedMusicBytes: activeState.syncedMusicBytes,
    isActivatingDevice: activeState.isActivatingDevice,
    activateDevice,
    updateSyncedItems,
    removeDevice,
    toggleItem,
    selectItems,
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
          if (uncachedIds.length > 0) {
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
        }
        prevConvertToMp3Ref.current = convertToMp3;
      },
      [activeDevicePath, registry],
    ),
  };
}
