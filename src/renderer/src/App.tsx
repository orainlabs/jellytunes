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
  // A1 — FLAC→MP3 conversion options
  const [convertToMp3, setConvertToMp3] = useState(false)
  const [bitrate, setBitrate] = useState<'128k' | '192k' | '320k'>('192k')
  // A2 — server-side search results
  const [searchResults, setSearchResults] = useState<{ artists: Artist[]; albums: Album[]; playlists: Playlist[] } | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  // B1 — preview modal before sync
  const [showPreview, setShowPreview] = useState(false)
  const [previewData, setPreviewData] = useState<{ trackCount: number; totalBytes: number; formatBreakdown: Record<string, number>; alreadySyncedCount: number } | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [users, setUsers] = useState<JellyfinUser[]>([])
  const [showUserSelector, setShowUserSelector] = useState(false)
  const [pendingConfig, setPendingConfig] = useState<{url: string, apiKey: string} | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  
  // Library statistics (from /Users/{userId}/Items/Counts)
  const [stats, setStats] = useState<LibraryStats | null>(null)
  
  // Item type index for O(1) lookup during sync
  // useRef para mantener referencia actualizada inmediatamente (evita timing issues del closure)
  const itemTypeIndexRef = useRef<{
    artists: Set<string>
    albums: Set<string>
    playlists: Set<string>
  }>({
    artists: new Set(),
    albums: new Set(),
    playlists: new Set()
  })
  
  const [itemTypeIndex, setItemTypeIndex] = useState<{
    artists: Set<string>
    albums: Set<string>
    playlists: Set<string>
  }>({
    artists: new Set(),
    albums: new Set(),
    playlists: new Set()
  })
  
  // Pagination state - independent per tab
  const [pagination, setPagination] = useState<PaginationState>({
    artists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    albums: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    playlists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 }
  })
  
  // Load saved config on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('jellysync-config')
      if (saved) {
        const { url, apiKey } = JSON.parse(saved)
        if (url && apiKey) {
          setPendingConfig({ url, apiKey })
          setUrlInput(url)
          setApiKeyInput(apiKey)
        }
      }
    } catch (e) { /* ignore */ }
  }, [])
  
  // Save config when connected
  useEffect(() => {
    if (jellyfinConfig?.url && jellyfinConfig?.apiKey) {
      try {
        localStorage.setItem('jellysync-config', JSON.stringify({
          url: jellyfinConfig.url,
          apiKey: jellyfinConfig.apiKey
        }))
      } catch (e) { /* ignore */ }
    }
  }, [jellyfinConfig])
  
  // Track which tab data is currently loaded in main state
  const [loadedTabs, setLoadedTabs] = useState<Set<'artists' | 'albums' | 'playlists'>>(new Set(['artists']))
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  
  // Infinite scroll ref
  const loadMoreRef = useRef<HTMLDivElement>(null)
  
  // Main content scroll ref for restoring scroll position
  const contentScrollRef = useRef<HTMLDivElement>(null)

  const jellyfinHeaders = (apiKey: string) => ({
    'X-MediaBrowser-Token': apiKey,
    'X-Emby-Token': apiKey,
    'Content-Type': 'application/json',
  })

  // A2 — debounced server-side search
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

  const fetchUserList = async (baseUrl: string, apiKey: string): Promise<JellyfinUser[]> => {
    const headers = jellyfinHeaders(apiKey)

    // Try authenticated users list first
    const authRes = await fetch(`${baseUrl}/Users`, { headers }).catch(() => null)
    if (authRes?.ok) {
      const users: JellyfinUser[] = await authRes.json()
      if (users.length > 0) return users
    }

    // Fall back to public endpoint
    const publicRes = await fetch(`${baseUrl}/Users/Public`).catch(() => null)
    if (publicRes?.ok) {
      const users: JellyfinUser[] = await publicRes.json()
      if (users.length > 0) return users
    }

    return []
  }

  const connectWithUser = async (url: string, apiKey: string, userId: string): Promise<void> => {
    setJellyfinConfig({ url, apiKey, userId })
    setUserId(userId)
    setIsConnected(true)
    await Promise.all([loadLibrary(url, apiKey, userId), loadStats(url, apiKey, userId)])
  }

  // Connect to Jellyfin
  const connectToJellyfin = async (url: string, apiKey: string): Promise<boolean> => {
    setIsConnecting(true)
    setError(null)

    try {
      const normalizedUrl = url.replace(/\/$/, '')
      const headers = jellyfinHeaders(apiKey)

      const response = await fetch(`${normalizedUrl}/System/Info/Public`, { method: 'GET', headers })
      if (!response.ok) {
        throw new Error(`Connection error: ${response.status} ${response.statusText}`)
      }

      // Try /Users/Me (works with session tokens, not always with API keys)
      const userRes = await fetch(`${normalizedUrl}/Users/Me`, { headers }).catch(() => null)
      if (userRes?.ok) {
        const userData = await userRes.json()
        await connectWithUser(normalizedUrl, apiKey, userData.Id)
        return true
      }

      // Fall back to user selector
      const userList = await fetchUserList(normalizedUrl, apiKey)
      if (userList.length > 0) {
        setUsers(userList)
        setPendingConfig({ url: normalizedUrl, apiKey })
        setShowUserSelector(true)
        return false
      }

      setError('Could not identify user. Please select manually.')
      return false
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
      return false
    } finally {
      setIsConnecting(false)
    }
  }

  // Handle user selection from the selector modal
  const handleUserSelect = async (selectedUser: JellyfinUser): Promise<void> => {
    if (!pendingConfig) return

    const { url, apiKey } = pendingConfig
    setShowUserSelector(false)
    setPendingConfig(null)
    await connectWithUser(url, apiKey, selectedUser.Id)
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
      'X-MediaBrowser-Token': apiKey, 'X-Emby-Token': apiKey,
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
        setStats({
          ArtistCount: statsData.ArtistCount || 0,
          AlbumCount: statsData.AlbumCount || 0,
          SongCount: statsData.ChildCount || statsData.TotalCount || 0,
          PlaylistCount: statsData.PlaylistCount || 0,
          ItemCount: statsData.ItemCount || 0
        })
      } else {
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
      'X-MediaBrowser-Token': jellyfinConfig.apiKey, 'X-Emby-Token': jellyfinConfig.apiKey,
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
        // Populate artist index (also update ref for immediate access)
        itemTypeIndexRef.current.artists = new Set([...itemTypeIndexRef.current.artists, ...artistsItems.map((a: Artist) => a.Id)])
        setItemTypeIndex(prev => {
          const newSet = new Set(prev.artists)
          artistsItems.forEach((a: Artist) => newSet.add(a.Id))
          return { ...prev, artists: newSet }
        })
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
        setAlbums(albumsItems)
        // Populate album index (also update ref for immediate access)
        itemTypeIndexRef.current.albums = new Set([...itemTypeIndexRef.current.albums, ...albumsItems.map((a: Album) => a.Id)])
        setItemTypeIndex(prev => {
          const newSet = new Set(prev.albums)
          albumsItems.forEach((a: Album) => newSet.add(a.Id))
          return { ...prev, albums: newSet }
        })
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
        
        setPlaylists(playlistsItems)
        // Populate playlist index (also update ref for immediate access)
        itemTypeIndexRef.current.playlists = new Set([...itemTypeIndexRef.current.playlists, ...playlistsItems.map((p: Playlist) => p.Id)])
        setItemTypeIndex(prev => {
          const newSet = new Set(prev.playlists)
          playlistsItems.forEach((p: Playlist) => newSet.add(p.Id))
          return { ...prev, playlists: newSet }
        })
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
    // DEBUG: Log what ID is being toggled
    
    // Validate ID - skip undefined/null/empty IDs
    if (!id || typeof id !== 'string' || id.trim() === '') {
      return
    }
    
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

  // Fetch tracks for sync from Jellyfin using index-based type detection
  const fetchTracksForSync = async (ids: string[]): Promise<Array<{id: string, name: string, path: string, format: string}>> => {
    // Use ref for immediate access to latest index values
    const currentIndex = itemTypeIndexRef.current
    
    if (!jellyfinConfig || !userId) {
      return []
    }
    
    const validIds = ids.filter(id => id && typeof id === 'string' && id.trim() !== '')
    if (validIds.length === 0) return []
    
    const headers = { 'X-MediaBrowser-Token': jellyfinConfig.apiKey, 'X-Emby-Token': jellyfinConfig.apiKey, 'Content-Type': 'application/json' }
    const baseUrl = jellyfinConfig.url.replace(/\/$/, '')
    
    const tracks: Array<{id: string, name: string, path: string, format: string}> = []
    const addedIds = new Set<string>()
    
    const addTrack = (track: any) => {
      if (track.Id && track.MediaSources?.[0]?.Path && !addedIds.has(track.Id)) {
        addedIds.add(track.Id)
        tracks.push({
          id: track.Id,
          name: track.Name,
          path: track.MediaSources[0].Path,
          format: track.MediaSources[0].Container || 'unknown'
        })
      }
    }
    
    for (const id of validIds) {
      // Use index to determine item type - O(1) lookup, no fallbacks needed
      // Check in ref first for immediate access, then fall back to state
      const inArtistIndex = currentIndex.artists.has(id) || itemTypeIndex.artists.has(id)
      const inAlbumIndex = currentIndex.albums.has(id) || itemTypeIndex.albums.has(id)
      const inPlaylistIndex = currentIndex.playlists.has(id) || itemTypeIndex.playlists.has(id)
      
      
      if (inArtistIndex) {
        // ES ARTISTA → obtener álbumes y luego tracks
        try {
          const artistRes = await fetch(`${baseUrl}/users/${userId}/items?AlbumArtistIds=${id}&includeItemTypes=MusicAlbum&Recursive=true&fields=Path`, { headers })
          if (artistRes.ok) {
            const albums = await artistRes.json()
            for (const album of albums.Items || []) {
              const tracksRes = await fetch(`${baseUrl}/users/${userId}/items?parentId=${album.Id}&includeItemTypes=Audio`, { headers })
              if (tracksRes.ok) {
                const tracksData = await tracksRes.json()
                for (const track of tracksData.Items || []) addTrack(track)
              }
            }
          }
        } catch (e) { console.error(e) }
      } else if (inAlbumIndex) {
        // ES ÁLBUM → obtener tracks directamente
        try {
          const albumRes = await fetch(`${baseUrl}/users/${userId}/items?parentId=${id}&includeItemTypes=Audio&recursive=true`, { headers })
          if (albumRes.ok) {
            const data = await albumRes.json()
            for (const track of data.Items || []) addTrack(track)
          }
        } catch (e) { console.error(e) }
      } else if (inPlaylistIndex) {
        // ES PLAYLIST → obtener tracks de playlist
        try {
          const playlistRes = await fetch(`${baseUrl}/playlists/${id}/items`, { headers })
          if (playlistRes.ok) {
            const items = await playlistRes.json()
            for (const item of items.Items || []) addTrack(item)
          }
        } catch (e) { console.error(e) }
      }
      
    }
    
    return tracks
  }

  // B1 — execute sync after preview confirmation
  const executeSyncNow = async (): Promise<void> => {
    if (!syncFolder || !jellyfinConfig || !userId) return
    setShowPreview(false)
    setIsSyncing(true)
    setSyncProgress({ current: 0, total: 0, file: 'Validating...' })

    // Subscribe to progress events BEFORE starting sync
    const unsubscribe = window.api.onSyncProgress((progress) => {
      setSyncProgress({
        current: progress.current,
        total: progress.total,
        file: progress.currentFile,
      })
    })

    try {
      const itemTypesMap: Record<string, 'artist' | 'album' | 'playlist'> = {}
      const artistIds = uniqueArtists.filter(a => selectedTracks.has(a.Id)).map(a => a.Id)
      const albumIds = uniqueAlbums.filter(a => selectedTracks.has(a.Id)).map(a => a.Id)
      const playlistIds = uniquePlaylists.filter(p => selectedTracks.has(p.Id)).map(p => p.Id)
      artistIds.forEach(id => { if (id) itemTypesMap[id] = 'artist' })
      albumIds.forEach(id => { if (id) itemTypesMap[id] = 'album' })
      playlistIds.forEach(id => { if (id) itemTypesMap[id] = 'playlist' })
      const selectedIds = [...artistIds, ...albumIds, ...playlistIds].filter(Boolean)

      const result = await window.api.startSync2({
        serverUrl: jellyfinConfig.url,
        apiKey: jellyfinConfig.apiKey,
        userId: userId,
        itemIds: selectedIds,
        itemTypes: itemTypesMap,
        destinationPath: syncFolder,
        options: { convertToMp3, bitrate },
      })

      unsubscribe?.()
      setSyncProgress(null)
      setIsSyncing(false)

      if (result.success) {
        setSelectedTracks(new Set())
        alert(`Sync complete!\n\nTracks copied: ${result.tracksCopied}\nErrors: ${result.errors.length}\n\n${result.errors.length > 0 ? 'Errors:\n' + result.errors.slice(0, 5).join('\n') : ''}`)
      } else {
        alert(`Sync failed:\n\n${result.errors.join('\n')}`)
      }
    } catch (error) {
      unsubscribe?.()
      console.error('Sync error:', error)
      setSyncProgress(null)
      setIsSyncing(false)
      alert('Sync error: ' + error)
    }
  }

  // B1 — show preview modal before sync
  const handleStartSync = async (): Promise<void> => {
    if (!syncFolder) { alert('Please select a sync destination folder first'); return }
    if (selectedTracks.size === 0) { alert('Please select at least one item to sync'); return }
    if (!jellyfinConfig || !userId) { alert('Not connected to Jellyfin'); return }

    setIsLoadingPreview(true)
    try {
      const artistIds = uniqueArtists.filter(a => selectedTracks.has(a.Id)).map(a => a.Id)
      const albumIds = uniqueAlbums.filter(a => selectedTracks.has(a.Id)).map(a => a.Id)
      const playlistIds = uniquePlaylists.filter(p => selectedTracks.has(p.Id)).map(p => p.Id)
      const itemTypesMap: Record<string, 'artist' | 'album' | 'playlist'> = {}
      artistIds.forEach(id => { if (id) itemTypesMap[id] = 'artist' })
      albumIds.forEach(id => { if (id) itemTypesMap[id] = 'album' })
      playlistIds.forEach(id => { if (id) itemTypesMap[id] = 'playlist' })
      const selectedIds = [...artistIds, ...albumIds, ...playlistIds].filter(Boolean)

      const [estimate, syncedItems] = await Promise.all([
        window.api.estimateSize({ serverUrl: jellyfinConfig.url, apiKey: jellyfinConfig.apiKey, userId, itemIds: selectedIds, itemTypes: itemTypesMap }),
        window.api.getSyncedItems(syncFolder),
      ])
      const alreadySyncedCount = syncedItems.filter((id: string) => selectedIds.includes(id)).length
      setPreviewData({ ...estimate, alreadySyncedCount })
      setShowPreview(true)
    } catch (e) {
      console.error('Preview error:', e)
      // Fall through to sync directly if preview fails
      executeSyncNow()
    } finally {
      setIsLoadingPreview(false)
    }
  }

  // Load initial library data (precarga todas las secciones para el sidebar)
  const loadLibrary = async (url: string, apiKey: string, userId: string): Promise<void> => {
    const headers = { 
      'X-MediaBrowser-Token': apiKey, 'X-Emby-Token': apiKey,
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
    // Reset index ref as well
    itemTypeIndexRef.current = {
      artists: new Set(),
      albums: new Set(),
      playlists: new Set()
    }
    setLoadedTabs(new Set(['artists', 'albums', 'playlists'])) // Precargar todas las secciones
    
    // Load first page of ALL sections (precarga para sidebar)
    try {
      // Artists
      const artistsRes = await fetch(buildUrl(baseUrl, `/Artists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=0`), { headers })
      if (!artistsRes.ok) throw new Error(`HTTP ${artistsRes.status}`)
      const artistsData = await artistsRes.json()
      const artistsItems = artistsData.Items || []
      setArtists(artistsItems)
      // Populate artist index (also update ref for immediate access)
      itemTypeIndexRef.current.artists = new Set([...artistsItems.map((a: Artist) => a.Id)])
      setItemTypeIndex(prev => {
        const newSet = new Set(prev.artists)
        artistsItems.forEach((a: Artist) => newSet.add(a.Id))
        return { ...prev, artists: newSet }
      })
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
      setAlbums(albumsItems)
      // Populate album index (also update ref for immediate access)
      itemTypeIndexRef.current.albums = new Set([...albumsItems.map((a: Album) => a.Id)])
      setItemTypeIndex(prev => {
        const newSet = new Set(prev.albums)
        albumsItems.forEach((a: Album) => newSet.add(a.Id))
        return { ...prev, albums: newSet }
      })
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
      setPlaylists(playlistsItems)
      // Populate playlist index (also update ref for immediate access)
      itemTypeIndexRef.current.playlists = new Set([...playlistsItems.map((p: Playlist) => p.Id)])
      setItemTypeIndex(prev => {
        const newSet = new Set(prev.playlists)
        playlistsItems.forEach((p: Playlist) => newSet.add(p.Id))
        return { ...prev, playlists: newSet }
      })
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
      'X-MediaBrowser-Token': jellyfinConfig.apiKey, 'X-Emby-Token': jellyfinConfig.apiKey,
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
      
      
      // Deduplicate new items against existing ones to avoid duplicates
      const existingIds = new Set(currentPagination.items.map(item => item.Id))
      const uniqueNewItems = newItems.filter(item => !existingIds.has(item.Id))
      
      if (uniqueNewItems.length < newItems.length) {
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
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
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
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
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

          {/* Error Display */}
          {error && (
            <div className="mx-4 mt-4 p-3 bg-red-900/50 border border-red-700 rounded-lg flex items-center gap-2 text-red-300">
              <X className="w-4 h-4 flex-shrink-0" />
              <span className="text-sm">{error}</span>
              <button onClick={() => setError(null)} className="ml-auto text-xs hover:text-red-200">Dismiss</button>
            </div>
          )}

          {/* A2 — Search results */}
          {activeSection === 'library' && searchQuery.length >= 2 && (
            <div data-testid="search-results" className="grid gap-4 mb-2">
              {isSearching && (
                <div className="flex items-center gap-2 text-zinc-500 text-sm px-1 py-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Searching...
                </div>
              )}
              {!isSearching && searchResults && (
                <>
                  {searchResults.artists.map(artist => (
                    <div key={artist.Id} className="flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors border-l-2 border-blue-600">
                      <input type="checkbox" checked={selectedTracks.has(artist.Id)} onChange={() => toggleTrackSelection(artist.Id)} className="w-5 h-5 rounded border-zinc-600 bg-zinc-800 text-blue-600 focus:ring-blue-500" />
                      <User className="w-5 h-5 text-zinc-500 flex-shrink-0" />
                      <div className="flex-1"><h3 className="font-medium">{artist.Name}</h3><p className="text-xs text-zinc-500">Artist</p></div>
                    </div>
                  ))}
                  {searchResults.albums.map(album => (
                    <div key={album.Id} className="flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors border-l-2 border-blue-600">
                      <input type="checkbox" checked={selectedTracks.has(album.Id)} onChange={() => toggleTrackSelection(album.Id)} className="w-5 h-5 rounded border-zinc-600 bg-zinc-800 text-blue-600 focus:ring-blue-500" />
                      <Disc className="w-5 h-5 text-zinc-500 flex-shrink-0" />
                      <div className="flex-1"><h3 className="font-medium">{album.Name}</h3><p className="text-xs text-zinc-500">Album · {(album as Album & { ArtistName?: string }).ArtistName}</p></div>
                    </div>
                  ))}
                  {searchResults.playlists.map(pl => (
                    <div key={pl.Id} className="flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors border-l-2 border-blue-600">
                      <input type="checkbox" checked={selectedTracks.has(pl.Id)} onChange={() => toggleTrackSelection(pl.Id)} className="w-5 h-5 rounded border-zinc-600 bg-zinc-800 text-blue-600 focus:ring-blue-500" />
                      <ListMusic className="w-5 h-5 text-zinc-500 flex-shrink-0" />
                      <div className="flex-1"><h3 className="font-medium">{pl.Name}</h3><p className="text-xs text-zinc-500">Playlist · {pl.TrackCount} songs</p></div>
                    </div>
                  ))}
                  {searchResults.artists.length === 0 && searchResults.albums.length === 0 && searchResults.playlists.length === 0 && (
                    <p className="text-zinc-500 text-sm px-1 py-2">No results for "{searchQuery}"</p>
                  )}
                </>
              )}
            </div>
          )}

          {/* Content Grid */}
          {activeSection === 'library' && searchQuery.length < 2 && (
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
                {!isLoadingMore && activeLibrary === 'artists' && pagination.artists.hasMore && pagination.artists.items.length > 0 && (
                  <div className="text-center text-zinc-600 text-xs py-2">Scroll for more</div>
                )}
                {!isLoadingMore && activeLibrary === 'albums' && pagination.albums.hasMore && pagination.albums.items.length > 0 && (
                  <div className="text-center text-zinc-600 text-xs py-2">Scroll for more</div>
                )}
                {!isLoadingMore && activeLibrary === 'playlists' && pagination.playlists.hasMore && pagination.playlists.items.length > 0 && (
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

                {/* A1 — FLAC→MP3 conversion toggle */}
                <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 mb-6">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-sm">Convert to MP3</span>
                    <button
                      onClick={() => setConvertToMp3(v => !v)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${convertToMp3 ? 'bg-blue-600' : 'bg-zinc-600'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${convertToMp3 ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                  {convertToMp3 && (
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-xs text-zinc-400">Bitrate:</span>
                      {(['128k', '192k', '320k'] as const).map(b => (
                        <button
                          key={b}
                          onClick={() => setBitrate(b)}
                          className={`px-2 py-1 text-xs rounded ${bitrate === b ? 'bg-blue-600 text-white' : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'}`}
                        >
                          {b}
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-zinc-500 mt-2">
                    {convertToMp3 ? `FLAC/M4A/AAC/OGG → MP3 ${bitrate}` : 'Files copied as-is'}
                  </p>
                </div>

                {syncFolder && (
                  <button
                    onClick={handleStartSync}
                    disabled={isSyncing || isLoadingPreview}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-700 py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    {isLoadingPreview ? <><Loader2 className="w-4 h-4 animate-spin" /> Calculating...</> :
                     isSyncing ? 'Syncing...' : 'Start Sync'}
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

      {/* B1 — Preview modal */}
      {showPreview && previewData && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowPreview(false)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Check className="w-5 h-5 text-blue-500" />
              Sync Preview
            </h2>
            <div className="space-y-3 mb-6">
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Tracks to sync</span>
                <span className="font-medium">{previewData.trackCount.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Total size</span>
                <span className="font-medium">{(previewData.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB</span>
              </div>
              {previewData.alreadySyncedCount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-400">Previously synced</span>
                  <span className="text-green-400">{previewData.alreadySyncedCount} (will skip if unchanged)</span>
                </div>
              )}
              {Object.keys(previewData.formatBreakdown).length > 0 && (
                <div className="text-sm">
                  <span className="text-zinc-400 block mb-1">Formats</span>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(previewData.formatBreakdown).map(([fmt, bytes]) => (
                      <span key={fmt} className="bg-zinc-800 px-2 py-0.5 rounded text-xs">
                        {fmt.toUpperCase()} · {(bytes / 1024 / 1024).toFixed(0)} MB
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {convertToMp3 && (
                <div className="text-xs text-zinc-500 bg-zinc-800 rounded p-2">
                  FLAC/lossless will be converted to MP3 {bitrate}
                </div>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowPreview(false)}
                className="flex-1 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeSyncNow}
                className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-sm font-medium transition-colors"
              >
                Confirm Sync
              </button>
            </div>
          </div>
        </div>
      )}

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
