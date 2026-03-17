import { useState, useEffect } from 'react'
import type { JellyfinConfig, Artist, Album, Playlist } from '../appTypes'
import { jellyfinHeaders } from '../utils/jellyfin'

interface SearchResults {
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
}

export function useSearch(jellyfinConfig: JellyfinConfig | null, userId: string | null) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null)
  const [isSearching, setIsSearching] = useState(false)

  useEffect(() => {
    if (!jellyfinConfig || !userId) return
    if (!searchQuery || searchQuery.length < 2) {
      setSearchResults(null)
      return
    }
    setIsSearching(true)
    const timer = setTimeout(async () => {
      try {
        const headers = jellyfinHeaders(jellyfinConfig.apiKey)
        const base = jellyfinConfig.url.replace(/\/$/, '')
        const q = encodeURIComponent(searchQuery)
        const [artistsRes, albumsRes, playlistsRes] = await Promise.all([
          fetch(`${base}/Artists?SearchTerm=${q}&Limit=20`, { headers }),
          fetch(`${base}/Items?SearchTerm=${q}&IncludeItemTypes=MusicAlbum&Recursive=true&Limit=20`, { headers }),
          fetch(`${base}/Items?SearchTerm=${q}&IncludeItemTypes=Playlist&Recursive=true&Limit=20`, { headers }),
        ])
        const [artistsData, albumsData, playlistsData] = await Promise.all([
          artistsRes.ok ? artistsRes.json() : { Items: [] },
          albumsRes.ok ? albumsRes.json() : { Items: [] },
          playlistsRes.ok ? playlistsRes.json() : { Items: [] },
        ])
        setSearchResults({
          artists: artistsData.Items ?? [],
          albums: albumsData.Items ?? [],
          playlists: playlistsData.Items ?? [],
        })
      } catch (e) {
        console.error('Search error:', e)
        setSearchResults(null)
      } finally {
        setIsSearching(false)
      }
    }, 350)
    return () => clearTimeout(timer)
  }, [searchQuery, jellyfinConfig, userId])

  return { searchQuery, setSearchQuery, searchResults, isSearching }
}
