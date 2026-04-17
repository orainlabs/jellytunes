import { useState, useCallback, useRef, useMemo, useReducer } from 'react'
import { getTrackRegistry } from './useTrackRegistry'

export interface SyncedItemInfo {
  id: string
  name: string
  type: 'artist' | 'album' | 'playlist'
}

interface DeviceState {
  selectedItems: Set<string>
  syncedItems: Set<string>
  syncedItemsInfo: SyncedItemInfo[]
  outOfSyncItems: Set<string>
  syncedMusicBytes: number | null
  isActivatingDevice: boolean
}

const EMPTY: DeviceState = { selectedItems: new Set(), syncedItems: new Set(), syncedItemsInfo: [], outOfSyncItems: new Set(), syncedMusicBytes: null, isActivatingDevice: false }

/** Build a cache key from path+options to detect unchanged re-activations */
function buildActivationKey(
  path: string,
  options?: {
    itemIds: string[]; itemTypes: Record<string, 'artist' | 'album' | 'playlist'>
    convertToMp3: boolean; bitrate: '128k' | '192k' | '320k'
    coverArtMode?: 'off' | 'embed' | 'separate'
  }
): string | null {
  if (!options) return null
  const sortedIds = [...options.itemIds].sort().join(',')
  return `${path}:${sortedIds}:${options.convertToMp3}:${options.bitrate}:${options.coverArtMode ?? 'embed'}`
}

export function useDeviceSelections() {
  const registry = useMemo(() => getTrackRegistry(), [])
  // Bumped whenever registry internal state changes (tracks loaded) to re-trigger estimatedSizeBytes
  const [registryVersion, bumpRegistryVersion] = useReducer((v: number) => v + 1, 0)

  const [deviceStates, setDeviceStates] = useState<Map<string, DeviceState>>(new Map())
  const [activeDevicePath, setActiveDevicePath] = useState<string | null>(null)
  // Tracks in-flight ensureItemTracks calls so UI can show loading indicator
  const [sizeLoadingCount, setSizeLoadingCount] = useState(0)
  // Track last activation key to skip unnecessary re-analysis
  const lastActivationKeyRef = useRef<string | null>(null)
  // Track in-flight activation to avoid duplicate getSyncedItems calls
  const activatingRef = useRef<Set<string>>(new Set())
  // Store last activation options so revalidateDevice can reuse them
  const lastOptionsRef = useRef<Parameters<typeof activateDevice>[1] | null>(null)

  const activeState = activeDevicePath
    ? (deviceStates.get(activeDevicePath) ?? EMPTY)
    : EMPTY

  // Compute estimated size from registry (derived, not stored)
  // registryVersion is bumped when ensureItemTracks resolves to trigger re-computation
  const estimatedSizeBytes = useMemo(() => {
    void registryVersion // reactive dep: re-runs when tracks finish loading
    if (!activeDevicePath) return null
    const state = deviceStates.get(activeDevicePath)
    if (!state) return null
    const lastOpts = lastOptionsRef.current
    if (!lastOpts) return null
    return registry.calculateSize(
      state.selectedItems,
      activeDevicePath,
      lastOpts.convertToMp3,
      lastOpts.bitrate
    )
  }, [activeDevicePath, deviceStates, registry, registryVersion])

  // Schedule recalc of syncedMusicBytes after device load
  const scheduleSyncedMusicRecalc = useCallback((devicePath: string) => {
    // Defer to next tick so deviceSyncedTracks has time to populate
    setTimeout(() => {
      const total = registry.getSyncedMusicBytes(devicePath)
      setDeviceStates(prev => {
        const state = prev.get(devicePath)
        if (!state) return prev
        return new Map(prev).set(devicePath, { ...state, syncedMusicBytes: total })
      })
      // Bump version so estimatedSizeBytes useMemo re-runs with newly loaded itemTracks
      bumpRegistryVersion()
    }, 0)
  }, [registry])

  // Activate a device: load its synced items and init selection on first visit
  const activateDevice = useCallback(async (path: string, options?: {
    serverUrl: string; apiKey: string; userId: string
    itemIds: string[]; itemTypes: Record<string, 'artist' | 'album' | 'playlist'>
    convertToMp3: boolean; bitrate: '128k' | '192k' | '320k'
    coverArtMode?: 'off' | 'embed' | 'separate'
  }) => {
    // Store options so revalidateDevice can reuse them
    lastOptionsRef.current = options ?? null

    // Skip expensive re-analysis when re-activating the same path with identical options
    const key = buildActivationKey(path, options)
    if (key === lastActivationKeyRef.current && !activatingRef.current.has(path)) {
      setActiveDevicePath(path)
      return
    }
    // Mark as activating to prevent concurrent duplicate calls for the same path
    activatingRef.current.add(path)
    lastActivationKeyRef.current = key

    setActiveDevicePath(path)
    setDeviceStates(prev => {
      const existing = prev.get(path)
      // Only show skeleton on first-ever load — re-activations update in background
      const isFirstLoad = !existing || existing.syncedItems.size === 0
      if (existing) {
        return new Map(prev).set(path, { ...existing, isActivatingDevice: isFirstLoad })
      }
      return new Map(prev).set(path, { selectedItems: new Set(), syncedItems: new Set(), syncedItemsInfo: [], outOfSyncItems: new Set(), syncedMusicBytes: null, isActivatingDevice: true })
    })

    // Load device synced tracks from DB (for size calculations)
    registry.loadDeviceSyncedTracks(path).then(() => {
      scheduleSyncedMusicRecalc(path)
    })

    // Pre-check synchronously (before any await) which items need track fetching.
    // This starts the loading indicator immediately, not after the getSyncedItems/analyzeDiff awaits.
    const eagerToFetch = options
      ? options.itemIds.filter(id => options.itemTypes[id] && registry.getItemTrackIds(id).length === 0)
      : []
    let sizeLoadingIncremented = false
    if (eagerToFetch.length > 0) {
      setSizeLoadingCount(c => c + 1)
      sizeLoadingIncremented = true
    }

    try {
      // Step 1: get already-synced items from local DB (no Jellyfin calls)
      const items = await window.api.getSyncedItems(path)
      const syncedIds = new Set(items.map((i: { id: string }) => i.id))

      // Step 2: only call analyzeDiff for items already on device (Bug A fix)
      // In fresh install syncedIds is empty → 0 Jellyfin calls
      const idsToAnalyze = options?.itemIds.filter(id => syncedIds.has(id)) ?? []

      const outOfSyncResult = await (idsToAnalyze.length > 0 && options
        ? window.api.analyzeDiff({
            serverUrl: options.serverUrl,
            apiKey: options.apiKey,
            userId: options.userId,
            itemIds: idsToAnalyze,
            itemTypes: options.itemTypes,
            destinationPath: path,
            options: { convertToMp3: options.convertToMp3, bitrate: options.bitrate, coverArtMode: options.coverArtMode ?? 'embed' },
          }).then((result: { success: boolean; items: Array<{ itemId: string; summary: { metadataChanged: number; pathChanged: number }; subItems?: Array<{ itemId: string; summary: { newTracks: number; metadataChanged: number; pathChanged: number } }> }> }) => {
            if (!result.success) return null
            const outOfSyncIds = new Set<string>()
            for (const item of result.items) {
              if (item.summary.metadataChanged > 0 || item.summary.pathChanged > 0) {
                outOfSyncIds.add(item.itemId)
              }
              // Also mark specific sub-items (albums within artist) as out-of-sync
              if (item.subItems) {
                for (const sub of item.subItems) {
                  if (sub.summary.metadataChanged > 0 || sub.summary.pathChanged > 0 || sub.summary.newTracks > 0) {
                    outOfSyncIds.add(sub.itemId)
                  }
                }
              }
            }
            return outOfSyncIds
          }).catch(() => null)
        : Promise.resolve(null))

      const syncedSet = new Set(items.map((i: { id: string }) => i.id))
      const resolvedOutOfSync = outOfSyncResult ?? new Set<string>()
      setDeviceStates(prev => {
        const existing = prev.get(path)
        // Only init selectedItems if this is the first load
        const selectedItems = existing && existing.syncedItems.size === 0 && existing.selectedItems.size === 0
          ? new Set(syncedSet)
          : (existing?.selectedItems ?? new Set(syncedSet))
        return new Map(prev).set(path, {
          selectedItems,
          syncedItems: syncedSet,
          syncedItemsInfo: items,
          outOfSyncItems: resolvedOutOfSync,
          // Preserve existing syncedMusicBytes — scheduleSyncedMusicRecalc will update it
          syncedMusicBytes: existing?.syncedMusicBytes ?? null,
          isActivatingDevice: false,
        })
      })
      // Eagerly fetch tracks for synced items not yet in registry
      // (handles v0.2.x→v0.3.0 upgrade: synced_tracks was empty, so these auto-selected
      //  items need their track data fetched for size calculations and sync preview)
      if (options) {
        const syncedToFetch = items.filter(
          (item: SyncedItemInfo) => registry.getItemTrackIds(item.id).length === 0
        )
        if (syncedToFetch.length > 0) {
          setSizeLoadingCount(c => c + 1)
          Promise.all(
            syncedToFetch.map((item: SyncedItemInfo) =>
              registry.ensureItemTracks(item.id, item.type, {
                serverUrl: options.serverUrl,
                apiKey: options.apiKey,
                userId: options.userId,
              })
            )
          ).then(() => bumpRegistryVersion()).finally(() => setSizeLoadingCount(c => c - 1))
        }
      }
      // Recompute syncedMusicBytes after activation (re-activation may have new tracks)
      scheduleSyncedMusicRecalc(path)
      // Eagerly fetch tracks for any selected item not yet in registry
      // (covers items newly added in library view whose type wasn't in lastOpts at toggle time)
      if (sizeLoadingIncremented) {
        // Re-check: concurrent calls may have populated some items during the awaits above
        const stillToFetch = eagerToFetch.filter(id => registry.getItemTrackIds(id).length === 0)
        sizeLoadingIncremented = false // prevent finally from also decrementing
        if (stillToFetch.length > 0) {
          Promise.all(
            stillToFetch.map(id => registry.ensureItemTracks(id, options!.itemTypes[id], {
              serverUrl: options!.serverUrl,
              apiKey: options!.apiKey,
              userId: options!.userId,
            }))
          ).then(() => bumpRegistryVersion()).finally(() => setSizeLoadingCount(c => c - 1))
        } else {
          setSizeLoadingCount(c => c - 1) // nothing left to fetch, release immediately
        }
      }
    } catch { /* ignore */ } finally {
      if (sizeLoadingIncremented) {
        setSizeLoadingCount(c => c - 1) // cleanup on error path
      }
      activatingRef.current.delete(path)
      setDeviceStates(prev => {
        const state = prev.get(path)
        if (!state) return prev
        return new Map(prev).set(path, { ...state, isActivatingDevice: false })
      })
    }
  }, [registry, scheduleSyncedMusicRecalc])

  // Refresh synced items for a device after sync completes
  const updateSyncedItems = useCallback((path: string, items: SyncedItemInfo[]) => {
    setDeviceStates(prev => {
      const state = prev.get(path) ?? EMPTY
      const syncedItems = new Set(items.map(i => i.id))
      return new Map(prev).set(path, { ...state, syncedItems, syncedItemsInfo: items })
    })
    // Force-reload device tracks from DB since sync changed them
    registry.loadDeviceSyncedTracks(path, true).then(() => {
      scheduleSyncedMusicRecalc(path)
    })
  }, [registry, scheduleSyncedMusicRecalc])

  // Remove device state (on disconnect or remove)
  const removeDevice = useCallback((path: string) => {
    registry.invalidateDevice(path)
    setDeviceStates(prev => {
      const next = new Map(prev)
      next.delete(path)
      return next
    })
    setActiveDevicePath(prev => prev === path ? null : prev)
  }, [registry])

  // Invalidate cache so next activateDevice call re-runs analysis (e.g., after library refresh)
  // Does NOT clear registry track data — use registry.invalidateAll() only for full library refresh
  const invalidateCache = useCallback(() => {
    lastActivationKeyRef.current = null
  }, [])

  const toggleItem = useCallback((id: string) => {
    if (!activeDevicePath) return
    // Note: do NOT call invalidateCache() here — it nulls lastActivationKeyRef and causes
    // skeleton on every library→sync navigation. The activation key captures selection state
    // naturally; a changed selection produces a different key at handleDestinationClick time.

    const lastOpts = lastOptionsRef.current
    const itemType = lastOpts?.itemTypes[id]

    setDeviceStates(prev => {
      const state = prev.get(activeDevicePath) ?? EMPTY
      const next = new Set(state.selectedItems)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return new Map(prev).set(activeDevicePath, { ...state, selectedItems: next })
    })

    // Fetch tracks for this item if needed (for size calculation)
    if (lastOpts && itemType) {
      setSizeLoadingCount(c => c + 1)
      registry.ensureItemTracks(id, itemType, {
        serverUrl: lastOpts.serverUrl,
        apiKey: lastOpts.apiKey,
        userId: lastOpts.userId,
      }).then(() => bumpRegistryVersion()).finally(() => setSizeLoadingCount(c => c - 1))
    }
  }, [activeDevicePath, registry])

  const selectItems = useCallback((items: Array<{ Id: string }>) => {
    if (!activeDevicePath) return
    const lastOpts = lastOptionsRef.current

    setDeviceStates(prev => {
      const state = prev.get(activeDevicePath) ?? EMPTY
      const next = new Set(state.selectedItems)
      items.forEach(i => next.add(i.Id))
      return new Map(prev).set(activeDevicePath, { ...state, selectedItems: next })
    })

    // Fetch tracks for these items if needed (for size calculation)
    if (lastOpts) {
      const fetches = items
        .filter(item => lastOpts.itemTypes[item.Id])
        .map(item => registry.ensureItemTracks(item.Id, lastOpts.itemTypes[item.Id], {
          serverUrl: lastOpts.serverUrl,
          apiKey: lastOpts.apiKey,
          userId: lastOpts.userId,
        }))
      if (fetches.length > 0) {
        setSizeLoadingCount(c => c + 1)
        Promise.all(fetches).then(() => bumpRegistryVersion()).finally(() => setSizeLoadingCount(c => c - 1))
      }
    }
  }, [activeDevicePath, registry])

  const clearSelection = useCallback(() => {
    if (!activeDevicePath) return
    setDeviceStates(prev => {
      const state = prev.get(activeDevicePath) ?? EMPTY
      return new Map(prev).set(activeDevicePath, { ...state, selectedItems: new Set() })
    })
  }, [activeDevicePath])

  // Invalidate cache AND re-run activation with last used params
  const revalidateDevice = useCallback(async () => {
    if (!activeDevicePath) return
    lastActivationKeyRef.current = null
    await activateDevice(activeDevicePath, lastOptionsRef.current ?? undefined)
  }, [activeDevicePath])

  // Called on library refresh — clears stale item track data and re-runs analysis
  const onLibraryRefresh = useCallback(async () => {
    registry.invalidateAll()
    lastActivationKeyRef.current = null
    if (activeDevicePath) {
      await activateDevice(activeDevicePath, lastOptionsRef.current ?? undefined)
    }
  }, [registry, activeDevicePath, activateDevice])

  return {
    activeDevicePath,
    selectedTracks: activeState.selectedItems,
    previouslySyncedItems: activeState.syncedItems,
    syncedItemsInfo: activeState.syncedItemsInfo,
    outOfSyncItems: activeState.outOfSyncItems,
    estimatedSizeBytes,
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
    updateConvertOptions: useCallback((convertToMp3: boolean, bitrate: '128k' | '192k' | '320k') => {
      if (lastOptionsRef.current) {
        lastOptionsRef.current = { ...lastOptionsRef.current, convertToMp3, bitrate }
      }
      bumpRegistryVersion()
    }, []),
  }
}
