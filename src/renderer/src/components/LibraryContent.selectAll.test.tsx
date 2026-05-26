// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LibraryContent } from './LibraryContent';
import type { LibraryTab, PaginationState } from '../appTypes';

const defaultProps = {
  activeLibrary: 'artists' as LibraryTab,
  artists: [
    { Id: 'artist-1', Name: 'Artist 1', AlbumCount: 5, ImageTags: {}, RunTimeTicks: 0 },
    { Id: 'artist-2', Name: 'Artist 2', AlbumCount: 3, ImageTags: {}, RunTimeTicks: 0 },
  ],
  albums: [],
  playlists: [],
  pagination: {
    artists: { items: [], total: 2, startIndex: 2, hasMore: false, scrollPos: 0 },
    albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
    playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
  } as PaginationState,
  selectedTracks: new Set<string>(),
  previouslySyncedItems: new Set<string>(),
  outOfSyncItems: new Set<string>(),
  isLoadingMore: false,
  error: null,
  onToggle: vi.fn(),
  onSelectAll: vi.fn(),
  onClearSelection: vi.fn(),
  onClearError: vi.fn(),
  onLoadMore: vi.fn(),
  selectionSummary: 'None selected',
  contentScrollRef: { current: null } as React.RefObject<HTMLDivElement>,
  hasActiveDevice: true,
  searchQuery: '',
  onSearchChange: vi.fn(),
  onClearSearch: vi.fn(),
  searchResults: null,
  isSearching: false,
  searchError: null,
};

describe('LibraryContent - Select All/Clear hidden during active search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides Select All button during active search', () => {
    render(
      <LibraryContent
        {...defaultProps}
        searchQuery="beatles"
        searchResults={{
          artists: [
            {
              Id: 'search-artist-1',
              Name: 'The Beatles',
              AlbumCount: 13,
              ImageTags: {},
              RunTimeTicks: 0,
            },
          ],
          albums: [],
          playlists: [],
        }}
        isSearching={false}
      />,
    );

    expect(screen.queryByTestId('select-all-button')).not.toBeInTheDocument();
  });

  it('hides Clear button during active search even when items are selected', () => {
    render(
      <LibraryContent
        {...defaultProps}
        selectedTracks={new Set(['search-artist-1'])}
        searchQuery="beatles"
        searchResults={{
          artists: [
            {
              Id: 'search-artist-1',
              Name: 'The Beatles',
              AlbumCount: 13,
              ImageTags: {},
              RunTimeTicks: 0,
            },
          ],
          albums: [],
          playlists: [],
        }}
        isSearching={false}
      />,
    );

    expect(screen.queryByTestId('select-all-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('clear-selection-button')).not.toBeInTheDocument();
  });

  it('shows both Select All and Clear when no search active and items selected', () => {
    render(
      <LibraryContent
        {...defaultProps}
        selectedTracks={new Set(['artist-1'])}
        searchQuery=""
        searchResults={null}
      />,
    );

    expect(screen.getByTestId('select-all-button')).toBeVisible();
    expect(screen.getByTestId('clear-selection-button')).toBeVisible();
  });

  it('shows Select All only when no search active and no items selected', () => {
    render(<LibraryContent {...defaultProps} searchQuery="" searchResults={null} />);

    expect(screen.getByTestId('select-all-button')).toBeVisible();
    expect(screen.queryByTestId('clear-selection-button')).not.toBeInTheDocument();
  });

  it('calls onSelectAll when Select All clicked (no search)', async () => {
    const onSelectAll = vi.fn();
    render(<LibraryContent {...defaultProps} searchQuery="" onSelectAll={onSelectAll} />);

    await userEvent.click(screen.getByTestId('select-all-button'));

    expect(onSelectAll).toHaveBeenCalledTimes(1);
  });

  it('calls onClearSelection when Clear clicked (no search)', async () => {
    const onClearSelection = vi.fn();
    render(
      <LibraryContent
        {...defaultProps}
        searchQuery=""
        selectedTracks={new Set(['artist-1'])}
        onClearSelection={onClearSelection}
      />,
    );

    await userEvent.click(screen.getByTestId('clear-selection-button'));

    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });
});
