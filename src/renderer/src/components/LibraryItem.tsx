import type React from 'react';
import { useState } from 'react';
import { User, Disc, ListMusic } from 'lucide-react';
import type { Artist, AlbumArtist, Album, Playlist } from '../appTypes';
import { formatRunTimeTicks } from '../utils/jellyfin';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver';

interface LibraryItemProps {
  item: Artist | AlbumArtist | Album | Playlist;
  type: 'artist' | 'albumArtist' | 'album' | 'playlist';
  isSelected: boolean;
  wasSynced: boolean;
  outOfSync: boolean;
  onToggle: (id: string, viewType?: 'artist' | 'albumArtist') => void;
  serverUrl?: string;
}

function ItemThumbnail({
  item,
  type,
  serverUrl,
}: {
  item: Artist | AlbumArtist | Album | Playlist;
  type: 'artist' | 'albumArtist' | 'album' | 'playlist';
  serverUrl?: string;
}) {
  const [imgError, setImgError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const tag = item.ImageTags?.Primary;
  const { ref, isIntersecting } = useIntersectionObserver<HTMLDivElement>({
    rootMargin: '100px',
    triggerOnce: true,
  });

  // Decide whether to start loading the image (requires visibility and no errors)
  const shouldLoad = serverUrl && tag && !imgError && isIntersecting;
  // Decide whether to display the img element (once loaded, stay visible permanently)
  const hasLoaded = imgLoaded;

  // albumArtist uses the same icon as artist (User)
  const Icon =
    type === 'artist' || type === 'albumArtist' ? User : type === 'album' ? Disc : ListMusic;
  const rounded = type === 'artist' || type === 'albumArtist' ? 'rounded-full' : 'rounded';

  // Show image once loaded, otherwise show placeholder
  if (hasLoaded) {
    const src = `${serverUrl}/Items/${item.Id}/Images/Primary?fillHeight=40&fillWidth=40&quality=85&tag=${tag}`;
    return (
      <div
        ref={ref as React.RefObject<HTMLDivElement>}
        className={`w-10 h-10 flex-shrink-0 ${rounded}`}
      >
        <img
          src={src}
          alt=""
          className={`w-10 h-10 object-cover ${rounded}`}
          onError={() => setImgError(true)}
          onLoad={() => setImgLoaded(true)}
        />
      </div>
    );
  }

  // Show placeholder or image loading state
  if (shouldLoad) {
    const src = `${serverUrl}/Items/${item.Id}/Images/Primary?fillHeight=40&fillWidth=40&quality=85&tag=${tag}`;
    return (
      <div
        ref={ref as React.RefObject<HTMLDivElement>}
        className={`w-10 h-10 flex-shrink-0 ${rounded}`}
      >
        <img
          src={src}
          alt=""
          className={`w-10 h-10 object-cover ${rounded}`}
          onError={() => setImgError(true)}
          onLoad={() => setImgLoaded(true)}
        />
      </div>
    );
  }

  return (
    <div
      ref={ref as React.RefObject<HTMLDivElement>}
      className={`w-10 h-10 bg-surface_container_low flex items-center justify-center flex-shrink-0 ${rounded}`}
    >
      <Icon className="w-5 h-5 text-on_surface_variant" />
    </div>
  );
}

export function LibraryItem({
  item,
  type,
  isSelected,
  wasSynced,
  outOfSync,
  onToggle,
  serverUrl,
}: LibraryItemProps): JSX.Element {
  const willDelete = wasSynced && !isSelected;
  const pendingSync = isSelected && !wasSynced;

  const artist = item as Artist;
  const albumArtist = item as AlbumArtist;
  const album = item as Album;
  const playlist = item as Playlist;

  const subtitle = (() => {
    if (type === 'artist') {
      // AC: Never show album count — /Artists endpoint doesn't return ChildCount reliably
      const runtime = formatRunTimeTicks(artist.RunTimeTicks);
      return runtime ?? null;
    }

    if (type === 'albumArtist') {
      // Album Artists can show AlbumCount reliably via /Artists/AlbumArtists endpoint
      const runtime = formatRunTimeTicks(albumArtist.RunTimeTicks);
      if (albumArtist.AlbumCount && albumArtist.AlbumCount > 0 && runtime)
        return `${albumArtist.AlbumCount} album${albumArtist.AlbumCount !== 1 ? 's' : ''} · ${runtime}`;
      if (albumArtist.AlbumCount && albumArtist.AlbumCount > 0)
        return `${albumArtist.AlbumCount} album${albumArtist.AlbumCount !== 1 ? 's' : ''}`;
      return runtime ?? null;
    }

    if (type === 'album') {
      const parts: string[] = [];
      if (album.AlbumArtist) parts.push(album.AlbumArtist);
      if (album.ProductionYear) parts.push(String(album.ProductionYear));
      if (album.ChildCount && album.ChildCount > 0)
        parts.push(`${album.ChildCount} track${album.ChildCount !== 1 ? 's' : ''}`);
      const runtime = formatRunTimeTicks(album.RunTimeTicks);
      if (runtime) parts.push(runtime);
      if (parts.length === 0) return null;
      return parts.join(' · ');
    }

    // type === 'playlist'
    const trackCount = playlist.ChildCount;
    const runtime = formatRunTimeTicks(playlist.RunTimeTicks);
    // Hide track count when it's 0 or undefined (unreliable/meaningless)
    if (trackCount && trackCount > 0 && runtime) return `${trackCount} tracks · ${runtime}`;
    if (trackCount && trackCount > 0) return `${trackCount} track${trackCount !== 1 ? 's' : ''}`;
    if (runtime) return runtime;
    return null;
  })();

  return (
    <div
      data-testid="library-item"
      data-item-id={item.Id}
      data-item-type={type}
      // ORAIN-0551: pass the item's `type` as viewType so the toggle handler can
      // route the id to the correct typed set (selectedArtists vs
      // selectedAlbumArtists) even when the same id exists in both Jellyfin lists.
      onClick={() =>
        onToggle(item.Id, type === 'artist' || type === 'albumArtist' ? type : undefined)
      }
      className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${isSelected ? 'bg-primary_container/15 border border-primary_container/30 hover:bg-primary_container/20 border-l-4 border-primary' : willDelete ? 'border border-error/40 hover:bg-surface_container_low border-l-4 border-transparent' : 'border border-transparent hover:bg-surface_container_low border-l-4 border-transparent'}`}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={() =>
          onToggle(item.Id, type === 'artist' || type === 'albumArtist' ? type : undefined)
        }
        onClick={(e) => e.stopPropagation()}
        className="w-4 h-4 rounded border-outline_variant bg-surface_container_high text-primary focus-visible:ring-primary flex-shrink-0"
      />
      <ItemThumbnail item={item} type={type} serverUrl={serverUrl} />
      <div className="flex-1 min-w-0 self-stretch flex flex-col justify-center">
        <p
          className={`text-title-md leading-tight font-semibold truncate ${willDelete ? 'line-through opacity-50' : ''}`}
        >
          {item.Name}
        </p>
        <p className="text-caption text-on_surface_variant flex items-center gap-1.5 h-4">
          {subtitle && <span className="truncate">{subtitle}</span>}
          {wasSynced && !outOfSync && (
            <span
              className={`px-1.5 py-0.5 rounded-md text-caption flex-shrink-0 ${willDelete ? 'bg-error_container text-error' : 'bg-success/20 text-success'}`}
            >
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
  );
}
