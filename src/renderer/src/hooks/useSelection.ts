import { useState, useEffect } from 'react'
import type { Artist, Album, Playlist } from '../appTypes'

export function useSelection(
  syncFolder: string | null,
  artists: Artist[],
  albums: Album[],
  playlists: Playlist[]
) {
  const [selectedTracks, setSelectedTracks] = useState<Set<string>>(new Set())
  const [previouslySyncedItems, setPreviouslySyncedItems] = useState<Set<string>>(new Set())

  // Load previously synced items when destination folder changes
  useEffect(() => {
    if (!syncFolder) {
      setPreviouslySyncedItems(new Set())
      return
    }
    window.api.getSyncedItems(syncFolder).then((ids: string[]) => {
      const idSet = new Set(ids)
      setPreviouslySyncedItems(idSet)
      setSelectedTracks(prev => {
        const next = new Set(prev)
        for (const id of idSet) next.add(id)
        return next
      })
    }).catch(() => { /* ignore if db not ready */ })
  }, [syncFolder])

  const toggleTrackSelection = (id: string): void => {
    if (!id || typeof id !== 'string' || id.trim() === '') return
    setSelectedTracks(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAllInView = (): void => {
    const currentItems: Array<Artist | Album | Playlist> =
      artists.length > 0 ? artists : albums.length > 0 ? albums : playlists
    setSelectedTracks(prev => {
      const next = new Set(prev)
      currentItems.forEach(item => next.add(item.Id))
      return next
    })
  }

  const selectAll = (items: Array<{ Id: string }>): void => {
    setSelectedTracks(prev => {
      const next = new Set(prev)
      items.forEach(item => next.add(item.Id))
      return next
    })
  }

  const clearSelection = (): void => setSelectedTracks(new Set())

  return {
    selectedTracks,
    previouslySyncedItems,
    setPreviouslySyncedItems,
    toggleTrackSelection,
    selectAllInView,
    selectAll,
    clearSelection,
  }
}
