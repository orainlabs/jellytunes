import type { LibraryStats, PaginationState, Artist, Album, Playlist } from '../appTypes'

interface FooterStatsProps {
  stats: LibraryStats | null
  pagination: PaginationState
  artists: Artist[]
  albums: Album[]
  playlists: Playlist[]
}

export function FooterStats({ stats, pagination, artists, albums, playlists }: FooterStatsProps): JSX.Element {
  return (
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
  )
}
