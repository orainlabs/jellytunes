// @vitest-environment jsdom
/**
 * Tests for useTabSearch - per-tab search state management.
 * Each tab (artists, albums, playlists) maintains its own search query
 * that persists during the session.
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { UseTabSearchProvider, useTabSearch } from './useTabSearch';

const mockConfig = {
  url: 'https://jellyfin.example.com',
  apiKey: 'test-api-key',
};

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <UseTabSearchProvider jellyfinConfig={mockConfig} userId="user-123">
    {children}
  </UseTabSearchProvider>
);

describe('useTabSearch', () => {
  describe('initial state', () => {
    it('starts with empty search query for all tabs', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });
      expect(result.current.searchQueries.artists).toBe('');
      expect(result.current.searchQueries.albums).toBe('');
      expect(result.current.searchQueries.playlists).toBe('');
    });

    it('provides setSearchQuery function', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });
      expect(typeof result.current.setSearchQuery).toBe('function');
    });

    it('has null initial searchResults', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });
      expect(result.current.searchResults).toBeNull();
    });

    it('has no initial search error', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });
      expect(result.current.searchError).toBeNull();
    });

    it('has no initial searching state', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });
      expect(result.current.isSearching).toBe(false);
    });
  });

  describe('per-tab search query updates', () => {
    it('updates only the artists tab when setSearchQuery called for artists', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });

      act(() => {
        result.current.setSearchQuery('beatles', 'artists');
      });

      expect(result.current.searchQueries.artists).toBe('beatles');
      expect(result.current.searchQueries.albums).toBe('');
      expect(result.current.searchQueries.playlists).toBe('');
    });

    it('updates only the albums tab when setSearchQuery called for albums', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });

      act(() => {
        result.current.setSearchQuery('dark side', 'albums');
      });

      expect(result.current.searchQueries.artists).toBe('');
      expect(result.current.searchQueries.albums).toBe('dark side');
      expect(result.current.searchQueries.playlists).toBe('');
    });

    it('updates only the playlists tab when setSearchQuery called for playlists', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });

      act(() => {
        result.current.setSearchQuery('workout', 'playlists');
      });

      expect(result.current.searchQueries.artists).toBe('');
      expect(result.current.searchQueries.albums).toBe('');
      expect(result.current.searchQueries.playlists).toBe('workout');
    });

    it('maintains independent state across multiple tab updates', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });

      act(() => {
        result.current.setSearchQuery('beatles', 'artists');
      });
      act(() => {
        result.current.setSearchQuery('pink floyd', 'albums');
      });
      act(() => {
        result.current.setSearchQuery('jazz', 'playlists');
      });

      expect(result.current.searchQueries.artists).toBe('beatles');
      expect(result.current.searchQueries.albums).toBe('pink floyd');
      expect(result.current.searchQueries.playlists).toBe('jazz');
    });
  });

  describe('clearSearch behavior', () => {
    it('clears only the specified tab search', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });

      // Set search on all tabs
      act(() => {
        result.current.setSearchQuery('beatles', 'artists');
      });
      act(() => {
        result.current.setSearchQuery('pink floyd', 'albums');
      });
      act(() => {
        result.current.setSearchQuery('jazz', 'playlists');
      });

      // Clear only artists
      act(() => {
        result.current.setSearchQuery('', 'artists');
      });

      expect(result.current.searchQueries.artists).toBe('');
      expect(result.current.searchQueries.albums).toBe('pink floyd');
      expect(result.current.searchQueries.playlists).toBe('jazz');
    });
  });

  describe('search execution', () => {
    it('does not fetch when query has less than 2 characters', async () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });
      const fetchSpy = vi.spyOn(global, 'fetch');

      await act(async () => {
        result.current.setSearchQuery('a', 'artists');
      });

      // Small delay to allow any potential debounce
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('clears results when query is cleared', async () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });

      // Set search
      act(() => {
        result.current.setSearchQuery('beatles', 'artists');
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // Clear search
      act(() => {
        result.current.setSearchQuery('', 'artists');
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(result.current.searchResults).toBeNull();
    });
  });

  describe('tab switching preserves search state', () => {
    it('preserves search state when switching tabs', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });

      // Set search on artists tab
      act(() => {
        result.current.setSearchQuery('beatles', 'artists');
      });
      act(() => {
        result.current.setSearchQuery('dark side', 'albums');
      });

      // Switch between tabs - state should be preserved
      act(() => {
        result.current.setActiveTab('playlists');
      });
      act(() => {
        result.current.setActiveTab('artists');
      });
      act(() => {
        result.current.setActiveTab('albums');
      });

      expect(result.current.searchQueries.artists).toBe('beatles');
      expect(result.current.searchQueries.albums).toBe('dark side');
    });
  });

  describe('setActiveTab', () => {
    it('updates activeTab state', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });

      expect(result.current.activeTab).toBe('artists');

      act(() => {
        result.current.setActiveTab('albums');
      });

      expect(result.current.activeTab).toBe('albums');
    });

    it('allows switching to playlists', () => {
      const { result } = renderHook(() => useTabSearch(), { wrapper });

      act(() => {
        result.current.setActiveTab('playlists');
      });

      expect(result.current.activeTab).toBe('playlists');
    });
  });
});
