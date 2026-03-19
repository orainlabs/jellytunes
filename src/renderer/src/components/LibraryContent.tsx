import { useRef, useState } from 'react'
import { Loader2, X, HardDrive, Folder } from 'lucide-react'
import { LibraryItem } from './LibraryItem'
import type { LibraryTab, Artist, Album, Playlist, PaginationState } from '../appTypes'

type SyncFilter = 'all' | 'synced' | 'unsynced'

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
  activeDeviceName?: string | null
  isUsbDevice?: boolean
  onGoToDevice?: () => void
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
  activeDeviceName,
  isUsbDevice,
  onGoToDevice,
}: LibraryContentProps): JSX.Element {
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const [syncFilter, setSyncFilter] = useState<SyncFilter>('all')

  const applySyncFilter = <T extends { Id: string }>(items: T[]) => {
    if (syncFilter === 'synced') return items.filter(i => previouslySyncedItems.has(i.Id))
    if (syncFilter === 'unsynced') return items.filter(i => !previouslySyncedItems.has(i.Id))
    return items
  }

  const filteredArtists = applySyncFilter(artists.filter(a => !searchQuery || a.Name.toLowerCase().includes(searchQuery.toLowerCase())))
  const filteredAlbums = applySyncFilter(albums.filter(a => !searchQuery || a.Name.toLowerCase().includes(searchQuery.toLowerCase())))
  const filteredPlaylists = applySyncFilter(playlists.filter(p => !searchQuery || p.Name.toLowerCase().includes(searchQuery.toLowerCase())))

  return (
    <main ref={contentScrollRef} className="flex-1 p-6 overflow-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">
          {activeLibrary === 'artists' && 'Artists'}
          {activeLibrary === 'albums' && 'Albums'}
          {activeLibrary === 'playlists' && 'Playlists'}
        </h2>
        {previouslySyncedItems.size > 0 && (
          <div className="flex gap-1 text-xs bg-zinc-800 rounded-lg p-1">
            {(['all', 'synced', 'unsynced'] as SyncFilter[]).map(f => (
              <button
                key={f}
                onClick={() => setSyncFilter(f)}
                className={`px-3 py-1 rounded-md capitalize transition-colors ${syncFilter === f ? 'bg-zinc-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                {f === 'all' ? 'All' : f === 'synced' ? 'Synced' : 'Not synced'}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Device context banner */}
      {activeDeviceName ? (
        <button
          onClick={onGoToDevice}
          className="flex items-center gap-2 w-full px-4 py-2 bg-blue-600/10 border-b border-blue-600/20 text-sm text-blue-400 hover:bg-blue-600/15 transition-colors text-left"
        >
          {isUsbDevice
            ? <HardDrive className="w-3.5 h-3.5 flex-shrink-0" />
            : <Folder className="w-3.5 h-3.5 flex-shrink-0" />
          }
          <span>Selecting for <strong>{activeDeviceName}</strong></span>
          <span className="ml-auto text-blue-500/60 text-xs">View device →</span>
        </button>
      ) : (
        <div className="px-4 py-2 border-b border-zinc-800 text-xs text-zinc-600">
          Select a device in the sidebar to start syncing
        </div>
      )}

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
