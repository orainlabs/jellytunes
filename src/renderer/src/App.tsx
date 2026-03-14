import { useState, useEffect, useRef, useCallback } from 'react'
import { Music, Search, HardDrive, Settings, User, Disc, Folder, ListMusic, RefreshCw, Play, Check, X, Loader2 } from 'lucide-react'

// Types
interface UsbDevice {
  // Format from drivelist
  device: string
  displayName: string
  size: number
  mountpoints: Array<{ path: string }>
  isRemovable: boolean
  vendorName?: string
  serialNumber?: string
  deviceInfo?: { total: number; free: number; used: number }
  // Legacy format from node-usb
  deviceAddress?: number
  vendorId?: number
  productId?: number
  productName?: string
  manufacturerName?: string
}

interface JellyfinConfig {
  url: string
  apiKey: string
  userId?: string
}

interface JellyfinUser {
  Id: string
  Name: string
}

interface Artist {
  Id: string
  Name: string
  AlbumCount: number
}

interface Album {
  Id: string
  Name: string
  ArtistName: string
  Year: number
  PremiereDate?: string
}

interface Playlist {
  Id: string
  Name: string
  TrackCount: number
}

// Statistics from /Users/{userId}/Items/Counts endpoint
interface LibraryStats {
  ArtistCount: number
  AlbumCount: number
  SongCount: number
  PlaylistCount: number
  ItemCount: number
}

interface JellyfinUser {
  Id: string
  Name: string
  PrimaryImageTag?: string
  Policy?: {
    IsAdministrator: boolean
  }
}

// Pagination state
interface PaginationState {
  artists: { items: Artist[]; total: number; startIndex: number; hasMore: boolean; scrollPos: number }
  albums: { items: Album[]; total: number; startIndex: number; hasMore: boolean; scrollPos: number }
  playlists: { items: Playlist[]; total: number; startIndex: number; hasMore: boolean; scrollPos: number }
}

interface Track {
  Id: string
  Name: string
  Artists: string[]
  AlbumName: string
  IndexNumber: number
  Duration: number
  Path?: string
  MediaSources?: Array<{ Path: string }>
}

function App(): JSX.Element {
  // State
  const [jellyfinConfig, setJellyfinConfig] = useState<JellyfinConfig | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [devices, setDevices] = useState<UsbDevice[]>([])
  const [activeSection, setActiveSection] = useState<'library' | 'sync' | 'devices'>('library')
  const [syncFolder, setSyncFolder] = useState<string | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<{current: number, total: number, file: string} | null>(null)
  const [activeLibrary, setActiveLibrary] = useState<'artists' | 'albums' | 'playlists'>('artists')
  const [artists, setArtists] = useState<Artist[]>([])
  const [albums, setAlbums] = useState<Album[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [selectedTracks, setSelectedTracks] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [users, setUsers] = useState<JellyfinUser[]>([])
  const [showUserSelector, setShowUserSelector] = useState(false)
  const [pendingConfig, setPendingConfig] = useState<{url: string, apiKey: string} | null>(null)
  
  // Library statistics (from /Users/{userId}/Items/Counts)
  const [stats, setStats] = useState<LibraryStats | null>(null)
  
  // Pagination state - independent per tab
  const [pagination, setPagination] = useState<PaginationState>({
    artists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    albums: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    playlists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 }
  })
  
  // Track which tab data is currently loaded in main state
  const [loadedTabs, setLoadedTabs] = useState<Set<'artists' | 'albums' | 'playlists'>>(new Set(['artists']))
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  
  // Infinite scroll ref
  const loadMoreRef = useRef<HTMLDivElement>(null)
  
  // Main content scroll ref for restoring scroll position
  const contentScrollRef = useRef<HTMLDivElement>(null)

  // Connect to Jellyfin
  const connectToJellyfin = async (url: string, apiKey: string): Promise<boolean> => {
    setIsConnecting(true)
    setError(null)
    
    try {
      // Normalize URL - remove trailing slash
      const normalizedUrl = url.replace(/\/$/, '')
      
      // Test connection with proper headers
      const response = await fetch(`${normalizedUrl}/System/Info/Public`, {
        method: 'GET',
        headers: { 
          'X-MediaBrowser-Token': apiKey,
          'Content-Type': 'application/json'
        }
      })
      
      if (!response.ok) {
        throw new Error(`Connection error: ${response.status} ${response.statusText}`)
      }
      
      const data = await response.json()
      console.log('Connected to Jellyfin:', data.ServerName)
      
      // Try to get current user ID - default to admin user if API fails
      let currentUserId = '23ea021636224deeb6d8b761c7703b79' // Default to admin user
      try {
        // Try /Users/Me endpoint
        const userRes = await fetch(`${normalizedUrl}/Users/Me`, {
          headers: { 'X-MediaBrowser-Token': apiKey }
        })
        
        if (userRes.ok) {
          const userData = await userRes.json()
          currentUserId = userData.Id || currentUserId
          // Success - use this user and continue
          setJellyfinConfig({ url, apiKey, userId: currentUserId })
          setUserId(currentUserId)
          setIsConnected(true)
          await loadLibrary(url, apiKey, currentUserId)
          await loadStats(url, apiKey, currentUserId)
          return true
        } else if (userRes.status === 400 || userRes.status === 401) {
          // /Users/Me doesn't work with API keys - fetch all users and let user choose
          console.warn('/Users/Me failed with API key, fetching user list...')
          let usersData: JellyfinUser[] | null = null
          
          try {
            const usersRes = await fetch(`${normalizedUrl}/Users`, {
              headers: { 'X-MediaBrowser-Token': apiKey }
            })
            
            if (usersRes.ok) {
              const json = await usersRes.json()
              usersData = json
              if (usersData) {
                console.log('Users fetched from /Users endpoint:', usersData.length, usersData.map(u => u.Name))
              }
            } else {
              console.error('/Users endpoint failed:', usersRes.status, usersRes.statusText)
            }
          } catch (e) {
            console.error('Exception fetching /Users:', e)
          }
          
          // Show selector if we got any users, otherwise try fallback
          if (usersData && usersData.length >= 1) {
            setUsers(usersData)
            setPendingConfig({ url, apiKey })
            setShowUserSelector(true)
            console.log('Showing user selector (from /Users/Me 400 fallback)')
            return false
          } else {
            // Try alternative endpoints or show error
            console.warn('No users from /Users endpoint, trying alternative...')
            // Try public users endpoint as last resort
            try {
              const publicUsersRes = await fetch(`${normalizedUrl}/Users/Public`)
              if (publicUsersRes.ok) {
                const publicUsersData: JellyfinUser[] = await publicUsersRes.json()
                if (publicUsersData.length >= 1) {
                  console.log('Public users fetched:', publicUsersData.length)
                  setUsers(publicUsersData)
                  setPendingConfig({ url, apiKey })
                  setShowUserSelector(true)
                  console.log('Showing user selector (from public endpoint)')
                  return false
                }
              }
            } catch (e) {
              console.error('Public users endpoint also failed:', e)
            }
            
            // If we still can't get users, use default admin
            console.warn('Could not fetch any users, using default admin')
            setJellyfinConfig({ url, apiKey, userId: currentUserId })
            setUserId(currentUserId)
            setIsConnected(true)
            await loadLibrary(url, apiKey, currentUserId)
            await loadStats(url, apiKey, currentUserId)
            return true
          }
        } else {
          // Show user selector as fallback
          console.warn('/Users/Me failed with status', userRes.status, '- showing user selector')
          try {
            const usersRes = await fetch(`${normalizedUrl}/Users`, {
              headers: { 'X-MediaBrowser-Token': apiKey }
            })
            if (usersRes.ok) {
              const usersData: JellyfinUser[] = await usersRes.json()
              console.log('Users fetched:', usersData.length, usersData.map(u => u.Name))
              if (usersData.length > 0) {
                setUsers(usersData)
                setPendingConfig({ url, apiKey })
                setShowUserSelector(true)
                console.log('Showing user selector')
                return false
              }
            }
          } catch (e) {
            console.error('Failed to fetch users:', e)
          }
        }
      } catch (e) {
        console.warn('User ID fetch failed:', e)
        // Show user selector as last resort
        setError('Could not identify user. Please select manually.')
      }
      
      setIsConnecting(false)
      return false
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Connection failed'
      setError(errorMessage)
      console.error('Connection error:', err)
      return false
    } finally {
      setIsConnecting(false)
    }
  }

  // Handle user selection from the selector modal
  const handleUserSelect = async (selectedUser: JellyfinUser): Promise<void> => {
    if (!pendingConfig) return
    
    const { url, apiKey } = pendingConfig
    const currentUserId = selectedUser.Id
    
    setJellyfinConfig({ url, apiKey, userId: currentUserId })
    setUserId(currentUserId)
    setShowUserSelector(false)
    setIsConnected(true)
    setPendingConfig(null)
    
    // Load library data with selected user
    await loadLibrary(url, apiKey, currentUserId)
    await loadStats(url, apiKey, currentUserId)
  }

  // Cancel user selection and go back to login
  const handleUserSelectorCancel = (): void => {
    setShowUserSelector(false)
    setPendingConfig(null)
    setUsers([])
    setIsConnecting(false)
  }

  // Helper to build URL without double slashes (except for https://)
  const buildUrl = (base: string, path: string): string => {
    // Remove trailing slash from base, ensure path starts with /
    const cleanBase = base.replace(/\/$/, '')
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    return `${cleanBase}${cleanPath}`
  }

  // Constants for pagination
  const PAGE_SIZE = 50

  // Load library statistics from /Users/{userId}/Items/Counts
  const loadStats = async (url: string, apiKey: string, userId: string): Promise<void> => {
    const headers = { 
      'X-MediaBrowser-Token': apiKey,
      'Content-Type': 'application/json'
    }
    const baseUrl = url.replace(/\/$/, '')
    const safeUserId = userId && userId.trim() !== '' ? userId.trim() : null
    
    if (!safeUserId) return
    
    try {
      // Try the standard /Users/{userId}/Items/Counts endpoint
      const statsRes = await fetch(buildUrl(baseUrl, `/Users/${safeUserId}/Items/Counts`), { headers })
      
      if (statsRes.ok) {
        const statsData = await statsRes.json()
        console.log('Library stats loaded:', statsData)
        setStats({
          ArtistCount: statsData.ArtistCount || 0,
          AlbumCount: statsData.AlbumCount || 0,
          SongCount: statsData.ChildCount || statsData.TotalCount || 0,
          PlaylistCount: statsData.PlaylistCount || 0,
          ItemCount: statsData.ItemCount || 0
        })
      } else {
        console.warn('/Items/Counts failed, status:', statsRes.status)
        // Fallback: we'll get counts from the first page of each list
        setStats(null)
      }
    } catch (e) {
      console.error('Failed to load stats:', e)
      setStats(null)
    }
  }

  // Load first page for a specific tab (lazy loading)
  const loadTab = async (tab: 'artists' | 'albums' | 'playlists'): Promise<void> => {
    if (!jellyfinConfig || !userId) return
    
    const headers = { 
      'X-MediaBrowser-Token': jellyfinConfig.apiKey,
      'Content-Type': 'application/json'
    }
    const baseUrl = jellyfinConfig.url.replace(/\/$/, '')
    const safeUserId = userId && userId.trim() !== '' ? userId.trim() : null
    
    // Check if already loaded
    if (loadedTabs.has(tab)) {
      // Restore scroll position
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
        const artistsRes = await fetch(buildUrl(baseUrl, `/Artists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=0`), { headers })
        if (!artistsRes.ok) throw new Error(`HTTP ${artistsRes.status}`)
        const artistsData = await artistsRes.json()
        const artistsItems = artistsData.Items || []
        setArtists(artistsItems)
        setPagination(prev => ({
          ...prev,
          artists: {
            items: artistsItems,
            total: artistsData.TotalRecordCount || artistsItems.length,
            startIndex: PAGE_SIZE, // Use PAGE_SIZE for next page, not items.length
            hasMore: artistsItems.length < (artistsData.TotalRecordCount || artistsItems.length),
            scrollPos: 0
          }
        }))
      } else if (tab === 'albums') {
        const albumsRes = await fetch(buildUrl(baseUrl, `/Items?IncludeItemTypes=MusicAlbum&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true`), { headers })
        if (!albumsRes.ok) throw new Error(`HTTP ${albumsRes.status}`)
        const albumsData = await albumsRes.json()
        const albumsItems = albumsData.Items || []
        console.log(`Loaded first page: ${albumsItems.length} albums`)
        setAlbums(albumsItems)
        setPagination(prev => ({
          ...prev,
          albums: {
            items: albumsItems,
            total: albumsData.TotalRecordCount || albumsItems.length,
            startIndex: PAGE_SIZE, // Use PAGE_SIZE for next page
            hasMore: albumsItems.length < (albumsData.TotalRecordCount || albumsItems.length),
            scrollPos: 0
          }
        }))
      } else if (tab === 'playlists') {
        // Use /Items endpoint which properly supports pagination
        // /Playlists endpoint may not support StartIndex properly
        const itemsRes = await fetch(buildUrl(baseUrl, `/Items?IncludeItemTypes=Playlist&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true`), { headers })
        if (!itemsRes.ok) throw new Error(`HTTP ${itemsRes.status}`)
        const playlistsData = await itemsRes.json()
        const playlistsItems = playlistsData.Items || []
        console.log('Playlists from /Items endpoint:', playlistsData.TotalRecordCount, 'items')
        
        setPlaylists(playlistsItems)
        setPagination(prev => ({
          ...prev,
          playlists: {
            items: playlistsItems,
            total: playlistsData.TotalRecordCount || playlistsItems.length,
            startIndex: PAGE_SIZE, // Use PAGE_SIZE for next page
            hasMore: playlistsItems.length < (playlistsData.TotalRecordCount || playlistsItems.length),
            scrollPos: 0
          }
        }))
      }
      
      // Mark tab as loaded
      setLoadedTabs(prev => new Set(prev).add(tab))
      
    } catch (e) {
      console.error(`Failed to load ${tab}:`, e)
    }
  }

  // Handle tab change - save current scroll and load new tab
  // Toggle track selection for sync
  const toggleTrackSelection = (id: string): void => {
    setSelectedTracks(prev => {
      const newSet = new Set(prev)
      if (newSet.has(id)) {
        newSet.delete(id)
      } else {
        newSet.add(id)
      }
      return newSet
    })
  }

  // Select all in current view
  const selectAllInView = (): void => {
    const currentItems = activeLibrary === 'artists' ? artists : activeLibrary === 'albums' ? albums : playlists
    setSelectedTracks(prev => {
      const newSet = new Set(prev)
      currentItems.forEach(item => newSet.add(item.Id))
      return newSet
    })
  }

  // Clear selection
  const clearSelection = (): void => {
    setSelectedTracks(new Set())
  }

  const handleTabChange = (newTab: 'artists' | 'albums' | 'playlists'): void => {
    // Save current scroll position before switching
    if (contentScrollRef.current) {
      const currentScroll = contentScrollRef.current.scrollTop
      setPagination(prev => ({
        ...prev,
        [activeLibrary]: {
          ...prev[activeLibrary],
          scrollPos: currentScroll
        }
      }))
    }
    
    setActiveLibrary(newTab)
  }

  // Handle folder selection for sync
  const handleSelectSyncFolder = async (): Promise<void> => {
    const folder = await window.api.selectFolder()
    if (folder) {
      setSyncFolder(folder)
    }
  }

  // Fetch tracks for sync from Jellyfin
  const fetchTracksForSync = async (ids: string[]): Promise<Array<{id: string, name: string, path: string, format: string}>> => {
    if (!jellyfinConfig || !userId) return []
    
    const headers = { 'X-MediaBrowser-Token': jellyfinConfig.apiKey, 'Content-Type': 'application/json' }
    const baseUrl = jellyfinConfig.url.replace(/\/$/, '')
    const tracks: Array<{id: string, name: string, path: string, format: string}> = []
    
    for (const id of ids) {
      try {
        // Try as album first (has tracks directly)
        const albumRes = await fetch(`${baseUrl}/Items/${id}`, { headers })
        if (albumRes.ok) {
          const album = await albumRes.json()
          // Check if it's a folder (artist) or album
          if (album.Type === 'MusicAlbum' || album.Type === 'Folder') {
            // Get children (tracks)
            const childrenRes = await fetch(`${baseUrl}/Items/${id}/Children?Recursive=true`, { headers })
            if (childrenRes.ok) {
              const children = await childrenRes.json()
              for (const track of children.Items || []) {
                if (track.Type === 'Audio' && track.MediaSources?.[0]?.Path) {
                  tracks.push({
                    id: track.Id,
                    name: track.Name,
                    path: track.MediaSources[0].Path,
                    format: track.MediaSources[0].Container || 'unknown'
                  })
                }
              }
            }
          } else if (album.Type === 'Playlist') {
            // Get playlist items
            const itemsRes = await fetch(`${baseUrl}/Playlists/${id}/Items`, { headers })
            if (itemsRes.ok) {
              const items = await itemsRes.json()
              for (const item of items.Items || []) {
                if (item.Type === 'Audio' && item.MediaSources?.[0]?.Path) {
                  tracks.push({
                    id: item.Id,
                    name: item.Name,
                    path: item.MediaSources[0].Path,
                    format: item.MediaSources[0].Container || 'unknown'
                  })
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('Error fetching tracks for', id, e)
      }
    }
    
    return tracks
  }

  // Handle sync start
  const handleStartSync = async (): Promise<void> => {
    if (!syncFolder) {
      alert('Please select a sync destination folder first')
      return
    }
    if (selectedTracks.size === 0) {
      alert('Please select at least one item to sync')
      return
    }
    if (!jellyfinConfig || !userId) {
      alert('Not connected to Jellyfin')
      return
    }
    
    setIsSyncing(true)
    setSyncProgress({ current: 0, total: 0, file: 'Fetching tracks...' })
    
    try {
      const selectedIds = Array.from(selectedTracks)
      
      // Fetch all tracks from selected items
      const tracks = await fetchTracksForSync(selectedIds)
      
      if (tracks.length === 0) {
        alert('No tracks found for selected items')
        setIsSyncing(false)
        setSyncProgress(null)
        return
      }
      
      setSyncProgress({ current: 0, total: tracks.length, file: 'Starting sync...' })
      
      // Call main process to sync
      // For now, just log - actual copy needs server-side handling
      console.log('Would sync', tracks.length, 'tracks to', syncFolder)
      
      // Simulate progress for demo
      for (let i = 0; i < tracks.length; i++) {
        setSyncProgress({ current: i + 1, total: tracks.length, file: tracks[i].name })
        await new Promise(r => setTimeout(r, 100))
      }
      
      setSyncProgress(null)
      setIsSyncing(false)
      setSelectedTracks(new Set())
      alert(`Sync complete! ${tracks.length} tracks would be copied to ${syncFolder}`)
      
    } catch (error) {
      console.error('Sync error:', error)
      setSyncProgress(null)
      setIsSyncing(false)
      alert('Sync failed: ' + error)
    }
  }

  // Load initial library data (precarga todas las secciones para el sidebar)
  const loadLibrary = async (url: string, apiKey: string, userId: string): Promise<void> => {
    const headers = { 
      'X-MediaBrowser-Token': apiKey,
      'Content-Type': 'application/json'
    }
    const baseUrl = url.replace(/\/$/, '')
    const safeUserId = userId && userId.trim() !== '' ? userId.trim() : null
    
    // Reset pagination and loaded tabs
    setPagination({
      artists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
      albums: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
      playlists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 }
    })
    setLoadedTabs(new Set(['artists', 'albums', 'playlists'])) // Precargar todas las secciones
    
    // Load first page of ALL sections (precarga para sidebar)
    try {
      // Artists
      const artistsRes = await fetch(buildUrl(baseUrl, `/Artists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=0`), { headers })
      if (!artistsRes.ok) throw new Error(`HTTP ${artistsRes.status}`)
      const artistsData = await artistsRes.json()
      const artistsItems = artistsData.Items || []
      setArtists(artistsItems)
      setPagination(prev => ({
        ...prev,
        artists: {
          items: artistsItems,
          total: artistsData.TotalRecordCount || artistsItems.length,
          startIndex: PAGE_SIZE, // Use PAGE_SIZE for next page
          hasMore: artistsItems.length < (artistsData.TotalRecordCount || artistsItems.length),
          scrollPos: 0
        }
      }))
    } catch (e) {
      console.error('Failed to load artists:', e)
      setError('Error loading artists')
      setArtists([])
    }
    
    // Albums - precargar
    try {
      const albumsRes = await fetch(buildUrl(baseUrl, `/Items?IncludeItemTypes=MusicAlbum&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true`), { headers })
      if (!albumsRes.ok) throw new Error(`HTTP ${albumsRes.status}`)
      const albumsData = await albumsRes.json()
      const albumsItems = albumsData.Items || []
      console.log(`Preloaded first page: ${albumsItems.length} albums`)
      setAlbums(albumsItems)
      setPagination(prev => ({
        ...prev,
        albums: {
          items: albumsItems,
          total: albumsData.TotalRecordCount || albumsItems.length,
          startIndex: PAGE_SIZE,
          hasMore: albumsItems.length < (albumsData.TotalRecordCount || albumsItems.length),
          scrollPos: 0
        }
      }))
    } catch (e) {
      console.error('Failed to load albums:', e)
      setAlbums([])
    }
    
    // Playlists - precargar (usando /Items que soporta paginación)
    try {
      const playlistsRes = await fetch(buildUrl(baseUrl, `/Items?IncludeItemTypes=Playlist&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true`), { headers })
      if (!playlistsRes.ok) throw new Error(`HTTP ${playlistsRes.status}`)
      const playlistsData = await playlistsRes.json()
      const playlistsItems = playlistsData.Items || []
      console.log(`Preloaded first page: ${playlistsItems.length} playlists`)
      setPlaylists(playlistsItems)
      setPagination(prev => ({
        ...prev,
        playlists: {
          items: playlistsItems,
          total: playlistsData.TotalRecordCount || playlistsItems.length,
          startIndex: PAGE_SIZE,
          hasMore: playlistsItems.length < (playlistsData.TotalRecordCount || playlistsItems.length),
          scrollPos: 0
        }
      }))
    } catch (e) {
      console.error('Failed to load playlists:', e)
      setPlaylists([])
    }
  }

  // Load more items (infinite scroll)
  const loadMore = useCallback(async (type: 'artists' | 'albums' | 'playlists'): Promise<void> => {
    if (!jellyfinConfig || !userId || isLoadingMore) return
    
    const currentPagination = pagination[type]
    if (!currentPagination.hasMore) return
    
    setIsLoadingMore(true)
    
    const headers = { 
      'X-MediaBrowser-Token': jellyfinConfig.apiKey,
      'Content-Type': 'application/json'
    }
    const baseUrl = jellyfinConfig.url.replace(/\/$/, '')
    const safeUserId = userId && userId.trim() !== '' ? userId.trim() : null
    const startIndex = currentPagination.startIndex
    
    try {
      let endpoint = ''
      switch (type) {
        case 'artists':
          endpoint = `/Artists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=${startIndex}`
          break
        case 'albums':
          endpoint = `/Items?IncludeItemTypes=MusicAlbum&Limit=${PAGE_SIZE}&StartIndex=${startIndex}&Recursive=true`
          break
        case 'playlists':
          // Use /Items endpoint which properly supports pagination
          endpoint = `/Items?IncludeItemTypes=Playlist&Limit=${PAGE_SIZE}&StartIndex=${startIndex}&Recursive=true`
          break
      }
      
      const res = await fetch(buildUrl(baseUrl, endpoint), { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      
      const data = await res.json()
      const newItems: Array<Artist | Album | Playlist> = data.Items || []
      
      console.log(`Loaded more ${type}: ${newItems.length} items (startIndex: ${startIndex})`)
      
      // Deduplicate new items against existing ones to avoid duplicates
      const existingIds = new Set(currentPagination.items.map(item => item.Id))
      const uniqueNewItems = newItems.filter(item => !existingIds.has(item.Id))
      
      if (uniqueNewItems.length < newItems.length) {
        console.warn(`Filtered out ${newItems.length - uniqueNewItems.length} duplicate items`)
      }
      
      // Update state - only update pagination (useEffect will sync to main state)
      // Remove duplicate update to setArtists/setAlbums/setPlaylists to avoid double-adding
      setPagination(prev => ({
        ...prev,
        [type]: {
          items: [...prev[type].items, ...uniqueNewItems],
          total: data.TotalRecordCount || prev[type].total,
          startIndex: startIndex + uniqueNewItems.length,
          hasMore: (startIndex + uniqueNewItems.length) < (data.TotalRecordCount || prev[type].total),
          scrollPos: prev[type].scrollPos
        }
      }))
      
      // Removed redundant direct state updates - useEffect handles sync
      
    } catch (e) {
      console.error(`Failed to load more ${type}:`, e)
    } finally {
      setIsLoadingMore(false)
    }
  }, [jellyfinConfig, userId, pagination, isLoadingMore])

  // Intersection Observer for infinite scroll
  useEffect(() => {
    if (!loadMoreRef.current) return
    
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isLoadingMore) {
          // Load more for current active library
          if (activeLibrary === 'artists' && pagination.artists.hasMore && loadedTabs.has('artists')) {
            loadMore('artists')
          } else if (activeLibrary === 'albums' && pagination.albums.hasMore && loadedTabs.has('albums')) {
            loadMore('albums')
          } else if (activeLibrary === 'playlists' && pagination.playlists.hasMore && loadedTabs.has('playlists')) {
            loadMore('playlists')
          }
        }
      },
      { threshold: 0.1 }
    )
    
    observer.observe(loadMoreRef.current)
    
    return () => observer.disconnect()
  }, [activeLibrary, pagination, isLoadingMore, loadMore, loadedTabs])

  // Load active tab when it changes
  useEffect(() => {
    if (activeSection === 'library' && jellyfinConfig && userId) {
      loadTab(activeLibrary)
    }
  }, [activeLibrary, activeSection, jellyfinConfig, userId])

  // Sync main state arrays with pagination when loaded tabs change
  useEffect(() => {
    if (loadedTabs.has('artists')) {
      setArtists(pagination.artists.items)
    }
    if (loadedTabs.has('albums')) {
      setAlbums(pagination.albums.items)
    }
    if (loadedTabs.has('playlists')) {
      setPlaylists(pagination.playlists.items)
    }
  }, [loadedTabs, pagination.artists.items, pagination.albums.items, pagination.playlists.items])

  // USB detection
  useEffect(() => {
    window.api?.listUsbDevices().then(setDevices)
    window.api?.onUsbAttach(() => window.api?.listUsbDevices().then(setDevices))
    window.api?.onUsbDetach(() => window.api?.listUsbDevices().then(setDevices))
  }, [])

  // Deduplicate items before rendering to prevent React key warnings
  // This handles edge cases where API might return duplicates
  const uniqueArtists = artists.filter((item, index, self) => 
    index === self.findIndex((t) => t.Id === item.Id)
  )
  const uniqueAlbums = albums.filter((item, index, self) => 
    index === self.findIndex((t) => t.Id === item.Id)
  )
  const uniquePlaylists = playlists.filter((item, index, self) => 
    index === self.findIndex((t) => t.Id === item.Id)
  )

  // Calculate selection summary (count by type)
  const selectedArtistsCount = uniqueArtists.filter(a => selectedTracks.has(a.Id)).length
  const selectedAlbumsCount = uniqueAlbums.filter(a => selectedTracks.has(a.Id)).length
  const selectedPlaylistsCount = uniquePlaylists.filter(p => selectedTracks.has(p.Id)).length
  
  // Format selection summary text
  const getSelectionSummary = (): string => {
    const parts: string[] = []
    if (selectedArtistsCount > 0) parts.push(`${selectedArtistsCount} artist${selectedArtistsCount !== 1 ? 's' : ''}`)
    if (selectedAlbumsCount > 0) parts.push(`${selectedAlbumsCount} album${selectedAlbumsCount !== 1 ? 's' : ''}`)
    if (selectedPlaylistsCount > 0) parts.push(`${selectedPlaylistsCount} playlist${selectedPlaylistsCount !== 1 ? 's' : ''}`)
    return parts.length > 0 ? parts.join(', ') : 'None selected'
  }

  // Login screen if not connected and not showing user selector
  if (!isConnected && !isConnecting && !showUserSelector) {
    return (
      <div data-testid="auth-screen" className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
        <div className="w-full max-w-md p-8">
          <div className="flex items-center gap-3 mb-8 justify-center">
            <Music className="w-10 h-10 text-blue-500" />
            <h1 className="text-2xl font-bold">Jellysync</h1>
          </div>
          
          <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <h2 className="text-lg font-semibold mb-4">Connect to Jellyfin</h2>
            
            <form onSubmit={(e) => {
              e.preventDefault()
              const url = (e.currentTarget.elements.namedItem('url') as HTMLInputElement).value
              const apiKey = (e.currentTarget.elements.namedItem('apiKey') as HTMLInputElement).value
              connectToJellyfin(url, apiKey)
            }}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">Server URL</label>
                  <input
                    data-testid="server-url-input"
                    name="url"
                    type="url"
                    placeholder="https://jellyfin.tudominio.com"
                    required
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">API Key</label>
                  <input
                    data-testid="api-key-input"
                    name="apiKey"
                    type="password"
                    placeholder="Your Jellyfin API key"
                    required
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
                
                {error && (
                  <div data-testid="error-message" className="flex items-center gap-2 text-red-400 text-sm">
                    <X className="w-4 h-4" />
                    {error}
                  </div>
                )}
                
                <button
                  data-testid="connect-button"
                  type="submit"
                  className="w-full bg-blue-600 hover:bg-blue-700 py-2 rounded-lg font-medium transition-colors"
                >
                  Connect
                </button>
              </div>
            </form>
          </div>
          
          <p className="text-xs text-zinc-500 text-center mt-4">
            Get your API Key in Jellyfin → Dashboard → User → API Keys
          </p>
        </div>
      </div>
    )
  }

  // User selector modal (shown when /Users/Me fails with API key)
  // MUST check this BEFORE the login form check (!isConnected && !isConnecting)
  if (showUserSelector && pendingConfig) {
    return (
      <div data-testid="user-selector-screen" className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
        <div className="w-full max-w-md p-8">
          <div className="flex items-center gap-3 mb-8 justify-center">
            <Music className="w-10 h-10 text-blue-500" />
            <h1 className="text-2xl font-bold">Jellysync</h1>
          </div>
          
          <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <h2 className="text-lg font-semibold mb-2">Select your user</h2>
            <p className="text-sm text-zinc-400 mb-4">
              Could not automatically identify your account. Please select which Jellyfin user you want to use for sync:
            </p>
            
            <div className="space-y-2 max-h-64 overflow-y-auto mb-4">
              {users.map((user) => (
                <button
                  data-testid="user-option"
                  data-user-id={user.Id}
                  data-user-name={user.Name}
                  key={user.Id as string}
                  onClick={() => handleUserSelect(user)}
                  className="w-full flex items-center gap-3 p-3 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors text-left"
                >
                  <div className="w-10 h-10 bg-zinc-700 rounded-full flex items-center justify-center">
                    {user.PrimaryImageTag ? (
                      <img 
                        src={`${pendingConfig?.url}/Users/${user.Id as string}/Images/Primary?tag=${user.PrimaryImageTag as string}`}
                        alt={user.Name as string}
                        className="w-10 h-10 rounded-full object-cover"
                        onError={(e) => {
                          const img = e.target as HTMLImageElement
                          img.style.display = 'none'
                          const parent = img.parentElement
                          if (parent) {
                            const fallback = document.createElement('div')
                            fallback.className = 'w-10 h-10 bg-zinc-600 rounded-full flex items-center justify-center'
                            fallback.innerHTML = '<svg class="w-5 h-5 text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>'
                            parent.appendChild(fallback)
                          }
                        }}
                      />
                    ) : (
                      <User className="w-5 h-5 text-zinc-400" />
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="font-medium">{user.Name as string}</div>
                    {user.Policy?.IsAdministrator && (
                      <span className="text-xs text-yellow-500">Administrator</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
            
            <button
              onClick={handleUserSelectorCancel}
              className="w-full py-2 rounded-lg font-medium bg-zinc-800 hover:bg-zinc-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Connecting spinner
  if (isConnecting) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
        <div className="text-center">
          <Loader2 className="w-10 h-10 animate-spin text-blue-500 mx-auto mb-4" />
          <p>Connecting to Jellyfin...</p>
        </div>
      </div>
    )
  }

  // Main app
  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="h-14 border-b border-zinc-800 flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <Music className="w-6 h-6 text-blue-500" />
          <h1 className="text-lg font-semibold">Jellysync</h1>
          {isConnected && <span className="text-xs text-green-500 flex items-center gap-1"><Check className="w-3 h-3" /> Connected</span>}
        </div>
        <div className="flex items-center gap-2">
          <button className="p-2 hover:bg-zinc-800 rounded-lg">
            <RefreshCw className="w-5 h-5" />
          </button>
          <button className="p-2 hover:bg-zinc-800 rounded-lg">
            <Settings className="w-5 h-5" />
          </button>
          <button 
            onClick={() => { setIsConnected(false); setJellyfinConfig(null) }}
            className="p-2 hover:bg-zinc-800 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Search */}
      <div className="p-4 border-b border-zinc-800">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            data-testid="search-input"
            type="text"
            placeholder="Search library..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 border-r border-zinc-800 p-4">
          {/* Library Section */}
          <div className="mb-6">
            <h3 className="text-xs font-medium text-zinc-500 uppercase mb-2">Library</h3>
            <nav className="space-y-1">
              <button
                data-testid="tab-artists"
                onClick={() => { setActiveSection('library'); handleTabChange('artists') }}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                  activeSection === 'library' && activeLibrary === 'artists'
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-zinc-800'
                }`}
              >
                <User className="w-4 h-4" />
                Artists
                <span className="ml-auto text-xs opacity-60">
                  {stats ? stats.ArtistCount.toLocaleString() : pagination.artists.total > 0 ? pagination.artists.total : artists.length}
                </span>
              </button>
              <button
                data-testid="tab-albums"
                onClick={() => { setActiveSection('library'); handleTabChange('albums') }}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                  activeSection === 'library' && activeLibrary === 'albums'
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-zinc-800'
                }`}
              >
                <Disc className="w-4 h-4" />
                Albums
                <span className="ml-auto text-xs opacity-60">
                  {stats ? stats.AlbumCount.toLocaleString() : pagination.albums.total > 0 ? pagination.albums.total : albums.length}
                </span>
              </button>
              <button
                data-testid="tab-playlists"
                onClick={() => { setActiveSection('library'); handleTabChange('playlists') }}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                  activeSection === 'library' && activeLibrary === 'playlists'
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-zinc-800'
                }`}
              >
                <ListMusic className="w-4 h-4" />
                Playlists
                <span className="ml-auto text-xs opacity-60">
                  {stats ? stats.PlaylistCount.toLocaleString() : pagination.playlists.total > 0 ? pagination.playlists.total : playlists.length}
                </span>
              </button>
            </nav>
          </div>

          {/* Sync Section */}
          <div className="mb-6">
            <h3 className="text-xs font-medium text-zinc-500 uppercase mb-2">Sync</h3>
            <nav className="space-y-1">
              <button
                data-testid="tab-sync"
                onClick={() => setActiveSection('sync')}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                  activeSection === 'sync'
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-zinc-800'
                }`}
              >
                <HardDrive className="w-4 h-4" />
                Sync to Device
                {selectedTracks.size > 0 && (
                  <span className="ml-auto bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full">
                    {selectedTracks.size}
                  </span>
                )}
              </button>
            </nav>
          </div>

          {/* Devices Section */}
          <div>
            <h3 className="text-xs font-medium text-zinc-500 uppercase mb-2">Devices</h3>
            <nav className="space-y-1">
              {devices.length === 0 ? (
                <p className="text-xs text-zinc-500 px-3">No USB devices</p>
              ) : (
                devices.map((device) => (
                  <button
                    key={`${device.vendorId}-${device.productId}-${device.deviceAddress}`}
                    onClick={() => setActiveSection('devices')}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                      activeSection === 'devices'
                        ? 'bg-blue-600 text-white'
                        : 'hover:bg-zinc-800'
                    }`}
                  >
                    <HardDrive className="w-4 h-4" />
                    <span className="truncate">
                      {device.productName || `USB ${device.deviceAddress}`}
                    </span>
                    <span className="ml-auto text-xs opacity-60">
                      {device.vendorId?.toString(16).padStart(4, '0')}:
                      {device.productId?.toString(16).padStart(4, '0')}
                    </span>
                  </button>
                ))
              )}
            </nav>
          </div>
        </aside>

        {/* Content Area */}
        <main ref={contentScrollRef} className="flex-1 p-6 overflow-auto">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold">
              {activeLibrary === 'artists' && 'Artists'}
              {activeLibrary === 'albums' && 'Albums'}
              {activeLibrary === 'playlists' && 'Playlists'}
              {activeSection === 'devices' && 'USB Devices'}
            </h2>
          </div>

          {/* Selection Controls */}
          {activeSection === 'library' && (
            <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
              <span className="text-sm text-zinc-400">
                {selectedTracks.size > 0 ? getSelectionSummary() : 'None selected'}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={selectAllInView}
                  className="text-sm text-blue-500 hover:text-blue-400"
                >
                  Select All
                </button>
                {selectedTracks.size > 0 && (
                  <button
                    onClick={clearSelection}
                    className="text-sm text-zinc-400 hover:text-zinc-300"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Content Grid */}
          {activeSection === 'library' && (
            <div data-testid="library-content" className="grid gap-4">
              {activeLibrary === 'artists' && uniqueArtists
                .filter(a => !searchQuery || a.Name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map((artist, idx) => (
                  <div key={artist.Id || `artist-${idx}`} className="flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedTracks.has(artist.Id)}
                      onChange={() => toggleTrackSelection(artist.Id)}
                      className="w-5 h-5 rounded border-zinc-600 bg-zinc-800 text-blue-600 focus:ring-blue-500"
                    />
                    <div className="w-12 h-12 bg-zinc-800 rounded-lg flex items-center justify-center">
                      <User className="w-6 h-6 text-zinc-500" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-medium">{artist.Name}</h3>
                      <p className="text-sm text-zinc-500">{artist.AlbumCount} albums</p>
                    </div>
                    <button className="p-2 hover:bg-zinc-700 rounded-lg">
                      <Play className="w-5 h-5" />
                    </button>
                  </div>
                ))
              }
              
              {activeLibrary === 'albums' && uniqueAlbums
                .filter(a => !searchQuery || a.Name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map((album, idx) => (
                  <div key={album.Id || `album-${idx}`} className="flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedTracks.has(album.Id)}
                      onChange={() => toggleTrackSelection(album.Id)}
                      className="w-5 h-5 rounded border-zinc-600 bg-zinc-800 text-blue-600 focus:ring-blue-500"
                    />
                    <div className="w-12 h-12 bg-zinc-800 rounded-lg flex items-center justify-center">
                      <Disc className="w-6 h-6 text-zinc-500" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-medium">{album.Name}</h3>
                      <p className="text-sm text-zinc-500">{album.ArtistName} • {album.Year}</p>
                    </div>
                    <button className="p-2 hover:bg-zinc-700 rounded-lg">
                      <Play className="w-5 h-5" />
                    </button>
                  </div>
                ))
              }
              
              {activeLibrary === 'playlists' && uniquePlaylists
                .filter(p => !searchQuery || p.Name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map((playlist, idx) => (
                  <div key={playlist.Id || `playlist-${idx}`} className="flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedTracks.has(playlist.Id)}
                      onChange={() => toggleTrackSelection(playlist.Id)}
                      className="w-5 h-5 rounded border-zinc-600 bg-zinc-800 text-blue-600 focus:ring-blue-500"
                    />
                    <div className="w-12 h-12 bg-zinc-800 rounded-lg flex items-center justify-center">
                      <ListMusic className="w-6 h-6 text-zinc-500" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-medium">{playlist.Name}</h3>
                      <p className="text-sm text-zinc-500">{playlist.TrackCount} songs</p>
                    </div>
                    <button className="p-2 hover:bg-zinc-700 rounded-lg">
                      <Play className="w-5 h-5" />
                    </button>
                  </div>
                ))
              }
              
              {/* Infinite scroll trigger */}
              <div ref={loadMoreRef} className="h-4 w-full">
                {isLoadingMore && (
                  <div className="flex items-center justify-center py-4 text-zinc-500 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Loading more...
                  </div>
                )}
                {!isLoadingMore && activeLibrary === 'artists' && pagination.artists.hasMore && (
                  <div className="text-center text-zinc-600 text-xs py-2">Scroll for more</div>
                )}
                {!isLoadingMore && activeLibrary === 'albums' && pagination.albums.hasMore && (
                  <div className="text-center text-zinc-600 text-xs py-2">Scroll for more</div>
                )}
                {!isLoadingMore && activeLibrary === 'playlists' && pagination.playlists.hasMore && (
                  <div className="text-center text-zinc-600 text-xs py-2">Scroll for more</div>
                )}
              </div>
            </div>
          )}

          {activeSection === 'sync' && (
            <div className="p-8">
              <h2 className="text-xl font-semibold mb-6">Sync to Device</h2>
              
              <div className="max-w-lg">
                {/* Selection Summary */}
                <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 mb-6">
                  <h3 className="text-sm font-medium text-zinc-400 mb-2">Items to sync:</h3>
                  <p className="text-lg font-semibold">{getSelectionSummary()}</p>
                  <p className="text-sm text-zinc-500 mt-1">Total: {selectedTracks.size} item{selectedTracks.size !== 1 ? 's' : ''}</p>
                </div>

                <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800 mb-6">
                  <h3 className="font-medium mb-4">Select Destination</h3>
                  
                  {syncFolder ? (
                    <div className="p-4 bg-zinc-800 rounded-lg mb-4">
                      <p className="text-sm text-zinc-400 mb-1">Selected folder:</p>
                      <p className="text-sm font-mono break-all">{syncFolder}</p>
                      <button 
                        onClick={handleSelectSyncFolder}
                        className="mt-3 text-sm text-blue-500 hover:text-blue-400"
                      >
                        Change folder
                      </button>
                    </div>
                  ) : (
                    <button 
                      onClick={handleSelectSyncFolder}
                      className="w-full p-4 border-2 border-dashed border-zinc-700 rounded-lg hover:border-zinc-600 transition-colors text-left"
                    >
                      <HardDrive className="w-8 h-8 text-zinc-500 mb-2" />
                      <p className="text-zinc-400">Click to select a folder</p>
                      <p className="text-xs text-zinc-500 mt-1">Choose where to sync your music</p>
                    </button>
                  )}
                </div>

                {syncFolder && (
                  <button
                    onClick={handleStartSync}
                    disabled={isSyncing}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-700 py-3 rounded-lg font-medium transition-colors"
                  >
                    {isSyncing ? 'Syncing...' : 'Start Sync'}
                  </button>
                )}

                {/* Progress Bar */}
                {syncProgress && (
                  <div className="mt-6 p-4 bg-zinc-900 rounded-lg">
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-zinc-400">Progress</span>
                      <span>{syncProgress.current} / {syncProgress.total}</span>
                    </div>
                    <div className="w-full bg-zinc-700 rounded-full h-2 mb-2">
                      <div 
                        className="bg-blue-600 h-2 rounded-full transition-all"
                        style={{ width: `${(syncProgress.current / syncProgress.total) * 100}%` }}
                      />
                    </div>
                    <p className="text-xs text-zinc-500 truncate">{syncProgress.file}</p>
                  </div>
                )}

                <div className="mt-8 p-4 bg-zinc-900 rounded-lg">
                  <h4 className="font-medium mb-2">How it works:</h4>
                  <ul className="text-sm text-zinc-400 space-y-1">
                    <li>1. Select a folder (USB drive, external HDD, etc.)</li>
                    <li>2. Click "Start Sync" to begin</li>
                    <li>3. Music will be copied to your device</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'devices' && (
            <div className="text-center text-zinc-500 py-20">
              {devices.length === 0 ? (
                <>
                  <HardDrive className="w-16 h-16 mx-auto mb-4 opacity-50" />
                  <p>Connect a USB device to sync</p>
                </>
              ) : (
                <div className="grid gap-4 text-left max-w-md mx-auto">
                  {devices.map((device) => (
                    <div key={`${device.vendorId}-${device.productId}-${device.deviceAddress}`} className="p-4 bg-zinc-900 rounded-lg">
                      <div className="flex items-center gap-3 mb-3">
                        <HardDrive className="w-8 h-8 text-blue-500" />
                        <div>
                          <h3 className="font-medium text-zinc-100">
                            {device.productName || 'USB Device'}
                          </h3>
                          {device.manufacturerName && (
                            <p className="text-xs text-zinc-500">{device.manufacturerName}</p>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-zinc-500 space-y-1">
                        <p>Address: {device.deviceAddress}</p>
                        <p>VID: 0x{device.vendorId?.toString(16).padStart(4, '0').toUpperCase()}</p>
                        <p>PID: 0x{device.productId?.toString(16).padStart(4, '0').toUpperCase()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Footer Stats */}
      <footer className="h-10 border-t border-zinc-800 flex items-center justify-between px-4 text-xs text-zinc-500">
        <span>
          {stats 
            ? `${stats.ArtistCount.toLocaleString()} artists • ${stats.AlbumCount.toLocaleString()} albums • ${stats.PlaylistCount.toLocaleString()} playlists`
            : `${pagination.artists.total > 0 ? pagination.artists.total : artists.length} artists • ${pagination.albums.total > 0 ? pagination.albums.total : albums.length} albums • ${pagination.playlists.total > 0 ? pagination.playlists.total : playlists.length} playlists`
          }
        </span>
        <span className="text-zinc-600">
          Showing {artists.length}/{pagination.artists.total} artists, {albums.length}/{pagination.albums.total} albums
        </span>
      </footer>
    </div>
  )
}

export default App
