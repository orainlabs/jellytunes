import { User, Disc, ListMusic, HardDrive, Folder, Plus, RotateCcw } from 'lucide-react'
import type { ActiveSection, LibraryTab, LibraryStats, PaginationState, Artist, Album, Playlist, UsbDevice, SavedDestination } from '../appTypes'

interface SidebarProps {
  activeSection: ActiveSection
  activeLibrary: LibraryTab
  activeDestinationPath: string | null
  stats: LibraryStats | null
  pagination: PaginationState
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
  usbDevices: UsbDevice[]
  savedDestinations: SavedDestination[]
  onLibraryTab: (tab: LibraryTab) => void
  onDestinationClick: (path: string) => void
  onAddFolder: () => void
  onRefreshDevices: () => void
}

export function Sidebar({
  activeSection,
  activeLibrary,
  activeDestinationPath,
  stats,
  pagination,
  artists,
  albums,
  playlists,
  usbDevices,
  savedDestinations,
  onLibraryTab,
  onDestinationClick,
  onAddFolder,
  onRefreshDevices,
}: SidebarProps): JSX.Element {
  const tabClass = (active: boolean) =>
    `w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${active ? 'bg-blue-600 text-white' : 'hover:bg-zinc-800 text-zinc-300'}`

  const destClass = (path: string) =>
    `w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${activeDestinationPath === path && activeSection === 'device' ? 'bg-blue-600 text-white' : 'hover:bg-zinc-800 text-zinc-300'}`

  // USB devices that have at least one mountpoint
  const mountedUsb = usbDevices.flatMap(d =>
    d.mountpoints.map(mp => ({ name: d.productName || d.displayName || 'USB Device', path: mp.path }))
  )

  const hasAnyDestination = mountedUsb.length > 0 || savedDestinations.length > 0

  return (
    <aside className="w-64 border-r border-zinc-800 p-4 flex flex-col">
      {/* Library */}
      <div className="mb-6">
        <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Library</h3>
        <nav className="space-y-1">
          <button
            data-testid="tab-artists"
            onClick={() => onLibraryTab('artists')}
            className={tabClass(activeSection === 'library' && activeLibrary === 'artists')}
          >
            <User className="w-4 h-4 flex-shrink-0" />
            Artists
            <span className="ml-auto text-xs opacity-60">
              {stats ? stats.ArtistCount.toLocaleString() : pagination.artists.total > 0 ? pagination.artists.total : artists.length}
            </span>
          </button>
          <button
            data-testid="tab-albums"
            onClick={() => onLibraryTab('albums')}
            className={tabClass(activeSection === 'library' && activeLibrary === 'albums')}
          >
            <Disc className="w-4 h-4 flex-shrink-0" />
            Albums
            <span className="ml-auto text-xs opacity-60">
              {stats ? stats.AlbumCount.toLocaleString() : pagination.albums.total > 0 ? pagination.albums.total : albums.length}
            </span>
          </button>
          <button
            data-testid="tab-playlists"
            onClick={() => onLibraryTab('playlists')}
            className={tabClass(activeSection === 'library' && activeLibrary === 'playlists')}
          >
            <ListMusic className="w-4 h-4 flex-shrink-0" />
            Playlists
            <span className="ml-auto text-xs opacity-60">
              {stats ? stats.PlaylistCount.toLocaleString() : pagination.playlists.total > 0 ? pagination.playlists.total : playlists.length}
            </span>
          </button>
        </nav>
      </div>

      {/* Devices */}
      <div className="flex-1">
        <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2 flex items-center justify-between">
          Devices
          <button
            onClick={onRefreshDevices}
            className="p-0.5 text-zinc-600 hover:text-zinc-400 transition-colors"
            title="Refresh devices"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </h3>
        <nav className="space-y-1">
          {/* USB devices */}
          {mountedUsb.map(({ name, path }) => (
            <button
              key={path}
              onClick={() => onDestinationClick(path)}
              className={destClass(path)}
            >
              <HardDrive className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{name}</span>
            </button>
          ))}

          {/* Saved folders */}
          {savedDestinations.map(dest => (
            <button
              key={dest.id}
              onClick={() => onDestinationClick(dest.path)}
              className={destClass(dest.path)}
            >
              <Folder className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{dest.name}</span>
            </button>
          ))}

          {/* Separator + Add folder */}
          {hasAnyDestination && <div className="border-t border-zinc-800 my-1" />}
          <button
            onClick={onAddFolder}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <Plus className="w-4 h-4 flex-shrink-0" />
            Add folder...
          </button>
        </nav>
      </div>
    </aside>
  )
}
