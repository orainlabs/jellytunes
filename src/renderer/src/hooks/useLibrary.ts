import { useState, useRef, useEffect, useCallback } from 'react';
import type {
  JellyfinConfig,
  Artist,
  Album,
  Playlist,
  Genre,
  AlbumArtist,
  PaginationState,
  LibraryStats,
  LibraryTab,
  ItemTypeIndex,
} from '../appTypes';
import {
  jellyfinHeaders,
  buildUrl,
  PAGE_SIZE,
  normalizeArtist,
  normalizeAlbum,
  normalizePlaylist,
  normalizeGenre,
  normalizeAlbumArtist,
} from '../utils/jellyfin';
import { logger } from '../utils/logger';

export function useLibrary(jellyfinConfig: JellyfinConfig | null, userId: string | null) {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [albumArtists, setAlbumArtists] = useState<AlbumArtist[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [selectedGenre, setSelectedGenre] = useState<Genre | null>(null);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [activeLibrary, setActiveLibrary] = useState<LibraryTab>('artists');
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadedTabs, setLoadedTabs] = useState<Set<LibraryTab>>(new Set(['artists']));
  const [error, setError] = useState<string | null>(null);

  const [pagination, setPagination] = useState<PaginationState>({
    artists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    albumArtists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    albums: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    playlists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    genres: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
  });

  const itemTypeIndexRef = useRef<ItemTypeIndex>({
    artists: new Set(),
    albumArtists: new Set(),
    albums: new Set(),
    playlists: new Set(),
  });

  const [itemTypeIndex, setItemTypeIndex] = useState<ItemTypeIndex>({
    artists: new Set(),
    albumArtists: new Set(),
    albums: new Set(),
    playlists: new Set(),
  });

  const contentScrollRef = useRef<HTMLDivElement>(null);

  const loadStats = async (url: string, apiKey: string, uid: string): Promise<void> => {
    const headers = jellyfinHeaders(apiKey);
    const baseUrl = url.replace(/\/$/, '');
    const safeUserId = uid.trim();
    if (!safeUserId) return;
    try {
      const res = await fetch(buildUrl(baseUrl, `/Users/${safeUserId}/Items/Counts`), { headers });
      if (res.ok) {
        const data = await res.json();
        setStats({
          ArtistCount: data.ArtistCount ?? 0,
          AlbumCount: data.AlbumCount ?? 0,
          SongCount: data.ChildCount ?? data.TotalCount ?? 0,
          PlaylistCount: data.PlaylistCount ?? 0,
          ItemCount: data.ItemCount ?? 0,
        });
      } else {
        setStats(null);
      }
    } catch {
      setStats(null);
    }
  };

  const updateArtistIndex = (items: Artist[]) => {
    itemTypeIndexRef.current.artists = new Set([
      ...itemTypeIndexRef.current.artists,
      ...items.map((a) => a.Id),
    ]);
    setItemTypeIndex((prev) => {
      const s = new Set(prev.artists);
      items.forEach((a) => s.add(a.Id));
      return { ...prev, artists: s };
    });
  };

  const updateAlbumArtistIndex = (items: AlbumArtist[]) => {
    itemTypeIndexRef.current.albumArtists = new Set([
      ...itemTypeIndexRef.current.albumArtists,
      ...items.map((a) => a.Id),
    ]);
    setItemTypeIndex((prev) => {
      const s = new Set(prev.albumArtists);
      items.forEach((a) => s.add(a.Id));
      return { ...prev, albumArtists: s };
    });
  };

  const updateAlbumIndex = (items: Album[]) => {
    itemTypeIndexRef.current.albums = new Set([
      ...itemTypeIndexRef.current.albums,
      ...items.map((a) => a.Id),
    ]);
    setItemTypeIndex((prev) => {
      const s = new Set(prev.albums);
      items.forEach((a) => s.add(a.Id));
      return { ...prev, albums: s };
    });
  };

  const updatePlaylistIndex = (items: Playlist[]) => {
    itemTypeIndexRef.current.playlists = new Set([
      ...itemTypeIndexRef.current.playlists,
      ...items.map((p) => p.Id),
    ]);
    setItemTypeIndex((prev) => {
      const s = new Set(prev.playlists);
      items.forEach((p) => s.add(p.Id));
      return { ...prev, playlists: s };
    });
  };

  const loadLibrary = async (url: string, apiKey: string, uid: string): Promise<void> => {
    const headers = jellyfinHeaders(apiKey);
    const baseUrl = url.replace(/\/$/, '');

    setPagination({
      artists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
      albumArtists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
      albums: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
      playlists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
      genres: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    });
    setGenres([]);
    itemTypeIndexRef.current = {
      artists: new Set(),
      albumArtists: new Set(),
      albums: new Set(),
      playlists: new Set(),
      genres: new Set(),
    };

    try {
      const res = await fetch(
        buildUrl(
          baseUrl,
          `/Artists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=0&Fields=AlbumCount,RunTimeTicks,ChildCount`,
        ),
        { headers },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items: Artist[] = (data.Items ?? []).map(normalizeArtist);
      setArtists(items);
      itemTypeIndexRef.current.artists = new Set(items.map((a) => a.Id));
      updateArtistIndex(items);
      const totalCount = data.TotalRecordCount ?? items.length;
      setPagination((prev) => ({
        ...prev,
        artists: {
          items,
          total: totalCount,
          startIndex: items.length,
          hasMore: items.length < totalCount,
          scrollPos: 0,
        },
      }));
    } catch (e) {
      logger.error('Failed to load artists: ' + (e instanceof Error ? e.message : String(e)));
      setError('Error loading artists');
      setArtists([]);
    }

    // Fetch Album Artists (distinct from track-level Artists)
    try {
      const res = await fetch(
        buildUrl(
          baseUrl,
          `/Artists/AlbumArtists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=0&Fields=AlbumCount,RunTimeTicks,ChildCount`,
        ),
        { headers },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items: AlbumArtist[] = (data.Items ?? []).map(normalizeAlbumArtist);
      setAlbumArtists(items);
      itemTypeIndexRef.current.albumArtists = new Set(items.map((a) => a.Id));
      updateAlbumArtistIndex(items);
      const totalCount = data.TotalRecordCount ?? items.length;
      setPagination((prev) => ({
        ...prev,
        albumArtists: {
          items,
          total: totalCount,
          startIndex: items.length,
          hasMore: items.length < totalCount,
          scrollPos: 0,
        },
      }));
    } catch (e) {
      logger.error('Failed to load album artists: ' + (e instanceof Error ? e.message : String(e)));
      setAlbumArtists([]);
    }

    try {
      const res = await fetch(
        buildUrl(
          baseUrl,
          `/Items?IncludeItemTypes=MusicAlbum&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true&Fields=RunTimeTicks,ChildCount&userId=${uid}`,
        ),
        { headers },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items: Album[] = (data.Items ?? []).map(normalizeAlbum);
      setAlbums(items);
      itemTypeIndexRef.current.albums = new Set(items.map((a) => a.Id));
      updateAlbumIndex(items);
      const totalCount = data.TotalRecordCount ?? items.length;
      setPagination((prev) => ({
        ...prev,
        albums: {
          items,
          total: totalCount,
          startIndex: items.length,
          hasMore: items.length < totalCount,
          scrollPos: 0,
        },
      }));
    } catch (e) {
      logger.error('Failed to load albums: ' + (e instanceof Error ? e.message : String(e)));
      setAlbums([]);
    }

    try {
      const res = await fetch(
        buildUrl(
          baseUrl,
          `/Items?IncludeItemTypes=Playlist&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true&Fields=RunTimeTicks,ChildCount&userId=${uid}`,
        ),
        { headers },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items: Playlist[] = (data.Items ?? []).map(normalizePlaylist);
      setPlaylists(items);
      itemTypeIndexRef.current.playlists = new Set(items.map((p) => p.Id));
      updatePlaylistIndex(items);
      const totalCount = data.TotalRecordCount ?? items.length;
      setPagination((prev) => ({
        ...prev,
        playlists: {
          items,
          total: totalCount,
          startIndex: items.length,
          hasMore: items.length < totalCount,
          scrollPos: 0,
        },
      }));
    } catch (e) {
      logger.error('Failed to load playlists: ' + (e instanceof Error ? e.message : String(e)));
      setPlaylists([]);
    }

    // Mark tabs as loaded AFTER all data has been fetched to avoid the sync effect
    // overwriting valid data with empty initial pagination state
    // Use Promise.resolve() to defer to next microtask so sync effect runs first
    void Promise.resolve().then(() => {
      setLoadedTabs(new Set(['artists', 'albumArtists', 'albums', 'playlists']));
    });
  };

  const loadTab = async (tab: LibraryTab): Promise<void> => {
    if (!jellyfinConfig || !userId) return;
    const headers = jellyfinHeaders(jellyfinConfig.apiKey);
    const baseUrl = jellyfinConfig.url.replace(/\/$/, '');

    if (loadedTabs.has(tab)) {
      // Always restore saved scroll (including 0) so the observer doesn't
      // inherit the previous tab's scroll position and fire spurious load-mores
      setTimeout(() => {
        if (contentScrollRef.current) {
          contentScrollRef.current.scrollTop = pagination[tab].scrollPos;
        }
      }, 0);
      return;
    }

    try {
      if (tab === 'artists') {
        const res = await fetch(
          buildUrl(
            baseUrl,
            `/Artists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=0&Fields=AlbumCount,RunTimeTicks,ChildCount`,
          ),
          { headers },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const items: Artist[] = (data.Items ?? []).map(normalizeArtist);
        setArtists(items);
        updateArtistIndex(items);
        const totalCount = data.TotalRecordCount ?? items.length;
        setPagination((prev) => ({
          ...prev,
          artists: {
            items,
            total: totalCount,
            startIndex: items.length,
            hasMore: items.length < totalCount,
            scrollPos: 0,
          },
        }));
      } else if (tab === 'albumArtists') {
        const res = await fetch(
          buildUrl(
            baseUrl,
            `/Artists/AlbumArtists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=0&Fields=AlbumCount,RunTimeTicks,ChildCount`,
          ),
          { headers },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const items: AlbumArtist[] = (data.Items ?? []).map(normalizeAlbumArtist);
        setAlbumArtists(items);
        updateAlbumArtistIndex(items);
        const totalCount = data.TotalRecordCount ?? items.length;
        setPagination((prev) => ({
          ...prev,
          albumArtists: {
            items,
            total: totalCount,
            startIndex: items.length,
            hasMore: items.length < totalCount,
            scrollPos: 0,
          },
        }));
      } else if (tab === 'albums') {
        const res = await fetch(
          buildUrl(
            baseUrl,
            `/Items?IncludeItemTypes=MusicAlbum&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true&Fields=RunTimeTicks,ChildCount&userId=${userId}`,
          ),
          { headers },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const items: Album[] = (data.Items ?? []).map(normalizeAlbum);
        setAlbums(items);
        updateAlbumIndex(items);
        const totalCount = data.TotalRecordCount ?? items.length;
        setPagination((prev) => ({
          ...prev,
          albums: {
            items,
            total: totalCount,
            startIndex: items.length,
            hasMore: items.length < totalCount,
            scrollPos: 0,
          },
        }));
      } else if (tab === 'genres') {
        const res = await fetch(
          buildUrl(
            baseUrl,
            `/MusicGenres?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=0&Fields=LibraryItems`,
          ),
          { headers },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const items: Genre[] = (data.Items ?? []).map(normalizeGenre);
        setGenres(items);
        const totalCount = data.TotalRecordCount ?? items.length;
        setPagination((prev) => ({
          ...prev,
          genres: {
            items,
            total: totalCount,
            startIndex: items.length,
            hasMore: items.length < totalCount,
            scrollPos: 0,
          },
        }));
      } else {
        const res = await fetch(
          buildUrl(
            baseUrl,
            `/Items?IncludeItemTypes=Playlist&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true&Fields=RunTimeTicks,ChildCount&userId=${userId}`,
          ),
          { headers },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const items: Playlist[] = (data.Items ?? []).map(normalizePlaylist);
        setPlaylists(items);
        updatePlaylistIndex(items);
        const totalCount = data.TotalRecordCount ?? items.length;
        setPagination((prev) => ({
          ...prev,
          playlists: {
            items,
            total: totalCount,
            startIndex: items.length,
            hasMore: items.length < totalCount,
            scrollPos: 0,
          },
        }));
      }
      setLoadedTabs((prev) => new Set(prev).add(tab));
    } catch (e) {
      logger.error(`Failed to load ${tab}: ` + (e instanceof Error ? e.message : String(e)));
    }
  };

  const loadMore = useCallback(
    async (type: LibraryTab): Promise<void> => {
      if (!jellyfinConfig || !userId || isLoadingMore) return;
      const currentPagination = pagination[type];
      if (!currentPagination.hasMore) return;

      setIsLoadingMore(true);
      const headers = jellyfinHeaders(jellyfinConfig.apiKey);
      const baseUrl = jellyfinConfig.url.replace(/\/$/, '');
      const startIndex = currentPagination.startIndex;

      try {
        let endpoint = '';
        if (type === 'artists')
          endpoint = `/Artists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=${startIndex}&Fields=AlbumCount,RunTimeTicks,ChildCount`;
        else if (type === 'albumArtists')
          endpoint = `/Artists/AlbumArtists?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=${startIndex}&Fields=AlbumCount,RunTimeTicks,ChildCount`;
        else if (type === 'albums')
          endpoint = `/Items?IncludeItemTypes=MusicAlbum&Limit=${PAGE_SIZE}&StartIndex=${startIndex}&Recursive=true&Fields=RunTimeTicks,ChildCount&userId=${userId}`;
        else if (type === 'genres')
          endpoint = `/MusicGenres?SortBy=Name&Limit=${PAGE_SIZE}&StartIndex=${startIndex}&Fields=LibraryItems`;
        else
          endpoint = `/Items?IncludeItemTypes=Playlist&Limit=${PAGE_SIZE}&StartIndex=${startIndex}&Recursive=true&Fields=RunTimeTicks,ChildCount&userId=${userId}`;

        const res = await fetch(buildUrl(baseUrl, endpoint), { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const rawItems: Array<Record<string, unknown>> = data.Items ?? [];
        const normalized =
          type === 'artists'
            ? rawItems.map(normalizeArtist)
            : type === 'albumArtists'
              ? rawItems.map(normalizeAlbumArtist)
              : type === 'albums'
                ? rawItems.map(normalizeAlbum)
                : type === 'genres'
                  ? rawItems.map(normalizeGenre)
                  : rawItems.map(normalizePlaylist);
        const existingIds = new Set(
          currentPagination.items.map((item) => ('Id' in item ? item.Id : (item as Genre).Name)),
        );
        const uniqueNewItems = normalized.filter((item) => {
          const id = 'Id' in item ? item.Id : (item as Genre).Name;
          return !existingIds.has(id);
        });

        if (type === 'artists') updateArtistIndex(uniqueNewItems as Artist[]);
        else if (type === 'albumArtists') updateAlbumArtistIndex(uniqueNewItems as AlbumArtist[]);
        else if (type === 'albums') updateAlbumIndex(uniqueNewItems as Album[]);
        else if (type === 'genres') {
          // Genres use Name as key, not Id — no index update needed
        } else updatePlaylistIndex(uniqueNewItems as Playlist[]);

        setPagination((prev) => ({
          ...prev,
          [type]: {
            items: [...prev[type].items, ...uniqueNewItems],
            total: data.TotalRecordCount ?? prev[type].total,
            startIndex: startIndex + uniqueNewItems.length,
            hasMore:
              startIndex + uniqueNewItems.length < (data.TotalRecordCount ?? prev[type].total),
            scrollPos: prev[type].scrollPos,
          },
        }));
      } catch (e) {
        logger.error(
          `Failed to load more ${type}: ` + (e instanceof Error ? e.message : String(e)),
        );
        setError(e instanceof Error ? e.message : `Failed to load more ${type}`);
      } finally {
        setIsLoadingMore(false);
      }
    },
    [jellyfinConfig, userId, pagination, isLoadingMore],
  );

  const handleTabChange = (newTab: LibraryTab): void => {
    if (contentScrollRef.current) {
      const currentScroll = contentScrollRef.current.scrollTop;
      setPagination((prev) => ({
        ...prev,
        [activeLibrary]: { ...prev[activeLibrary], scrollPos: currentScroll },
      }));
      // Reset scroll immediately so the intersection observer doesn't see the
      // outgoing tab's scroll position when it re-attaches for the new tab
      contentScrollRef.current.scrollTop = 0;
    }
    // Clear selected genre when leaving genres tab
    if (newTab !== 'genres') {
      setSelectedGenre(null);
    }
    setActiveLibrary(newTab);
  };

  const selectGenre = (genre: Genre | null): void => {
    setSelectedGenre(genre);
    if (genre) {
      setActiveLibrary('genres');
    }
  };

  // Fetch albums filtered by selected genre
  useEffect(() => {
    if (!selectedGenre || !jellyfinConfig || !userId) return;

    const headers = jellyfinHeaders(jellyfinConfig.apiKey);
    const baseUrl = jellyfinConfig.url.replace(/\/$/, '');

    const fetchGenreAlbums = async () => {
      try {
        const res = await fetch(
          buildUrl(
            baseUrl,
            `/Items?IncludeItemTypes=MusicAlbum&Genres=${encodeURIComponent(selectedGenre.Name)}&Limit=${PAGE_SIZE}&StartIndex=0&Recursive=true&Fields=RunTimeTicks,ChildCount&userId=${userId}`,
          ),
          { headers },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const items: Album[] = (data.Items ?? []).map(normalizeAlbum);
        setAlbums(items);
        updateAlbumIndex(items);
        const totalCount = data.TotalRecordCount ?? items.length;
        setPagination((prev) => ({
          ...prev,
          albums: {
            items,
            total: totalCount,
            startIndex: items.length,
            hasMore: items.length < totalCount,
            scrollPos: 0,
          },
        }));
      } catch (e) {
        logger.error(
          `Failed to load genre albums: ${selectedGenre.Name}: ` +
            (e instanceof Error ? e.message : String(e)),
        );
        setError(`Error loading albums for ${selectedGenre.Name}`);
        setAlbums([]);
      }
    };

    void fetchGenreAlbums();
  }, [selectedGenre, jellyfinConfig, userId]);

  // Sync pagination items to state arrays
  useEffect(() => {
    if (loadedTabs.has('artists')) setArtists(pagination.artists.items);
    if (loadedTabs.has('albumArtists')) setAlbumArtists(pagination.albumArtists.items);
    if (loadedTabs.has('albums')) setAlbums(pagination.albums.items);
    if (loadedTabs.has('playlists')) setPlaylists(pagination.playlists.items);
    if (loadedTabs.has('genres') && pagination.genres) setGenres(pagination.genres.items);
  }, [
    loadedTabs,
    pagination.artists.items,
    pagination.albumArtists.items,
    pagination.albums.items,
    pagination.playlists.items,
    pagination.genres?.items,
  ]);

  const uniqueArtists = artists.filter(
    (item, i, self) => i === self.findIndex((t) => t.Id === item.Id),
  );
  const uniqueAlbumArtists = albumArtists.filter(
    (item, i, self) => i === self.findIndex((t) => t.Id === item.Id),
  );
  const uniqueAlbums = albums.filter(
    (item, i, self) => i === self.findIndex((t) => t.Id === item.Id),
  );
  const uniquePlaylists = playlists.filter(
    (item, i, self) => i === self.findIndex((t) => t.Id === item.Id),
  );

  const refreshLibrary = useCallback(async () => {
    if (!jellyfinConfig || !userId) return;
    setLoadedTabs(new Set());
    setArtists([]);
    setAlbumArtists([]);
    setAlbums([]);
    setPlaylists([]);
    setGenres([]);
    setPagination({
      artists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
      albumArtists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
      albums: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
      playlists: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
      genres: { items: [], total: 0, startIndex: 0, hasMore: true, scrollPos: 0 },
    });
    await loadLibrary(jellyfinConfig.url, jellyfinConfig.apiKey, userId);
  }, [jellyfinConfig, userId, loadLibrary]);

  /**
   * Fetches all item IDs for a given tab, loading additional pages if needed.
   * Returns all IDs (including already-loaded ones) after ensuring complete coverage.
   * Accepts explicit pagination state to avoid stale closure issues.
   * Returns partial results if some pages fail, with error info.
   */
  const fetchAllIds = useCallback(
    async (
      type: LibraryTab,
      explicitPagination?: PaginationState[LibraryTab],
    ): Promise<{ ids: string[]; errors: string[] }> => {
      if (!jellyfinConfig || !userId) return { ids: [], errors: [] };
      const headers = jellyfinHeaders(jellyfinConfig.apiKey);
      const baseUrl = jellyfinConfig.url.replace(/\/$/, '');
      const currentPagination = explicitPagination ?? pagination[type];
      const errors: string[] = [];

      // If all items already loaded, return current IDs
      if (!currentPagination.hasMore) {
        // For genres, use Name instead of Id (genres don't have Id)
        return {
          ids: currentPagination.items.map((item) =>
            'Id' in item ? item.Id : (item as Genre).Name,
          ),
          errors: [],
        };
      }

      const allIds = new Set(
        currentPagination.items.map((item) => ('Id' in item ? item.Id : (item as Genre).Name)),
      );
      let startIndex = currentPagination.startIndex;
      let totalCount = currentPagination.total;
      let hasMore: boolean = currentPagination.hasMore;

      // Fetch remaining pages using the maximum allowed page size (1000 items per request).
      // Using remainingItems/3 caused Zeno's paradox: page sizes shrink geometrically
      // and the loop needs O(log n) requests instead of O(ceil(n/1000)).
      while (hasMore) {
        const remainingItems = totalCount - startIndex;
        const pageLimit = Math.min(remainingItems, 1000);

        let endpoint = '';
        if (type === 'artists')
          endpoint = `/Artists?SortBy=Name&Limit=${pageLimit}&StartIndex=${startIndex}&Fields=AlbumCount,RunTimeTicks,ChildCount`;
        else if (type === 'albumArtists')
          endpoint = `/Artists/AlbumArtists?SortBy=Name&Limit=${pageLimit}&StartIndex=${startIndex}&Fields=AlbumCount,RunTimeTicks,ChildCount`;
        else if (type === 'albums')
          endpoint = `/Items?IncludeItemTypes=MusicAlbum&Limit=${pageLimit}&StartIndex=${startIndex}&Recursive=true&Fields=RunTimeTicks,ChildCount&userId=${userId}`;
        else if (type === 'genres')
          endpoint = `/MusicGenres?SortBy=Name&Limit=${pageLimit}&StartIndex=${startIndex}&Fields=LibraryItems`;
        else
          endpoint = `/Items?IncludeItemTypes=Playlist&Limit=${pageLimit}&StartIndex=${startIndex}&Recursive=true&Fields=RunTimeTicks,ChildCount&userId=${userId}`;

        try {
          const res = await fetch(buildUrl(baseUrl, endpoint), { headers });
          if (!res.ok) {
            errors.push(`Failed to load page at index ${startIndex}: HTTP ${res.status}`);
            // Stop fetching but return partial results
            break;
          }
          const data = await res.json();
          const rawItems: Array<Record<string, unknown>> = data.Items ?? [];
          const normalized =
            type === 'artists'
              ? rawItems.map(normalizeArtist)
              : type === 'albumArtists'
                ? rawItems.map(normalizeAlbumArtist)
                : type === 'albums'
                  ? rawItems.map(normalizeAlbum)
                  : type === 'genres'
                    ? rawItems.map(normalizeGenre)
                  : rawItems.map(normalizePlaylist);
          // Guard: if the server returns no items, stop — advancing startIndex by 0
          // would cause an infinite loop when totalCount > actual available items.
          if (normalized.length === 0) break;
          // Genres use Name as key, all other types use Id
          normalized.forEach((item) => {
            const id = 'Id' in item ? item.Id : (item as Genre).Name;
            allIds.add(id);
          });
          startIndex += normalized.length;
          // Never chase an upward-oscillating TotalRecordCount: only update totalCount
          // when the server reports fewer items than our current expectation.
          const serverTotal = data.TotalRecordCount as number | undefined;
          if (serverTotal !== undefined && serverTotal < totalCount) {
            totalCount = serverTotal;
          }
          hasMore = startIndex < totalCount;

          // Update pagination state to track progress (only if not using explicit pagination)
          if (!explicitPagination) {
            setPagination((prev) => ({
              ...prev,
              [type]: {
                ...prev[type],
                items: [...prev[type].items, ...normalized],
                startIndex,
                hasMore,
              },
            }));
          }
        } catch (e) {
          errors.push(
            `Failed to load page at index ${startIndex}: ${e instanceof Error ? e.message : String(e)}`,
          );
          // Stop fetching but return partial results
          break;
        }

        // Break when we've fetched all items (startIndex >= totalCount)
        // A partial page doesn't mean end of results — we must check against totalCount
        if (startIndex >= totalCount) break;
      }

      return { ids: [...allIds], errors };
    },
    [jellyfinConfig, userId, pagination],
  );

  /**
   * Selects all items for a given tab, fetching remaining pages if needed.
   * Calls the provided callback with all selected IDs once complete.
   * Shows loading state when fetching additional pages.
   * Cancels if the user switches tabs.
   */
  const selectAllWithCompleteSet = useCallback(
    async (
      type: LibraryTab,
      onSelectAllIds: (ids: string[]) => void,
      onError?: (errors: string[], selectedCount: number) => void,
    ): Promise<{ cancelled: boolean }> => {
      if (!jellyfinConfig || !userId) return { cancelled: false };

      const currentTab = activeLibrary;
      try {
        const result = await fetchAllIds(type);
        // Check if tab changed during fetch (cancellation)
        if (currentTab !== activeLibrary) {
          return { cancelled: true };
        }
        onSelectAllIds(result.ids);
        if (result.errors.length > 0) {
          onError?.(result.errors, result.ids.length);
        }
        return { cancelled: false };
      } catch {
        return { cancelled: true };
      }
    },
    [fetchAllIds, activeLibrary],
  );

  return {
    artists: uniqueArtists,
    albumArtists: uniqueAlbumArtists,
    albums: uniqueAlbums,
    playlists: uniquePlaylists,
    genres,
    selectedGenre,
    stats,
    activeLibrary,
    pagination,
    isLoadingMore,
    loadedTabs,
    error,
    setError,
    itemTypeIndex,
    itemTypeIndexRef,
    contentScrollRef,
    loadLibrary,
    loadStats,
    loadTab,
    loadMore,
    handleTabChange,
    selectGenre,
    refreshLibrary,
    fetchAllIds,
    selectAllWithCompleteSet,
  };
}
