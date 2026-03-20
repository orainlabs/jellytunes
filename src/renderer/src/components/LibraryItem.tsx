import { useState } from 'react'
import { User, Disc, ListMusic } from 'lucide-react'
import type { Artist, Album, Playlist } from '../appTypes'

interface LibraryItemProps {
  item: Artist | Album | Playlist
  type: 'artist' | 'album' | 'playlist'
  isSelected: boolean
  wasSynced: boolean
  onToggle: (id: string) => void
  serverUrl?: string
}

function ItemThumbnail({ item, type, serverUrl }: { item: Artist | Album | Playlist; type: 'artist' | 'album' | 'playlist'; serverUrl?: string }) {
  const [imgError, setImgError] = useState(false)
  const tag = item.ImageTags?.Primary

  if (serverUrl && tag && !imgError) {
    const src = `${serverUrl}/Items/${item.Id}/Images/Primary?fillHeight=40&fillWidth=40&quality=85&tag=${tag}`
    const rounded = type === 'artist' ? 'rounded-full' : 'rounded'
    return (
      <img
        src={src}
        alt=""
        className={`w-10 h-10 object-cover flex-shrink-0 ${rounded}`}
        onError={() => setImgError(true)}
      />
    )
  }

  const Icon = type === 'artist' ? User : type === 'album' ? Disc : ListMusic
  const rounded = type === 'artist' ? 'rounded-full' : 'rounded'
  return (
    <div className={`w-10 h-10 bg-zinc-800 flex items-center justify-center flex-shrink-0 ${rounded}`}>
      <Icon className="w-5 h-5 text-zinc-500" />
    </div>
  )
}

export function LibraryItem({ item, type, isSelected, wasSynced, onToggle, serverUrl }: LibraryItemProps): JSX.Element {
  const willDelete = wasSynced && !isSelected

  const albumCount = (item as Artist).AlbumCount
  const album = item as Album
  const playlist = item as Playlist

  const subtitle = type === 'artist'
    ? albumCount != null ? `${albumCount} album${albumCount !== 1 ? 's' : ''}` : null
    : type === 'album'
      ? [album.AlbumArtist, album.ProductionYear].filter(Boolean).join(' · ') || null
      : playlist.ChildCount != null ? `${playlist.ChildCount} track${playlist.ChildCount !== 1 ? 's' : ''}` : null

  return (
    <div
      onClick={() => onToggle(item.Id)}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors hover:bg-zinc-800 ${willDelete ? 'border border-red-800/40' : ''} ${isSelected ? 'bg-zinc-900' : ''}`}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={() => onToggle(item.Id)}
        onClick={e => e.stopPropagation()}
        className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-jf-purple focus:ring-jf-purple flex-shrink-0"
      />
      <ItemThumbnail item={item} type={type} serverUrl={serverUrl} />
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium truncate ${willDelete ? 'line-through opacity-50' : ''}`}>{item.Name}</p>
        {(subtitle || wasSynced) && (
          <p className="text-xs text-zinc-500 flex items-center gap-1.5 truncate">
            {subtitle && <span>{subtitle}</span>}
            {wasSynced && (
              <span className={`px-1.5 py-0.5 rounded text-xs ${willDelete ? 'bg-red-900/50 text-red-400' : 'bg-green-900/50 text-green-400'}`}>
                {willDelete ? 'will remove' : 'synced'}
              </span>
            )}
          </p>
        )}
      </div>
    </div>
  )
}
