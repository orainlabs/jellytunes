import type { LibraryStats, PaginationState, Artist, Album, Playlist } from '../appTypes'
import { HardDrive, Folder } from 'lucide-react'

interface FooterStatsProps {
  stats: LibraryStats | null
  pagination: PaginationState
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
  activeDeviceName?: string | null
  isUsbDevice?: boolean
}

export function FooterStats({
  stats,
  pagination,
  artists,
  albums,
  playlists,
  activeDeviceName,
  isUsbDevice,
}: FooterStatsProps): JSX.Element {
  const libraryText = stats
    ? `${stats.ArtistCount.toLocaleString()} artists · ${stats.AlbumCount.toLocaleString()} albums · ${stats.PlaylistCount.toLocaleString()} playlists`
    : `${pagination.artists.total > 0 ? pagination.artists.total : artists.length} artists · ${pagination.albums.total > 0 ? pagination.albums.total : albums.length} albums · ${pagination.playlists.total > 0 ? pagination.playlists.total : playlists.length} playlists`

  const DeviceIcon = isUsbDevice ? HardDrive : Folder

  return (
    <footer className="h-10 border-t border-zinc-800 flex items-center justify-between px-4 text-xs text-zinc-500">
      <span>{libraryText}</span>
      {activeDeviceName ? (
        <span className="flex items-center gap-1.5 text-jf-purple-light">
          <DeviceIcon className="w-3 h-3" />
          {activeDeviceName}
        </span>
      ) : (
        <span className="text-zinc-600">No device selected · Choose from sidebar</span>
      )}
    </footer>
  )
}
