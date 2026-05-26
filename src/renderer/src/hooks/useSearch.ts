import { useState, useEffect } from 'react';
import type { JellyfinConfig, Artist, Album, Playlist } from '../appTypes';
import {
  jellyfinHeaders,
  normalizeArtist,
  normalizeAlbum,
  normalizePlaylist,
} from '../utils/jellyfin';
import { logger } from '../utils/logger';

interface SearchResults {
  artists: Artist[];
  albums: Album[];
  playlists: Playlist[];
}

export function useSearch(jellyfinConfig: JellyfinConfig | null, userId: string | null) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (!jellyfinConfig || !userId) return;
    if (!searchQuery || searchQuery.length < 2) {
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const headers = jellyfinHeaders(jellyfinConfig.apiKey);
        const base = jellyfinConfig.url.replace(/\/$/, '');
        const q = encodeURIComponent(searchQuery);
        const [artistsRes, albumsRes, playlistsRes] = await Promise.all([
          fetch(
            `${base}/Artists?SearchTerm=${q}&Limit=20&Fields=AlbumCount,ChildCount,RunTimeTicks`,
            { headers },
          ),
          fetch(
            `${base}/Items?SearchTerm=${q}&IncludeItemTypes=MusicAlbum&Recursive=true&Limit=20&Fields=RunTimeTicks,ChildCount`,
            { headers },
          ),
          fetch(
            `${base}/Items?SearchTerm=${q}&IncludeItemTypes=Playlist&Recursive=true&Limit=20&Fields=RunTimeTicks`,
            {
              headers,
            },
          ),
        ]);
        const [artistsData, albumsData, playlistsData] = await Promise.all([
          artistsRes.ok ? artistsRes.json() : { Items: [] },
          albumsRes.ok ? albumsRes.json() : { Items: [] },
          playlistsRes.ok ? playlistsRes.json() : { Items: [] },
        ]);
        setSearchError(null);
        setSearchResults({
          artists: (artistsData.Items ?? []).map(normalizeArtist),
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
  }, [searchQuery, jellyfinConfig, userId]);

  return { searchQuery, setSearchQuery, searchResults, isSearching, searchError };
}
