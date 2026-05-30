import { useState } from 'react';
import {
  User,
  Disc,
  ListMusic,
  Tag,
  HardDrive,
  Folder,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type {
  ActiveSection,
  LibraryTab,
  LibraryStats,
  PaginationState,
  Artist,
  Album,
  Playlist,
  Genre,
  UsbDevice,
  SavedDestination,
} from '../appTypes';
import { RemoveFolderModal } from './RemoveFolderModal';

interface SidebarProps {
  activeSection: ActiveSection;
  activeLibrary: LibraryTab;
  activeDestinationPath: string | null;
  stats: LibraryStats | null;
  pagination: PaginationState;
  artists: Artist[];
  albums: Album[];
  playlists: Playlist[];
  genres: Genre[];
  selectedGenre: Genre | null;
  onLibraryTab: (tab: LibraryTab) => void;
  onSelectGenre: (genre: Genre | null) => void;
  onDestinationClick: (path: string) => void;
  onAddFolder: () => void;
  onRefreshDevices: () => void;
  onRefreshLibrary?: () => void;
  onRemoveDestination: (path: string, deleteFiles: boolean, onDone: () => void) => void;
  isRemovingDestination?: boolean;
  isSyncing?: boolean;
  usbDevices: UsbDevice[];
  savedDestinations: SavedDestination[];
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
  genres,
  selectedGenre,
  onLibraryTab,
  onSelectGenre,
  onDestinationClick,
  onAddFolder,
  onRefreshDevices,
  onRefreshLibrary,
  onRemoveDestination,
  isRemovingDestination,
  isSyncing,
  usbDevices,
  savedDestinations,
}: SidebarProps): JSX.Element {
  const [modalDest, setModalDest] = useState<SavedDestination | null>(null);

  const tabClass = (active: boolean) =>
    `w-full flex items-center gap-2 px-3 py-2 rounded-lg text-body-md transition-colors ${active ? 'bg-primary_container/20 text-primary border border-primary_container/40' : 'hover:bg-surface_container_high text-on_surface border border-transparent'}`;

  const destClass = (path: string) =>
    `w-full flex items-center gap-2 px-3 py-2 rounded-lg text-body-md transition-colors ${activeDestinationPath === path ? 'bg-primary_container/20 text-primary border border-primary_container/40' : 'hover:bg-surface_container_high text-on_surface border border-transparent'}`;

  // USB devices that have at least one mountpoint
  const mountedUsb = usbDevices.flatMap((d) =>
    d.mountpoints.map((mp) => ({
      name: d.productName ?? d.displayName ?? 'USB Device',
      path: mp.path,
    })),
  );

  const hasDevices = mountedUsb.length > 0;
  const hasFolders = savedDestinations.length > 0;

  return (
    <aside
      className={`w-64 border-r border-outline_variant p-4 flex flex-col${isSyncing ? ' pointer-events-none select-none' : ''}`}
    >
      {/* Library */}
      <div className="mb-6">
        <h3 className="text-label-md uppercase text-on_surface_variant/60 px-3 mb-1 flex items-center justify-between">
          Library
          {onRefreshLibrary && (
            <button
              data-testid="refresh-library-button"
              onClick={onRefreshLibrary}
              aria-label="Refresh library"
              className="p-0.5 text-on_surface_variant hover:text-on_surface transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
        </h3>
        <nav className="space-y-1">
          <button
            data-testid="tab-artists"
            onClick={() => onLibraryTab('artists')}
            className={tabClass(activeSection === 'library' && activeLibrary === 'artists')}
          >
            <User className="w-4 h-4 flex-shrink-0" />
            Artists
            <span className="ml-auto text-label-sm opacity-60">
              {stats
                ? stats.ArtistCount.toLocaleString()
                : pagination.artists.total > 0
                  ? pagination.artists.total
                  : artists.length}
            </span>
          </button>
          <button
            data-testid="tab-albums"
            onClick={() => onLibraryTab('albums')}
            className={tabClass(activeSection === 'library' && activeLibrary === 'albums')}
          >
            <Disc className="w-4 h-4 flex-shrink-0" />
            Albums
            <span className="ml-auto text-label-sm opacity-60">
              {stats
                ? stats.AlbumCount.toLocaleString()
                : pagination.albums.total > 0
                  ? pagination.albums.total
                  : albums.length}
            </span>
          </button>
          <button
            data-testid="tab-playlists"
            onClick={() => onLibraryTab('playlists')}
            className={tabClass(activeSection === 'library' && activeLibrary === 'playlists')}
          >
            <ListMusic className="w-4 h-4 flex-shrink-0" />
            Playlists
            <span className="ml-auto text-label-sm opacity-60">
              {stats
                ? stats.PlaylistCount.toLocaleString()
                : pagination.playlists.total > 0
                  ? pagination.playlists.total
                  : playlists.length}
            </span>
          </button>
          <button
            data-testid="tab-genres"
            onClick={() => onSelectGenre(null)}
            className={tabClass(activeSection === 'library' && activeLibrary === 'genres')}
          >
            <Tag className="w-4 h-4 flex-shrink-0" />
            Genres
            <span className="ml-auto text-label-sm opacity-60">
              {pagination.genres?.total > 0 ? pagination.genres.total : genres.length}
            </span>
          </button>
        </nav>

        {/* Genre list - shown when genres tab is active and no genre is selected */}
        {activeSection === 'library' && activeLibrary === 'genres' && !selectedGenre && (
          <nav className="mt-2 space-y-1 pl-2">
            {genres.map((genre) => (
              <button
                key={genre.Name}
                data-testid={`genre-item-${genre.Name.toLowerCase().replace(/\s+/g, '-')}`}
                onClick={() => onSelectGenre(genre)}
                className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-body-sm transition-colors hover:bg-surface_container_high text-on_surface"
              >
                <span className="truncate">{genre.Name}</span>
                <span className="ml-auto text-label-sm opacity-50">{genre.LibraryItems ?? 0}</span>
              </button>
            ))}
          </nav>
        )}

        {/* Back to genres list - shown when a genre is selected */}
        {activeSection === 'library' && activeLibrary === 'genres' && selectedGenre && (
          <div className="mt-2 pl-2">
            <button
              data-testid="back-to-genres"
              onClick={() => onSelectGenre(null)}
              className="flex items-center gap-1 text-body-sm text-primary hover:text-primary transition-colors mb-1"
            >
              ← Back to Genres
            </button>
            <p className="text-label-sm text-on_surface_variant px-3 truncate">
              {selectedGenre.Name}
            </p>
          </div>
        )}
      </div>

      {/* Devices + Folders */}
      <div className="flex-1">
        {/* Devices section */}
        <h3 className="text-label-md uppercase text-on_surface_variant/60 px-3 mt-3 mb-1 flex items-center justify-between">
          Devices
          <button
            data-testid="refresh-devices-button"
            onClick={onRefreshDevices}
            aria-label="Refresh devices"
            className="p-0.5 text-on_surface_variant hover:text-on_surface transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </h3>
        <nav className="space-y-1">
          {mountedUsb.length === 0 && (
            <p className="text-caption text-on_surface_variant/50 px-3 py-1">
              No devices connected
            </p>
          )}
          {mountedUsb.map(({ name, path }) => (
            <button
              key={path}
              data-testid="device-item"
              data-device-path={path}
              onClick={() => onDestinationClick(path)}
              className={destClass(path)}
            >
              <HardDrive className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{name}</span>
            </button>
          ))}
        </nav>

        {/* Divider + Folders section */}
        {(hasDevices || hasFolders) && <div className="border-t border-outline_variant my-2" />}
        {hasFolders && (
          <>
            <h3 className="text-label-md uppercase text-on_surface_variant/60 px-3 mt-3 mb-1">
              Folders
            </h3>
            <nav className="space-y-1">
              {savedDestinations.map((dest) => (
                <div key={dest.id} className="rounded-lg overflow-hidden">
                  <div className="relative group/dest">
                    <button
                      data-testid="device-item"
                      data-device-path={dest.path}
                      onClick={() => onDestinationClick(dest.path)}
                      className={`${destClass(dest.path)} pr-7`}
                    >
                      <Folder className="w-4 h-4 flex-shrink-0" />
                      <span className="truncate">{dest.name}</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setModalDest(dest);
                      }}
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover/dest:opacity-100 text-on_surface_variant hover:text-error hover:bg-error_container transition-all"
                      title="Remove folder"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </nav>
          </>
        )}

        {/* Add folder */}
        <button
          data-testid="add-folder-button"
          onClick={onAddFolder}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-body-md text-on_surface_variant hover:text-on_surface hover:bg-surface_container_high transition-colors mt-1"
        >
          <Plus className="w-4 h-4 flex-shrink-0" />
          Add folder...
        </button>
      </div>

      {/* Shared remove modal */}
      {modalDest && (
        <RemoveFolderModal
          name={modalDest.name}
          path={modalDest.path}
          onCancel={() => setModalDest(null)}
          onConfirm={(deleteFiles) => {
            onRemoveDestination(modalDest.path, deleteFiles, () => setModalDest(null));
          }}
          isRemoving={isRemovingDestination}
        />
      )}
    </aside>
  );
}
