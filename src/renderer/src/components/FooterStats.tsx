import { useEffect, useState } from 'react';
import type { LibraryStats, PaginationState, Artist, Album, Playlist, Genre } from '../appTypes';
import { HardDrive, Folder } from 'lucide-react';

interface FooterStatsProps {
  stats: LibraryStats | null;
  pagination: PaginationState;
  artists: Artist[];
  albums: Album[];
  playlists: Playlist[];
  genres: Genre[];
  activeDeviceName?: string | null;
  isUsbDevice?: boolean;
  onGoToDevice?: () => void;
  isSyncing?: boolean;
}

export function FooterStats({
  stats,
  pagination,
  artists,
  albums,
  playlists,
  genres,
  activeDeviceName,
  isUsbDevice,
  onGoToDevice,
  isSyncing,
}: FooterStatsProps): JSX.Element {
  const [updateInfo, setUpdateInfo] = useState<{
    latestVersion: string;
    releaseUrl: string;
  } | null>(null);

  useEffect(() => {
    window.api
      .checkForUpdates()
      .then((result) => {
        if (result.updateAvailable)
          setUpdateInfo({ latestVersion: result.latestVersion, releaseUrl: result.releaseUrl });
      })
      .catch(() => {});
  }, []);

  const genreCount = pagination.genres?.total > 0 ? pagination.genres.total : genres.length;
  const libraryText = stats
    ? `${stats.ArtistCount.toLocaleString()} artists · ${stats.AlbumCount.toLocaleString()} albums · ${stats.PlaylistCount.toLocaleString()} playlists · ${genreCount.toLocaleString()} genres`
    : `${pagination.artists.total > 0 ? pagination.artists.total : artists.length} artists · ${pagination.albums.total > 0 ? pagination.albums.total : albums.length} albums · ${pagination.playlists.total > 0 ? pagination.playlists.total : playlists.length} playlists · ${genreCount.toLocaleString()} genres`;

  const DeviceIcon = isUsbDevice ? HardDrive : Folder;

  return (
    <footer className="h-10 border-t border-outline_variant flex items-center justify-between px-4 text-label-sm text-on_surface_variant">
      <span className="flex items-center gap-3">
        {libraryText}
        {updateInfo && (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.open(updateInfo.releaseUrl);
            }}
            className="text-primary hover:text-on_surface transition-colors"
          >
            v{updateInfo.latestVersion} available ↗
          </a>
        )}
      </span>
      {activeDeviceName ? (
        <button
          onClick={onGoToDevice}
          disabled={isSyncing}
          className={`flex items-center gap-1.5 px-3 py-1.5 -my-1.5 rounded-lg transition-colors${isSyncing ? ' text-primary/40 cursor-default' : ' text-primary hover:bg-primary_container/15 cursor-pointer'}`}
          aria-label={`View device ${activeDeviceName}`}
        >
          <DeviceIcon className="w-3 h-3" />
          {activeDeviceName}
        </button>
      ) : (
        <button
          onClick={onGoToDevice}
          disabled={isSyncing}
          className={`flex items-center gap-1.5 px-3 py-1.5 -my-1.5 rounded-lg transition-colors${isSyncing ? ' text-on_surface_variant/40 cursor-default' : ' text-on_surface_variant hover:bg-surface_container_high/50 cursor-pointer'}`}
          aria-label="Select a device"
        >
          No device selected
        </button>
      )}
    </footer>
  );
}
