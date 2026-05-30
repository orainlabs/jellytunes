import { useRef, useState, useEffect } from 'react';
import { Loader2, X, Search } from 'lucide-react';
import { LibraryItem } from './LibraryItem';
import type {
  LibraryTab,
  Artist,
  AlbumArtist,
  Album,
  Playlist,
  PaginationState,
  LibraryStats,
} from '../appTypes';

type SyncFilter = 'all' | 'selected' | 'unselected';

interface SearchResults {
  artists: Artist[];
  albumArtists: AlbumArtist[];
  albums: Album[];
  playlists: Playlist[];
}

interface SelectAllConfirmDialogProps {
  count: number;
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
}

function SelectAllConfirmDialog({
  count,
  label,
  onCancel,
  onConfirm,
}: SelectAllConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        data-testid="select-all-confirm-dialog"
        className="bg-surface_container_low border border-outline_variant rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-title-md mb-2">Confirm Select All</h3>
        <p className="text-body-md text-on_surface_variant mb-4">
          You're about to select{' '}
          <span data-testid="select-all-count" className="font-medium text-primary">
            {count.toLocaleString()}
          </span>{' '}
          <span data-testid="select-all-label">{label}</span>. This may take a moment.
        </p>
        <div className="flex gap-3">
          <button
            data-testid="select-all-cancel-btn"
            onClick={onCancel}
            className="flex-1 py-2 rounded-lg bg-surface_container_highest hover:bg-surface_bright text-body-md transition-colors"
          >
            Cancel
          </button>
          <button
            data-testid="select-all-confirm-btn"
            onClick={onConfirm}
            className="flex-1 py-2 rounded-lg bg-gradient-primary hover:bg-secondary_container text-body-md font-medium transition-colors"
          >
            Select All
          </button>
        </div>
      </div>
    </div>
  );
}

interface LibraryContentProps {
  activeLibrary: LibraryTab;
  artists: Artist[];
  albumArtists: AlbumArtist[];
  albums: Album[];
  playlists: Playlist[];
  pagination: PaginationState;
  selectedTracks: Set<string>;
  previouslySyncedItems: Set<string>;
  outOfSyncItems: Set<string>;
  isLoadingMore: boolean;
  error: string | null;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onClearError: () => void;
  onLoadMore: (type: LibraryTab) => void;
  selectionSummary: string;
  contentScrollRef: React.RefObject<HTMLDivElement>;
  hasActiveDevice?: boolean;
  serverUrl?: string;
  // Search (managed by parent, API-driven)
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onClearSearch: () => void;
  searchResults: SearchResults | null;
  isSearching: boolean;
  searchError?: string | null;
  // Stats for confirmation dialog fallback (passed from parent via context or props)
  stats?: LibraryStats | null;
}

export function LibraryContent({
  activeLibrary,
  artists,
  albumArtists,
  albums,
  playlists,
  pagination,
  selectedTracks,
  previouslySyncedItems,
  outOfSyncItems,
  isLoadingMore,
  error,
  onToggle,
  onSelectAll,
  onClearSelection,
  onClearError,
  onLoadMore,
  selectionSummary,
  contentScrollRef,
  hasActiveDevice,
  serverUrl,
  searchQuery,
  onSearchChange,
  onClearSearch,
  searchResults,
  isSearching,
  searchError,
  stats,
}: LibraryContentProps): JSX.Element {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [syncFilter, setSyncFilter] = useState<SyncFilter>('all');
  // Snapshot of selectedTracks IDs taken when the filter is applied — prevents items from
  // disappearing live as the user selects/deselects them within the filtered view
  const [filterSnapshot, setFilterSnapshot] = useState<Set<string>>(new Set());
  const [noDeviceHint, setNoDeviceHint] = useState(false);
  // Confirmation dialog state for large selections
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingSelectAll, setPendingSelectAll] = useState(false);

  const isSearchActive = searchQuery.length >= 2;

  // Take a snapshot when filter changes, reset to 'all' when selection is cleared
  useEffect(() => {
    if (selectedTracks.size === 0) {
      setSyncFilter('all');
      return;
    }
  }, [selectedTracks.size]);

  const applyFilter = (f: SyncFilter) => {
    // Don't apply filter if the results would be empty
    if (f === 'selected' && selectedTracks.size === 0) return;
    if (f === 'unselected') {
      const totalItems = artists.length + albums.length + playlists.length;
      if (selectedTracks.size >= totalItems) return;
    }
    setSyncFilter(f);
    setFilterSnapshot(new Set(selectedTracks));
  };

  // Intersection observer — disabled when search active or sync filter applied
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || isSearchActive || syncFilter !== 'all') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isLoadingMore) onLoadMore(activeLibrary);
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeLibrary, isLoadingMore, isSearchActive, syncFilter, onLoadMore]);

  const handleToggle = (id: string) => {
    if (!hasActiveDevice) {
      setNoDeviceHint(true);
      setTimeout(() => setNoDeviceHint(false), 2500);
      return;
    }
    onToggle(id);
  };

  // Filter uses snapshot so items don't vanish mid-interaction
  const applySyncFilter = <T extends { Id: string }>(items: T[]) => {
    if (syncFilter === 'selected') return items.filter((i) => filterSnapshot.has(i.Id));
    if (syncFilter === 'unselected') return items.filter((i) => !filterSnapshot.has(i.Id));
    return items;
  };

  const displayArtists = isSearchActive
    ? applySyncFilter(searchResults?.artists ?? [])
    : applySyncFilter(artists);
  const displayAlbumArtists = isSearchActive
    ? applySyncFilter(searchResults?.albumArtists ?? [])
    : applySyncFilter(albumArtists);
  const displayAlbums = isSearchActive
    ? applySyncFilter(searchResults?.albums ?? [])
    : applySyncFilter(albums);
  const displayPlaylists = isSearchActive
    ? applySyncFilter(searchResults?.playlists ?? [])
    : applySyncFilter(playlists);

  const tabLabel =
    activeLibrary === 'artists'
      ? 'artists'
      : activeLibrary === 'albumArtists'
        ? 'album artists'
        : activeLibrary === 'albums'
          ? 'albums'
          : 'playlists';
  const currentItems =
    activeLibrary === 'artists'
      ? displayArtists
      : activeLibrary === 'albumArtists'
        ? displayAlbumArtists
        : activeLibrary === 'albums'
          ? displayAlbums
          : displayPlaylists;
  const hasResults = currentItems.length > 0;
  const currentPagination = pagination[activeLibrary];

  // Determine item count for confirmation dialog
  // Uses pagination.total as primary source, falls back to stats
  const getItemCount = (): number => {
    // Primary: use pagination total
    if (pagination[activeLibrary].total > 0) {
      return pagination[activeLibrary].total;
    }

    // Fallback for artists/albums/playlists: use stats
    const tabCountKey =
      activeLibrary === 'artists'
        ? 'ArtistCount'
        : activeLibrary === 'albums'
          ? 'AlbumCount'
          : 'PlaylistCount';

    // Fallback: use stats (handles race condition where stats resolves before tab loads)
    if (stats && tabCountKey in stats) {
      return stats[tabCountKey as keyof LibraryStats] as number;
    }

    // Ultimate fallback: count current items
    return currentItems.length;
  };

  const handleSelectAllClick = () => {
    if (!hasActiveDevice) {
      setNoDeviceHint(true);
      setTimeout(() => setNoDeviceHint(false), 2500);
      return;
    }

    // Check if count exceeds threshold (500) — show confirmation dialog
    const count = getItemCount();
    if (count > 500) {
      setShowConfirmDialog(true);
      setPendingSelectAll(true);
    } else {
      onSelectAll();
    }
  };

  const handleConfirmSelectAll = () => {
    setShowConfirmDialog(false);
    setPendingSelectAll(false);
    onSelectAll();
  };

  const handleCancelSelectAll = () => {
    setShowConfirmDialog(false);
    setPendingSelectAll(false);
  };

  // Determine if Select All should be disabled (loading or pending confirmation)
  const isSelectAllDisabled = isLoadingMore || pendingSelectAll;

  return (
    <>
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* ── Sticky header ─────────────────────────────────── */}
        <div className="flex-shrink-0 border-b border-outline_variant relative">
          {/* No-device hint toast */}
          {noDeviceHint && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-4 py-2 bg-surface_container_low border border-primary_container/40 rounded-lg text-body-md text-primary shadow-lg animate-pulse pointer-events-none">
              Select a device in the sidebar first
            </div>
          )}

          <div className="px-4 pt-3 pb-2 space-y-2">
            {/* Title + sync filter */}
            <div className="flex items-center justify-between">
              <h2 className="text-headline-md capitalize">{activeLibrary}</h2>
              <div className="flex gap-1 text-caption bg-surface_container_low rounded-lg p-1">
                {(['all', 'selected', 'unselected'] as SyncFilter[]).map((f) => {
                  const isSelected = syncFilter === f;
                  const isDisabled =
                    (f === 'selected' && selectedTracks.size === 0) ||
                    (f === 'unselected' &&
                      selectedTracks.size >= artists.length + albums.length + playlists.length);
                  return (
                    <button
                      key={f}
                      data-testid={`sync-filter-${f}`}
                      onClick={() => applyFilter(f)}
                      disabled={isDisabled}
                      className={`px-3 py-1 rounded-md transition-colors ${isSelected ? 'bg-primary_container/40 text-primary' : 'text-on_surface_variant hover:text-on_surface'} ${isDisabled ? 'opacity-40 cursor-default' : ''}`}
                    >
                      {f === 'all' ? 'All' : f === 'selected' ? 'Selected' : 'Not selected'}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on_surface_variant pointer-events-none" />
              <input
                data-testid="search-input"
                type="text"
                placeholder={`Search ${tabLabel}...`}
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                className="w-full bg-surface_container_low border border-outline_variant rounded-lg pl-10 pr-9 py-1.5 text-body-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              />
              {searchQuery && (
                <button
                  onClick={onClearSearch}
                  aria-label="Clear search"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-on_surface_variant hover:text-on_surface transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* ORAIN-0421: Selection controls — controls LEFT, label RIGHT */}
            <div className="flex items-center justify-between">
              <div className="flex gap-3">
                {!isSearchActive && (
                  <button
                    data-testid="select-all-button"
                    onClick={handleSelectAllClick}
                    disabled={isSelectAllDisabled}
                    className={`text-caption ${isSelectAllDisabled ? 'text-on_surface_variant/40 cursor-default' : 'text-primary hover:text-primary'}`}
                  >
                    {isLoadingMore ? (
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Selecting...
                      </span>
                    ) : (
                      'Select all'
                    )}
                  </button>
                )}
                {!isSearchActive && selectedTracks.size > 0 && (
                  <button
                    data-testid="clear-selection-button"
                    onClick={onClearSelection}
                    className="text-caption text-on_surface_variant hover:text-on_surface"
                  >
                    Clear
                  </button>
                )}
              </div>
              <span className="text-caption text-on_surface_variant">
                {selectedTracks.size > 0 ? selectionSummary : 'None selected'}
              </span>
            </div>
          </div>
        </div>

        {/* ── Scrollable list ────────────────────────────────── */}
        <div ref={contentScrollRef} className="flex-1 overflow-auto px-4 py-2">
          {/* Error */}
          {error && (
            <div className="mb-3 p-3 bg-error_container border border-error rounded-lg flex items-center gap-2 text-error">
              <X className="w-4 h-4 flex-shrink-0" />
              <span className="text-body-md">{error}</span>
              <button onClick={onClearError} className="ml-auto text-caption hover:text-error">
                Dismiss
              </button>
            </div>
          )}

          {isSearchActive && isSearching ? (
            <div
              data-testid="library-loading"
              className="flex items-center gap-2 text-on_surface_variant text-body-md py-8 justify-center"
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              Searching {tabLabel}...
            </div>
          ) : isSearchActive && searchError ? (
            <p className="text-error text-body-md py-8 text-center">Search failed: {searchError}</p>
          ) : isSearchActive && !hasResults ? (
            <p
              data-testid="library-empty"
              className="text-on_surface_variant text-body-md py-8 text-center"
            >
              No {tabLabel} found for "{searchQuery}"
            </p>
          ) : !isSearchActive && !hasResults && !isLoadingMore && currentPagination.total === 0 ? (
            <div data-testid="library-skeleton" className="grid gap-0.5">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg animate-pulse bg-surface_container_low"
                >
                  <div className="w-4 h-4 rounded bg-surface_container_highest flex-shrink-0" />
                  <div className="w-10 h-10 rounded bg-surface_container_highest flex-shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 bg-surface_container_highest rounded w-3/4" />
                    <div className="h-2 bg-surface_container_highest rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div data-testid="library-content" className="grid gap-0.5">
              {activeLibrary === 'artists' &&
                displayArtists.map((artist, idx) => (
                  <LibraryItem
                    key={artist.Id || `artist-${idx}`}
                    item={artist}
                    type="artist"
                    isSelected={selectedTracks.has(artist.Id)}
                    wasSynced={previouslySyncedItems.has(artist.Id)}
                    outOfSync={outOfSyncItems.has(artist.Id)}
                    onToggle={handleToggle}
                    serverUrl={serverUrl}
                  />
                ))}

              {activeLibrary === 'albumArtists' &&
                displayAlbumArtists.map((albumArtist, idx) => (
                  <LibraryItem
                    key={albumArtist.Id || `albumArtist-${idx}`}
                    item={albumArtist}
                    type="albumArtist"
                    isSelected={selectedTracks.has(albumArtist.Id)}
                    wasSynced={previouslySyncedItems.has(albumArtist.Id)}
                    outOfSync={outOfSyncItems.has(albumArtist.Id)}
                    onToggle={handleToggle}
                    serverUrl={serverUrl}
                  />
                ))}

              {activeLibrary === 'albums' &&
                displayAlbums.map((album, idx) => (
                  <LibraryItem
                    key={album.Id || `album-${idx}`}
                    item={album}
                    type="album"
                    isSelected={selectedTracks.has(album.Id)}
                    wasSynced={previouslySyncedItems.has(album.Id)}
                    outOfSync={outOfSyncItems.has(album.Id)}
                    onToggle={handleToggle}
                    serverUrl={serverUrl}
                  />
                ))}

              {activeLibrary === 'playlists' &&
                displayPlaylists.map((playlist, idx) => (
                  <LibraryItem
                    key={playlist.Id || `playlist-${idx}`}
                    item={playlist}
                    type="playlist"
                    isSelected={selectedTracks.has(playlist.Id)}
                    wasSynced={previouslySyncedItems.has(playlist.Id)}
                    outOfSync={outOfSyncItems.has(playlist.Id)}
                    onToggle={handleToggle}
                    serverUrl={serverUrl}
                  />
                ))}

              {/* Infinite scroll sentinel */}
              {!isSearchActive && (
                <div ref={sentinelRef} className="h-8 flex items-center justify-center">
                  {isLoadingMore && (
                    <div className="flex items-center gap-2 text-on_surface_variant text-label-sm">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Loading more...
                    </div>
                  )}
                  {!isLoadingMore && currentPagination.hasMore && (
                    <div className="text-on_surface_variant/40 text-label-sm">· · ·</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Confirmation dialog for large selections */}
      {showConfirmDialog && (
        <SelectAllConfirmDialog
          count={getItemCount()}
          label={tabLabel}
          onCancel={handleCancelSelectAll}
          onConfirm={handleConfirmSelectAll}
        />
      )}
    </>
  );
}
