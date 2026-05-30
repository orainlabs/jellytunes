import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from 'react';
import type { LibraryTab } from '../appTypes';
import {
  jellyfinHeaders,
  normalizeArtist,
  normalizeAlbumArtist,
  normalizeAlbum,
  normalizePlaylist,
} from '../utils/jellyfin';
import { logger } from '../utils/logger';

interface SearchResults {
  artists: Array<{ Id: string; Name: string }>;
  albumArtists: Array<{ Id: string; Name: string }>;
  albums: Array<{ Id: string; Name: string }>;
  playlists: Array<{ Id: string; Name: string }>;
}

interface SearchQueries {
  artists: string;
  albumArtists: string;
  albums: string;
  playlists: string;
}

interface JellyfinConfig {
  url: string;
  apiKey: string;
}

interface TabSearchContextValue {
  searchQueries: SearchQueries;
  searchResults: SearchResults | null;
  isSearching: boolean;
  searchError: string | null;
  setSearchQuery: (query: string, tab: LibraryTab) => void;
  setActiveTab: (tab: LibraryTab) => void;
  activeTab: LibraryTab;
}

const TabSearchContext = createContext<TabSearchContextValue | null>(null);

interface UseTabSearchProviderProps {
  children: ReactNode;
  jellyfinConfig: JellyfinConfig | null;
  userId: string | null;
}

export function UseTabSearchProvider({
  children,
  jellyfinConfig,
  userId,
}: UseTabSearchProviderProps) {
  const [searchQueries, setSearchQueriesState] = useState<SearchQueries>({
    artists: '',
    albumArtists: '',
    albums: '',
    playlists: '',
  });
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<LibraryTab>('artists');

  const setSearchQuery = useCallback((query: string, tab: LibraryTab) => {
    setSearchQueriesState((prev) => ({
      ...prev,
      [tab]: query,
    }));
  }, []);

  // Search effect - runs when activeTab's search query changes
  useEffect(() => {
    if (!jellyfinConfig || !userId) return;
    // Genres tab doesn't support search
    if (activeTab === 'genres') {
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    const activeQuery = searchQueries[activeTab];
    if (!activeQuery || activeQuery.length < 2) {
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const headers = jellyfinHeaders(jellyfinConfig.apiKey);
        const base = jellyfinConfig.url.replace(/\/$/, '');
        const q = encodeURIComponent(activeQuery);
        // Fetch search results for all tabs in parallel
        const [artistsRes, albumArtistsRes, albumsRes, playlistsRes] = await Promise.all([
          fetch(
            `${base}/Artists?SearchTerm=${q}&Limit=20&Fields=AlbumCount,ChildCount,RunTimeTicks`,
            { headers },
          ),
          fetch(
            `${base}/Artists/AlbumArtists?SearchTerm=${q}&Limit=20&Fields=AlbumCount,ChildCount,RunTimeTicks`,
            { headers },
          ),
          fetch(
            `${base}/Items?SearchTerm=${q}&IncludeItemTypes=MusicAlbum&Recursive=true&Limit=20&Fields=RunTimeTicks`,
            { headers },
          ),
          fetch(
            `${base}/Items?SearchTerm=${q}&IncludeItemTypes=Playlist&Recursive=true&Limit=20&Fields=RunTimeTicks`,
            { headers },
          ),
        ]);
        const [artistsData, albumArtistsData, albumsData, playlistsData] = await Promise.all([
          artistsRes.ok ? artistsRes.json() : { Items: [] },
          albumArtistsRes.ok ? albumArtistsRes.json() : { Items: [] },
          albumsRes.ok ? albumsRes.json() : { Items: [] },
          playlistsRes.ok ? playlistsRes.json() : { Items: [] },
        ]);
        setSearchError(null);
        setSearchResults({
          artists: (artistsData.Items ?? []).map(normalizeArtist),
          albumArtists: (albumArtistsData.Items ?? []).map(normalizeAlbumArtist),
          albums: (albumsData.Items ?? []).map(normalizeAlbum),
          playlists: (playlistsData.Items ?? []).map(normalizePlaylist),
        });
      } catch (e) {
        logger.error('Search error: ' + (e instanceof Error ? e.message : String(e)));
        setSearchResults(null);
        setSearchError(e instanceof Error ? e.message : 'Search failed. Check your connection.');
      } finally {
        setIsSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [searchQueries, activeTab, jellyfinConfig, userId]);

  const value: TabSearchContextValue = {
    searchQueries,
    searchResults,
    isSearching,
    searchError,
    setSearchQuery,
    setActiveTab,
    activeTab,
  };

  return <TabSearchContext.Provider value={value}>{children}</TabSearchContext.Provider>;
}

export function useTabSearch(): TabSearchContextValue {
  const context = useContext(TabSearchContext);
  if (!context) {
    throw new Error('useTabSearch must be used within UseTabSearchProvider');
  }
  return context;
}
