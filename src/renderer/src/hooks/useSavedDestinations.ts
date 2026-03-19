import { useState } from 'react'
import type { SavedDestination } from '../appTypes'

const STORAGE_KEY = 'jellysync_destinations'

function load(): SavedDestination[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function save(destinations: SavedDestination[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(destinations))
}

function nameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function useSavedDestinations() {
  const [destinations, setDestinations] = useState<SavedDestination[]>(load)

  const addDestination = (path: string, name?: string): SavedDestination => {
    const existing = destinations.find(d => d.path === path)
    if (existing) return existing

    const dest: SavedDestination = {
      id: String(Date.now()),
      name: name ?? nameFromPath(path),
      path,
    }
    setDestinations(prev => {
      const updated = [...prev, dest]
      save(updated)
      return updated
    })
    return dest
  }

  const removeDestination = (id: string): void => {
    setDestinations(prev => {
      const updated = prev.filter(d => d.id !== id)
      save(updated)
      return updated
    })
  }

  const renameDestination = (id: string, name: string): void => {
    setDestinations(prev => {
      const updated = prev.map(d => d.id === id ? { ...d, name } : d)
      save(updated)
      return updated
    })
  }

  return { destinations, addDestination, removeDestination, renameDestination }
}
