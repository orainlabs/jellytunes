import { useRef } from 'react'
import { Loader2, X } from 'lucide-react'
import { LibraryItem } from './LibraryItem'
import type { LibraryTab, Artist, Album, Playlist, PaginationState } from '../appTypes'

interface LibraryContentProps {
  activeLibrary: LibraryTab
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
  pagination: PaginationState
  selectedTracks: Set<string>
  previouslySyncedItems: Set<string>
  isLoadingMore: boolean
  searchQuery: string
  error: string | null
  onToggle: (id: string) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onClearError: () => void
  onLoadMore: (type: LibraryTab) => void
  selectionSummary: string
  contentScrollRef: React.RefObject<HTMLDivElement>
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
  searchQuery,
  error,
  onToggle,
  onSelectAll,
  onClearSelection,
  onClearError,
  selectionSummary,
  contentScrollRef,
}: LibraryContentProps): JSX.Element {
  const loadMoreRef = useRef<HTMLDivElement>(null)

  const filteredArtists = artists.filter(a => !searchQuery || a.Name.toLowerCase().includes(searchQuery.toLowerCase()))
  const filteredAlbums = albums.filter(a => !searchQuery || a.Name.toLowerCase().includes(searchQuery.toLowerCase()))
  const filteredPlaylists = playlists.filter(p => !searchQuery || p.Name.toLowerCase().includes(searchQuery.toLowerCase()))

  return (
    <main ref={contentScrollRef} className="flex-1 p-6 overflow-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">
          {activeLibrary === 'artists' && 'Artists'}
          {activeLibrary === 'albums' && 'Albums'}
          {activeLibrary === 'playlists' && 'Playlists'}
        </h2>
      </div>

      {/* Selection Controls */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
        <span className="text-sm text-zinc-400">
          {selectedTracks.size > 0 ? selectionSummary : 'None selected'}
        </span>
        <div className="flex gap-2">
          <button onClick={onSelectAll} className="text-sm text-blue-500 hover:text-blue-400">
            Select All
          </button>
          {selectedTracks.size > 0 && (
            <button onClick={onClearSelection} className="text-sm text-zinc-400 hover:text-zinc-300">
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="mx-4 mt-4 p-3 bg-red-900/50 border border-red-700 rounded-lg flex items-center gap-2 text-red-300">
          <X className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm">{error}</span>
          <button onClick={onClearError} className="ml-auto text-xs hover:text-red-200">Dismiss</button>
        </div>
      )}

      {/* Content Grid */}
      <div data-testid="library-content" className="grid gap-4">
        {activeLibrary === 'artists' && filteredArtists.map((artist, idx) => (
          <LibraryItem
            key={artist.Id || `artist-${idx}`}
            item={artist}
            type="artist"
            isSelected={selectedTracks.has(artist.Id)}
            wasSynced={previouslySyncedItems.has(artist.Id)}
            onToggle={onToggle}
          />
        ))}

        {activeLibrary === 'albums' && filteredAlbums.map((album, idx) => (
          <LibraryItem
            key={album.Id || `album-${idx}`}
            item={album}
            type="album"
            isSelected={selectedTracks.has(album.Id)}
            wasSynced={previouslySyncedItems.has(album.Id)}
            onToggle={onToggle}
          />
        ))}

        {activeLibrary === 'playlists' && filteredPlaylists.map((playlist, idx) => (
          <LibraryItem
            key={playlist.Id || `playlist-${idx}`}
            item={playlist}
            type="playlist"
            isSelected={selectedTracks.has(playlist.Id)}
            wasSynced={previouslySyncedItems.has(playlist.Id)}
            onToggle={onToggle}
          />
        ))}

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
    </main>
  )
}
