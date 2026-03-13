import { useState, useEffect } from 'react'
import { Music, Search, HardDrive, Settings, User, Disc, Folder, ListMusic, RefreshCw, Play, Check, X, Loader2 } from 'lucide-react'

// Types
interface UsbDevice {
  deviceAddress: number
  vendorId: number
  productId: number
}

interface JellyfinConfig {
  url: string
  apiKey: string
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
  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [devices, setDevices] = useState<UsbDevice[]>([])
  const [activeSection, setActiveSection] = useState<'library' | 'devices'>('library')
  const [activeLibrary, setActiveLibrary] = useState<'artists' | 'albums' | 'playlists'>('artists')
  const [artists, setArtists] = useState<Artist[]>([])
  const [albums, setAlbums] = useState<Album[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [selectedTracks, setSelectedTracks] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')

  // Connect to Jellyfin
  const connectToJellyfin = async (url: string, apiKey: string): Promise<boolean> => {
    setIsConnecting(true)
    setError(null)
    
    try {
      // Normalize URL - remove trailing slash
      const normalizedUrl = url.replace(/\/$/, '')
      const response = await fetch(`${normalizedUrl}/System/Info/Public`, {
        headers: { 'X-MediaBrowser-Token': apiKey }
      })
      
      if (!response.ok) throw new Error('Invalid credentials')
      
      const data = await response.json()
      console.log('Connected to Jellyfin:', data.ServerName)
      
      setJellyfinConfig({ url, apiKey })
      setIsConnected(true)
      
      // Load library data
      await loadLibrary(url, apiKey)
      
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
      return false
    } finally {
      setIsConnecting(false)
    }
  }

  // Load library data
  const loadLibrary = async (url: string, apiKey: string): Promise<void> => {
    const headers = { 'X-MediaBrowser-Token': apiKey }
    const baseUrl = url.replace(/\/$/, '')
    
    // Load artists (more)
    const artistsRes = await fetch(`${baseUrl}/Artists?SortBy=Name&Limit=200`, { headers })
    const artistsData = await artistsRes.json()
    setArtists(artistsData.Items || [])
    
    // Load albums (using Items endpoint with IncludeItemTypes)
    const albumsRes = await fetch(`${baseUrl}/Items?IncludeItemTypes=Album&Limit=200`, { headers })
    const albumsData = await albumsRes.json()
    setAlbums(albumsData.Items || [])
    
    // Load playlists (using user playlists endpoint)
    const playlistsRes = await fetch(`${baseUrl}/Users/23ea021636224deeb6d8b761c7703b79/Items?ParentId=1071671e7bffa0532e930debee501d2e&Limit=100`, { headers })
    const playlistsData = await playlistsRes.json()
    setPlaylists(playlistsData.Items || [])
  }

  // USB detection
  useEffect(() => {
    window.api?.listUsbDevices().then(setDevices)
    window.api?.onUsbAttach(() => window.api?.listUsbDevices().then(setDevices))
    window.api?.onUsbDetach(() => window.api?.listUsbDevices().then(setDevices))
  }, [])

  // Login screen if not connected
  if (!isConnected && !isConnecting) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
        <div className="w-full max-w-md p-8">
          <div className="flex items-center gap-3 mb-8 justify-center">
            <Music className="w-10 h-10 text-blue-500" />
            <h1 className="text-2xl font-bold">Jellysync</h1>
          </div>
          
          <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
            <h2 className="text-lg font-semibold mb-4">Conectar a Jellyfin</h2>
            
            <form onSubmit={(e) => {
              e.preventDefault()
              const url = (e.currentTarget.elements.namedItem('url') as HTMLInputElement).value
              const apiKey = (e.currentTarget.elements.namedItem('apiKey') as HTMLInputElement).value
              connectToJellyfin(url, apiKey)
            }}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">URL del servidor</label>
                  <input
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
                    name="apiKey"
                    type="password"
                    placeholder="Tu API key de Jellyfin"
                    required
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
                
                {error && (
                  <div className="flex items-center gap-2 text-red-400 text-sm">
                    <X className="w-4 h-4" />
                    {error}
                  </div>
                )}
                
                <button
                  type="submit"
                  className="w-full bg-blue-600 hover:bg-blue-700 py-2 rounded-lg font-medium transition-colors"
                >
                  Conectar
                </button>
              </div>
            </form>
          </div>
          
          <p className="text-xs text-zinc-500 text-center mt-4">
            Consigue tu API Key en Jellyfin → Dashboard → Usuario → Keys API
          </p>
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
          <p>Conectando a Jellyfin...</p>
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
          {isConnected && <span className="text-xs text-green-500 flex items-center gap-1"><Check className="w-3 h-3" /> Conectado</span>}
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
            type="text"
            placeholder="Buscar en la biblioteca..."
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
            <h3 className="text-xs font-medium text-zinc-500 uppercase mb-2">Biblioteca</h3>
            <nav className="space-y-1">
              <button
                onClick={() => { setActiveSection('library'); setActiveLibrary('artists') }}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                  activeSection === 'library' && activeLibrary === 'artists'
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-zinc-800'
                }`}
              >
                <User className="w-4 h-4" />
                Artistas
                <span className="ml-auto text-xs opacity-60">{artists.length}</span>
              </button>
              <button
                onClick={() => { setActiveSection('library'); setActiveLibrary('albums') }}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                  activeSection === 'library' && activeLibrary === 'albums'
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-zinc-800'
                }`}
              >
                <Disc className="w-4 h-4" />
                Álbumes
                <span className="ml-auto text-xs opacity-60">{albums.length}</span>
              </button>
              <button
                onClick={() => { setActiveSection('library'); setActiveLibrary('playlists') }}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                  activeSection === 'library' && activeLibrary === 'playlists'
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-zinc-800'
                }`}
              >
                <ListMusic className="w-4 h-4" />
                Playlists
                <span className="ml-auto text-xs opacity-60">{playlists.length}</span>
              </button>
            </nav>
          </div>

          {/* Devices Section */}
          <div>
            <h3 className="text-xs font-medium text-zinc-500 uppercase mb-2">Dispositivos</h3>
            <nav className="space-y-1">
              {devices.length === 0 ? (
                <p className="text-xs text-zinc-500 px-3">No hay dispositivos USB</p>
              ) : (
                devices.map((device) => (
                  <button
                    key={device.deviceAddress}
                    onClick={() => setActiveSection('devices')}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                      activeSection === 'devices'
                        ? 'bg-blue-600 text-white'
                        : 'hover:bg-zinc-800'
                    }`}
                  >
                    <HardDrive className="w-4 h-4" />
                    USB {device.deviceAddress}
                  </button>
                ))
              )}
            </nav>
          </div>
        </aside>

        {/* Content Area */}
        <main className="flex-1 p-6 overflow-auto">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold">
              {activeLibrary === 'artists' && 'Artistas'}
              {activeLibrary === 'albums' && 'Álbumes'}
              {activeLibrary === 'playlists' && 'Playlists'}
              {activeSection === 'devices' && 'Dispositivos USB'}
            </h2>
            {selectedTracks.size > 0 && (
              <button className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm">
                <RefreshCw className="w-4 h-4" />
                Sincronizar ({selectedTracks.size})
              </button>
            )}
          </div>

          {/* Content Grid */}
          {activeSection === 'library' && (
            <div className="grid gap-4">
              {activeLibrary === 'artists' && artists
                .filter(a => !searchQuery || a.Name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map(artist => (
                  <div key={artist.Id} className="flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors">
                    <div className="w-12 h-12 bg-zinc-800 rounded-lg flex items-center justify-center">
                      <User className="w-6 h-6 text-zinc-500" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-medium">{artist.Name}</h3>
                      <p className="text-sm text-zinc-500">{artist.AlbumCount} álbumes</p>
                    </div>
                    <button className="p-2 hover:bg-zinc-700 rounded-lg">
                      <Play className="w-5 h-5" />
                    </button>
                  </div>
                ))
              }
              
              {activeLibrary === 'albums' && albums
                .filter(a => !searchQuery || a.Name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map(album => (
                  <div key={album.Id} className="flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors">
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
              
              {activeLibrary === 'playlists' && playlists
                .filter(p => !searchQuery || p.Name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map(playlist => (
                  <div key={playlist.Id} className="flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors">
                    <div className="w-12 h-12 bg-zinc-800 rounded-lg flex items-center justify-center">
                      <ListMusic className="w-6 h-6 text-zinc-500" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-medium">{playlist.Name}</h3>
                      <p className="text-sm text-zinc-500">{playlist.TrackCount} canciones</p>
                    </div>
                    <button className="p-2 hover:bg-zinc-700 rounded-lg">
                      <Play className="w-5 h-5" />
                    </button>
                  </div>
                ))
              }
            </div>
          )}

          {activeSection === 'devices' && (
            <div className="text-center text-zinc-500 py-20">
              <HardDrive className="w-16 h-16 mx-auto mb-4 opacity-50" />
              <p>Conecta un dispositivo USB para sincronizar</p>
            </div>
          )}
        </main>
      </div>

      {/* Footer Stats */}
      <footer className="h-10 border-t border-zinc-800 flex items-center px-4 text-xs text-zinc-500">
        <span>{artists.length} artistas • {albums.length} álbumes • {playlists.length} playlists</span>
      </footer>
    </div>
  )
}

export default App
