import { useRef, useState, useEffect } from 'react'
import { Loader2, X, HardDrive, Folder, Search } from 'lucide-react'
import { LibraryItem } from './LibraryItem'
import type { LibraryTab, Artist, Album, Playlist, PaginationState } from '../appTypes'

type SyncFilter = 'all' | 'synced' | 'unsynced'

interface SearchResults {
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
}

interface LibraryContentProps {
  activeLibrary: LibraryTab
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
  pagination: PaginationState
  selectedTracks: Set<string>
  previouslySyncedItems: Set<string>
  isLoadingMore: boolean
  error: string | null
  onToggle: (id: string) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onClearError: () => void
  onLoadMore: (type: LibraryTab) => void
  selectionSummary: string
  contentScrollRef: React.RefObject<HTMLDivElement>
  activeDeviceName?: string | null
  isUsbDevice?: boolean
  onGoToDevice?: () => void
  serverUrl?: string
  // Search (managed by parent, API-driven)
  searchQuery: string
  onSearchChange: (q: string) => void
  searchResults: SearchResults | null
  isSearching: boolean
}

export function LibraryContent({
  activeLibrary,
  artists,
  albums,
  playlists,
  pagination,
  selectedTracks,
  previouslySyncedItems,
  isLoadingMore,
  error,
  onToggle,
  onSelectAll,
  onClearSelection,
  onClearError,
  onLoadMore,
  selectionSummary,
  contentScrollRef,
  activeDeviceName,
  isUsbDevice,
  onGoToDevice,
  serverUrl,
  searchQuery,
  onSearchChange,
  searchResults,
  isSearching,
}: LibraryContentProps): JSX.Element {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [syncFilter, setSyncFilter] = useState<SyncFilter>('all')

  const isSearchActive = searchQuery.length >= 2

  // Intersection observer for infinite scroll — wired to local sentinel
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || isSearchActive) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting && !isLoadingMore) onLoadMore(activeLibrary) },
      { threshold: 0.1 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [activeLibrary, isLoadingMore, isSearchActive, onLoadMore])

  const applySyncFilter = <T extends { Id: string }>(items: T[]) => {
    if (syncFilter === 'synced') return items.filter(i => previouslySyncedItems.has(i.Id))
    if (syncFilter === 'unsynced') return items.filter(i => !previouslySyncedItems.has(i.Id))
    return items
  }

  const displayArtists = isSearchActive ? applySyncFilter(searchResults?.artists ?? []) : applySyncFilter(artists)
  const displayAlbums = isSearchActive ? applySyncFilter(searchResults?.albums ?? []) : applySyncFilter(albums)
  const displayPlaylists = isSearchActive ? applySyncFilter(searchResults?.playlists ?? []) : applySyncFilter(playlists)

  const tabLabel = activeLibrary === 'artists' ? 'artists' : activeLibrary === 'albums' ? 'albums' : 'playlists'
  const currentItems = activeLibrary === 'artists' ? displayArtists : activeLibrary === 'albums' ? displayAlbums : displayPlaylists
  const hasResults = currentItems.length > 0
  const currentPagination = pagination[activeLibrary]

  return (
    <main className="flex-1 flex flex-col overflow-hidden">

      {/* ── Sticky header ─────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-zinc-800">

        {/* Device context banner */}
        {activeDeviceName && (
          <button
            onClick={onGoToDevice}
            className="flex items-center gap-2 w-full px-4 py-2 bg-jf-purple/10 border-b border-jf-purple/20 text-sm text-jf-purple-light hover:bg-jf-purple/15 transition-colors text-left"
          >
            {isUsbDevice
              ? <HardDrive className="w-3.5 h-3.5 flex-shrink-0" />
              : <Folder className="w-3.5 h-3.5 flex-shrink-0" />
            }
            <span>Selecting for <strong>{activeDeviceName}</strong></span>
            <span className="ml-auto text-jf-purple/60 text-xs">View device →</span>
          </button>
        )}

        <div className="px-4 pt-3 pb-2 space-y-2">
          {/* Title + sync filter */}
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold capitalize">{activeLibrary}</h2>
            {previouslySyncedItems.size > 0 && (
              <div className="flex gap-1 text-xs bg-zinc-800 rounded-lg p-1">
                {(['all', 'synced', 'unsynced'] as SyncFilter[]).map(f => (
                  <button
                    key={f}
                    onClick={() => setSyncFilter(f)}
                    className={`px-3 py-1 rounded-md transition-colors ${syncFilter === f ? 'bg-zinc-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
                  >
                    {f === 'all' ? 'All' : f === 'synced' ? 'Synced' : 'Not synced'}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
            <input
              type="text"
              placeholder={`Search ${tabLabel}...`}
              value={searchQuery}
              onChange={e => onSearchChange(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-10 pr-9 py-1.5 text-sm focus:outline-none focus:border-jf-purple"
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Selection controls */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">
              {selectedTracks.size > 0 ? selectionSummary : 'None selected'}
            </span>
            <div className="flex gap-3">
              {!isSearchActive && (
                <button onClick={onSelectAll} className="text-xs text-jf-purple hover:text-jf-purple-light">
                  Select all
                </button>
              )}
              {selectedTracks.size > 0 && (
                <button onClick={onClearSelection} className="text-xs text-zinc-500 hover:text-zinc-300">
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Scrollable list ────────────────────────────────── */}
      <div ref={contentScrollRef} className="flex-1 overflow-auto px-4 py-2">

        {/* Error */}
        {error && (
          <div className="mb-3 p-3 bg-red-900/50 border border-red-700 rounded-lg flex items-center gap-2 text-red-300">
            <X className="w-4 h-4 flex-shrink-0" />
            <span className="text-sm">{error}</span>
            <button onClick={onClearError} className="ml-auto text-xs hover:text-red-200">Dismiss</button>
          </div>
        )}

        {isSearchActive && isSearching ? (
          <div className="flex items-center gap-2 text-zinc-500 text-sm py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Searching {tabLabel}...
          </div>
        ) : isSearchActive && !hasResults ? (
          <p className="text-zinc-500 text-sm py-8 text-center">
            No {tabLabel} found for "{searchQuery}"
          </p>
        ) : (
          <div data-testid="library-content" className="grid gap-0.5">
            {activeLibrary === 'artists' && displayArtists.map((artist, idx) => (
              <LibraryItem
                key={artist.Id || `artist-${idx}`}
                item={artist}
                type="artist"
                isSelected={selectedTracks.has(artist.Id)}
                wasSynced={previouslySyncedItems.has(artist.Id)}
                onToggle={onToggle}
                serverUrl={serverUrl}
              />
            ))}

            {activeLibrary === 'albums' && displayAlbums.map((album, idx) => (
              <LibraryItem
                key={album.Id || `album-${idx}`}
                item={album}
                type="album"
                isSelected={selectedTracks.has(album.Id)}
                wasSynced={previouslySyncedItems.has(album.Id)}
                onToggle={onToggle}
                serverUrl={serverUrl}
              />
            ))}

            {activeLibrary === 'playlists' && displayPlaylists.map((playlist, idx) => (
              <LibraryItem
                key={playlist.Id || `playlist-${idx}`}
                item={playlist}
                type="playlist"
                isSelected={selectedTracks.has(playlist.Id)}
                wasSynced={previouslySyncedItems.has(playlist.Id)}
                onToggle={onToggle}
                serverUrl={serverUrl}
              />
            ))}

            {/* Infinite scroll sentinel */}
            {!isSearchActive && (
              <div ref={sentinelRef} className="h-8 flex items-center justify-center">
                {isLoadingMore && (
                  <div className="flex items-center gap-2 text-zinc-500 text-xs">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading more...
                  </div>
                )}
                {!isLoadingMore && currentPagination.hasMore && (
                  <div className="text-zinc-700 text-xs">· · ·</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
