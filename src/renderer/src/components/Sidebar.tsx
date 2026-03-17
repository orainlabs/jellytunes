import { User, Disc, ListMusic, HardDrive } from 'lucide-react'
import type { ActiveSection, LibraryTab, LibraryStats, PaginationState, Artist, Album, Playlist, UsbDevice } from '../appTypes'

interface SidebarProps {
  activeSection: ActiveSection
  activeLibrary: LibraryTab
  stats: LibraryStats | null
  pagination: PaginationState
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
  devices: UsbDevice[]
  selectedCount: number
  onLibraryTab: (tab: LibraryTab) => void
  onSyncClick: () => void
  onDevicesClick: () => void
}

export function Sidebar({
  activeSection,
  activeLibrary,
  stats,
  pagination,
  artists,
  albums,
  playlists,
  devices,
  selectedCount,
  onLibraryTab,
  onSyncClick,
  onDevicesClick,
}: SidebarProps): JSX.Element {
  const tabClass = (active: boolean) =>
    `w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${active ? 'bg-blue-600 text-white' : 'hover:bg-zinc-800'}`

  return (
    <aside className="w-64 border-r border-zinc-800 p-4">
      {/* Library */}
      <div className="mb-6">
        <h3 className="text-xs font-medium text-zinc-500 uppercase mb-2">Library</h3>
        <nav className="space-y-1">
          <button
            data-testid="tab-artists"
            onClick={() => onLibraryTab('artists')}
            className={tabClass(activeSection === 'library' && activeLibrary === 'artists')}
          >
            <User className="w-4 h-4" />
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
            <Disc className="w-4 h-4" />
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
            <ListMusic className="w-4 h-4" />
            Playlists
            <span className="ml-auto text-xs opacity-60">
              {stats ? stats.PlaylistCount.toLocaleString() : pagination.playlists.total > 0 ? pagination.playlists.total : playlists.length}
            </span>
          </button>
        </nav>
      </div>

      {/* Sync */}
      <div className="mb-6">
        <h3 className="text-xs font-medium text-zinc-500 uppercase mb-2">Sync</h3>
        <nav className="space-y-1">
          <button
            data-testid="tab-sync"
            onClick={onSyncClick}
            className={tabClass(activeSection === 'sync')}
          >
            <HardDrive className="w-4 h-4" />
            Sync to Device
            {selectedCount > 0 && (
              <span className="ml-auto bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full">
                {selectedCount}
              </span>
            )}
          </button>
        </nav>
      </div>

      {/* Devices */}
      <div>
        <h3 className="text-xs font-medium text-zinc-500 uppercase mb-2">Devices</h3>
        <nav className="space-y-1">
          {devices.length === 0 ? (
            <p className="text-xs text-zinc-500 px-3">No USB devices</p>
          ) : (
            devices.map((device) => (
              <button
                key={`${device.vendorId}-${device.productId}-${device.deviceAddress}`}
                onClick={onDevicesClick}
                className={tabClass(activeSection === 'devices')}
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
  )
}
