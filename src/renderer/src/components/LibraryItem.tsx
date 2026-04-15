import { useState } from 'react'
import { User, Disc, ListMusic } from 'lucide-react'
import type { Artist, Album, Playlist } from '../appTypes'

interface LibraryItemProps {
  item: Artist | Album | Playlist
  type: 'artist' | 'album' | 'playlist'
  isSelected: boolean
  wasSynced: boolean
  outOfSync: boolean
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
    <div className={`w-10 h-10 bg-surface_container_low flex items-center justify-center flex-shrink-0 ${rounded}`}>
      <Icon className="w-5 h-5 text-on_surface_variant" />
    </div>
  )
}

export function LibraryItem({ item, type, isSelected, wasSynced, outOfSync, onToggle, serverUrl }: LibraryItemProps): JSX.Element {
  const willDelete = wasSynced && !isSelected
  const pendingSync = isSelected && !wasSynced

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
      data-testid="library-item"
      data-item-id={item.Id}
      data-item-type={type}
      onClick={() => onToggle(item.Id)}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${isSelected ? 'bg-primary_container/15 border border-primary_container/30 hover:bg-primary_container/20 border-l-4 border-primary' : willDelete ? 'border border-error/40 hover:bg-surface_container_low border-l-4 border-transparent' : 'border border-transparent hover:bg-surface_container_low border-l-4 border-transparent'}`}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={() => onToggle(item.Id)}
        onClick={e => e.stopPropagation()}
        className="w-4 h-4 rounded border-outline_variant bg-surface_container_high text-primary focus-visible:ring-primary flex-shrink-0"
      />
      <ItemThumbnail item={item} type={type} serverUrl={serverUrl} />
      <div className="flex-1 min-w-0 self-stretch flex flex-col justify-center">
        <p className={`text-title-md leading-tight font-semibold truncate ${willDelete ? 'line-through opacity-50' : ''}`}>{item.Name}</p>
        <p className="text-caption text-on_surface_variant flex items-center gap-1.5 h-4">
          {subtitle && <span className="truncate">{subtitle}</span>}
          {wasSynced && !outOfSync && (
            <span className={`px-1.5 py-0.5 rounded-md text-caption flex-shrink-0 ${willDelete ? 'bg-error_container text-error' : 'bg-success/20 text-success'}`}>
              {willDelete ? 'will remove' : 'synced'}
            </span>
          )}
          {pendingSync && (
            <span className="px-1.5 py-0.5 rounded-md text-caption flex-shrink-0 bg-primary_container/20 text-primary">
              pending sync
            </span>
          )}
          {outOfSync && !willDelete && (
            <span className="px-1.5 py-0.5 rounded-md text-caption flex-shrink-0 bg-warning_container text-warning">
              out of sync
            </span>
          )}
        </p>
      </div>
    </div>
  )
}
