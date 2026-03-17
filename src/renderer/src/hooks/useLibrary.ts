import { useState, useRef, useEffect, useCallback } from 'react'
import type { JellyfinConfig, Artist, Album, Playlist, PaginationState, LibraryStats, LibraryTab, ItemTypeIndex } from '../appTypes'
import { jellyfinHeaders, buildUrl, PAGE_SIZE } from '../utils/jellyfin'

export function useLibrary(jellyfinConfig: JellyfinConfig | null, userId: string | null) {
  const [artists, setArtists] = useState<Artist[]>([])
  const [albums, setAlbums] = useState<Album[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [activeLibrary, setActiveLibrary] = useState<LibraryTab>('artists')
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [loadedTabs, setLoadedTabs] = useState<Set<LibraryTab>>(new Set(['artists']))
  const [error, setError] = useState<string | null>(null)

  const [pagination, setPagination] = useState<PaginationState>({
    artists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    albums: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    playlists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
  })

  const itemTypeIndexRef = useRef<ItemTypeIndex>({
    artists: new Set(),
    albums: new Set(),
    playlists: new Set(),
  })

  const [itemTypeIndex, setItemTypeIndex] = useState<ItemTypeIndex>({
    artists: new Set(),
    albums: new Set(),
    playlists: new Set(),
  })

  const contentScrollRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)

  const loadStats = async (url: string, apiKey: string, uid: string): Promise<void> => {
    const headers = jellyfinHeaders(apiKey)
    const baseUrl = url.replace(/\/$/, '')
    const safeUserId = uid.trim()
    if (!safeUserId) return
    try {
      const res = await fetch(buildUrl(baseUrl, `/Users/${safeUserId}/Items/Counts`), { headers })
      if (res.ok) {
        const data = await res.json()
        setStats({
          ArtistCount: data.ArtistCount || 0,
          AlbumCount: data.AlbumCount || 0,
          SongCount: data.ChildCount || data.TotalCount || 0,
          PlaylistCount: data.PlaylistCount || 0,
          ItemCount: data.ItemCount || 0,
        })
      } else {
        setStats(null)
      }
    } catch {
      setStats(null)
    }
  }

  const updateArtistIndex = (items: Artist[]) => {
    itemTypeIndexRef.current.artists = new Set([...itemTypeIndexRef.current.artists, ...items.map(a => a.Id)])
    setItemTypeIndex(prev => {
      const s = new Set(prev.artists)
      items.forEach(a => s.add(a.Id))
      return { ...prev, artists: s }
    })
  }

  const updateAlbumIndex = (items: Album[]) => {
    itemTypeIndexRef.current.albums = new Set([...itemTypeIndexRef.current.albums, ...items.map(a => a.Id)])
    setItemTypeIndex(prev => {
      const s = new Set(prev.albums)
      items.forEach(a => s.add(a.Id))
      return { ...prev, albums: s }
    })
  }

  const updatePlaylistIndex = (items: Playlist[]) => {
    itemTypeIndexRef.current.playlists = new Set([...itemTypeIndexRef.current.playlists, ...items.map(p => p.Id)])
    setItemTypeIndex(prev => {
      const s = new Set(prev.playlists)
      items.forEach(p => s.add(p.Id))
      return { ...prev, playlists: s }
    })
  }

  const loadLibrary = async (url: string, apiKey: string, uid: string): Promise<void> => {
    const headers = jellyfinHeaders(apiKey)
    const baseUrl = url.replace(/\/$/, '')

    setPagination({
      artists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
      albums: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
      playlists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    })
    itemTypeIndexRef.current = { artists: new Set(), albums: new Set(), playlists: new Set() }
    setLoadedTabs(new Set(['artists', 'albums', 'playlists']))

    try {
      const res = await fetch(buildUrl(baseUrl, `/Artists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=0`), { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const items: Artist[] = data.Items || []
      setArtists(items)
      itemTypeIndexRef.current.artists = new Set(items.map(a => a.Id))
      updateArtistIndex(items)
      setPagination(prev => ({
        ...prev,
        artists: { items, total: data.TotalRecordCount || items.length, startIndex: PAGE_SIZE, hasMore: items.length < (data.TotalRecordCount || items.length), scrollPos: 0 },
      }))
    } catch (e) {
      console.error('Failed to load artists:', e)
      setError('Error loading artists')
      setArtists([])
    }

    try {
      const res = await fetch(buildUrl(baseUrl, `/Items?IncludeItemTypes=MusicAlbum&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true`), { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const items: Album[] = data.Items || []
      setAlbums(items)
      itemTypeIndexRef.current.albums = new Set(items.map(a => a.Id))
      updateAlbumIndex(items)
      setPagination(prev => ({
        ...prev,
        albums: { items, total: data.TotalRecordCount || items.length, startIndex: PAGE_SIZE, hasMore: items.length < (data.TotalRecordCount || items.length), scrollPos: 0 },
      }))
    } catch (e) {
      console.error('Failed to load albums:', e)
      setAlbums([])
    }

    try {
      const res = await fetch(buildUrl(baseUrl, `/Items?IncludeItemTypes=Playlist&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true`), { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const items: Playlist[] = data.Items || []
      setPlaylists(items)
      itemTypeIndexRef.current.playlists = new Set(items.map(p => p.Id))
      updatePlaylistIndex(items)
      setPagination(prev => ({
        ...prev,
        playlists: { items, total: data.TotalRecordCount || items.length, startIndex: PAGE_SIZE, hasMore: items.length < (data.TotalRecordCount || items.length), scrollPos: 0 },
      }))
    } catch (e) {
      console.error('Failed to load playlists:', e)
      setPlaylists([])
    }
  }

  const loadTab = async (tab: LibraryTab): Promise<void> => {
    if (!jellyfinConfig || !userId) return
    const headers = jellyfinHeaders(jellyfinConfig.apiKey)
    const baseUrl = jellyfinConfig.url.replace(/\/$/, '')

    if (loadedTabs.has(tab)) {
      setTimeout(() => {
        const scrollPos = pagination[tab].scrollPos
        if (contentScrollRef.current && scrollPos > 0) {
          contentScrollRef.current.scrollTop = scrollPos
        }
      }, 0)
      return
    }

    try {
      if (tab === 'artists') {
        const res = await fetch(buildUrl(baseUrl, `/Artists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=0`), { headers })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const items: Artist[] = data.Items || []
        setArtists(items)
        updateArtistIndex(items)
        setPagination(prev => ({
          ...prev,
          artists: { items, total: data.TotalRecordCount || items.length, startIndex: PAGE_SIZE, hasMore: items.length < (data.TotalRecordCount || items.length), scrollPos: 0 },
        }))
      } else if (tab === 'albums') {
        const res = await fetch(buildUrl(baseUrl, `/Items?IncludeItemTypes=MusicAlbum&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true`), { headers })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const items: Album[] = data.Items || []
        setAlbums(items)
        updateAlbumIndex(items)
        setPagination(prev => ({
          ...prev,
          albums: { items, total: data.TotalRecordCount || items.length, startIndex: PAGE_SIZE, hasMore: items.length < (data.TotalRecordCount || items.length), scrollPos: 0 },
        }))
      } else {
        const res = await fetch(buildUrl(baseUrl, `/Items?IncludeItemTypes=Playlist&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true`), { headers })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const items: Playlist[] = data.Items || []
        setPlaylists(items)
        updatePlaylistIndex(items)
        setPagination(prev => ({
          ...prev,
          playlists: { items, total: data.TotalRecordCount || items.length, startIndex: PAGE_SIZE, hasMore: items.length < (data.TotalRecordCount || items.length), scrollPos: 0 },
        }))
      }
      setLoadedTabs(prev => new Set(prev).add(tab))
    } catch (e) {
      console.error(`Failed to load ${tab}:`, e)
    }
  }

  const loadMore = useCallback(async (type: LibraryTab): Promise<void> => {
    if (!jellyfinConfig || !userId || isLoadingMore) return
    const currentPagination = pagination[type]
    if (!currentPagination.hasMore) return

    setIsLoadingMore(true)
    const headers = jellyfinHeaders(jellyfinConfig.apiKey)
    const baseUrl = jellyfinConfig.url.replace(/\/$/, '')
    const startIndex = currentPagination.startIndex

    try {
      let endpoint = ''
      if (type === 'artists') endpoint = `/Artists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=${startIndex}`
      else if (type === 'albums') endpoint = `/Items?IncludeItemTypes=MusicAlbum&Limit=${PAGE_SIZE}&StartIndex=${startIndex}&Recursive=true`
      else endpoint = `/Items?IncludeItemTypes=Playlist&Limit=${PAGE_SIZE}&StartIndex=${startIndex}&Recursive=true`

      const res = await fetch(buildUrl(baseUrl, endpoint), { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const newItems: Array<Artist | Album | Playlist> = data.Items || []
      const existingIds = new Set(currentPagination.items.map(item => item.Id))
      const uniqueNewItems = newItems.filter(item => !existingIds.has(item.Id))

      if (type === 'artists') updateArtistIndex(uniqueNewItems as Artist[])
      else if (type === 'albums') updateAlbumIndex(uniqueNewItems as Album[])
      else updatePlaylistIndex(uniqueNewItems as Playlist[])

      setPagination(prev => ({
        ...prev,
        [type]: {
          items: [...prev[type].items, ...uniqueNewItems],
          total: data.TotalRecordCount || prev[type].total,
          startIndex: startIndex + uniqueNewItems.length,
          hasMore: (startIndex + uniqueNewItems.length) < (data.TotalRecordCount || prev[type].total),
          scrollPos: prev[type].scrollPos,
        },
      }))
    } catch (e) {
      console.error(`Failed to load more ${type}:`, e)
    } finally {
      setIsLoadingMore(false)
    }
  }, [jellyfinConfig, userId, pagination, isLoadingMore])

  const handleTabChange = (newTab: LibraryTab): void => {
    if (contentScrollRef.current) {
      const currentScroll = contentScrollRef.current.scrollTop
      setPagination(prev => ({
        ...prev,
        [activeLibrary]: { ...prev[activeLibrary], scrollPos: currentScroll },
      }))
    }
    setActiveLibrary(newTab)
  }

  // Sync pagination items to state arrays
  useEffect(() => {
    if (loadedTabs.has('artists')) setArtists(pagination.artists.items)
    if (loadedTabs.has('albums')) setAlbums(pagination.albums.items)
    if (loadedTabs.has('playlists')) setPlaylists(pagination.playlists.items)
  }, [loadedTabs, pagination.artists.items, pagination.albums.items, pagination.playlists.items])

  // Infinite scroll observer
  useEffect(() => {
    if (!loadMoreRef.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isLoadingMore) {
          if (activeLibrary === 'artists' && pagination.artists.hasMore && loadedTabs.has('artists')) loadMore('artists')
          else if (activeLibrary === 'albums' && pagination.albums.hasMore && loadedTabs.has('albums')) loadMore('albums')
          else if (activeLibrary === 'playlists' && pagination.playlists.hasMore && loadedTabs.has('playlists')) loadMore('playlists')
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(loadMoreRef.current)
    return () => observer.disconnect()
  }, [activeLibrary, pagination, isLoadingMore, loadMore, loadedTabs])

  const uniqueArtists = artists.filter((item, i, self) => i === self.findIndex(t => t.Id === item.Id))
  const uniqueAlbums = albums.filter((item, i, self) => i === self.findIndex(t => t.Id === item.Id))
  const uniquePlaylists = playlists.filter((item, i, self) => i === self.findIndex(t => t.Id === item.Id))

  return {
    artists: uniqueArtists,
    albums: uniqueAlbums,
    playlists: uniquePlaylists,
    stats,
    activeLibrary,
    pagination,
    isLoadingMore,
    loadedTabs,
    error,
    setError,
    itemTypeIndex,
    itemTypeIndexRef,
    contentScrollRef,
    loadMoreRef,
    loadLibrary,
    loadStats,
    loadTab,
    loadMore,
    handleTabChange,
  }
}
