import { User, Disc, ListMusic, Play } from 'lucide-react'
import type { Artist, Album, Playlist } from '../appTypes'

interface LibraryItemProps {
  item: Artist | Album | Playlist
  type: 'artist' | 'album' | 'playlist'
  isSelected: boolean
  wasSynced: boolean
  onToggle: (id: string) => void
}

export function LibraryItem({ item, type, isSelected, wasSynced, onToggle }: LibraryItemProps): JSX.Element {
  const willDelete = wasSynced && !isSelected

  const icon = type === 'artist'
    ? <User className="w-6 h-6 text-zinc-500" />
    : type === 'album'
      ? <Disc className="w-6 h-6 text-zinc-500" />
      : <ListMusic className="w-6 h-6 text-zinc-500" />

  const albumCount = (item as Artist).AlbumCount
  const album = item as Album
  const playlist = item as Playlist

  const subtitle = type === 'artist'
    ? albumCount != null ? `${albumCount} album${albumCount !== 1 ? 's' : ''}` : null
    : type === 'album'
      ? [album.AlbumArtist, album.ProductionYear].filter(Boolean).join(' • ') || null
      : playlist.ChildCount != null ? `${playlist.ChildCount} song${playlist.ChildCount !== 1 ? 's' : ''}` : null

  const syncBadge = wasSynced && (
    <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${willDelete ? 'bg-red-900/50 text-red-400' : 'bg-green-900/50 text-green-400'}`}>
      {willDelete ? 'will remove' : 'synced'}
    </span>
  )

  return (
    <div className={`flex items-center gap-4 p-4 bg-zinc-900 rounded-lg hover:bg-zinc-800 transition-colors ${willDelete ? 'border border-red-800/50' : ''}`}>
      <input
        type="checkbox"
        checked={isSelected}
        onChange={() => onToggle(item.Id)}
        className="w-5 h-5 rounded border-zinc-600 bg-zinc-800 text-blue-600 focus:ring-blue-500"
      />
      <div className="w-12 h-12 bg-zinc-800 rounded-lg flex items-center justify-center">
        {icon}
      </div>
      <div className="flex-1">
        <h3 className="font-medium">{item.Name}</h3>
        <p className="text-sm text-zinc-500">
          {subtitle}
          {syncBadge}
          {!subtitle && !syncBadge && null}
        </p>
      </div>
      <button className="p-2 hover:bg-zinc-700 rounded-lg">
        <Play className="w-5 h-5" />
      </button>
    </div>
  )
}
