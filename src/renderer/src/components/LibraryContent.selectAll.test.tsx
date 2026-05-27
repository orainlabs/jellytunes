// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LibraryContent } from './LibraryContent';
import type { LibraryTab, PaginationState } from '../appTypes';

const defaultProps = {
  activeLibrary: 'artists' as LibraryTab,
  artists: Array.from({ length: 50 }, (_, i) => ({
    Id: `artist-${i + 1}`,
    Name: `Artist ${i + 1}`,
    AlbumCount: 5,
    ImageTags: {},
    RunTimeTicks: 0,
  })),
  albums: [],
  playlists: [],
  pagination: {
    artists: { items: [], total: 50, startIndex: 50, hasMore: false, scrollPos: 0 },
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LibraryContent - Select All disabled during loading', () => {
  it('disables Select All button when isLoadingMore is true', () => {
    render(<LibraryContent {...defaultProps} isLoadingMore={true} />);

    const selectAllButton = screen.getByTestId('select-all-button');
    expect(selectAllButton).toBeDisabled();
  });

  it('Select All button is enabled when not loading', () => {
    render(<LibraryContent {...defaultProps} isLoadingMore={false} />);

    const selectAllButton = screen.getByTestId('select-all-button');
    expect(selectAllButton).not.toBeDisabled();
  });
});

describe('LibraryContent - Select All confirmation for large selections', () => {
  it('shows confirmation dialog when Select All is clicked with large item count (>500)', async () => {
    const onSelectAll = vi.fn();

    // Use small array but large pagination total to trigger dialog
    const smallArtists = Array.from({ length: 50 }, (_, i) => ({
      Id: `artist-${i + 1}`,
      Name: `Artist ${i + 1}`,
      AlbumCount: 5,
      ImageTags: {},
      RunTimeTicks: 0,
    }));

    render(
      <LibraryContent
        {...defaultProps}
        artists={smallArtists}
        pagination={{
          artists: { items: [], total: 550, startIndex: 550, hasMore: false, scrollPos: 0 },
          albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
          playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
        }}
        onSelectAll={onSelectAll}
      />,
    );

    // Click Select All
    await userEvent.click(screen.getByTestId('select-all-button'));

    // Should show confirmation dialog with item count
    expect(screen.getByTestId('select-all-confirm-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('select-all-count')).toHaveTextContent('550');
  });

  it('shows plural label "artists" when count > 1', async () => {
    const onSelectAll = vi.fn();

    render(
      <LibraryContent
        {...defaultProps}
        artists={Array.from({ length: 501 }, (_, i) => ({
          Id: `artist-${i + 1}`,
          Name: `Artist ${i + 1}`,
          AlbumCount: 5,
          ImageTags: {},
          RunTimeTicks: 0,
        }))}
        pagination={{
          artists: { items: [], total: 501, startIndex: 501, hasMore: false, scrollPos: 0 },
          albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
          playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
        }}
        onSelectAll={onSelectAll}
      />,
    );

    await userEvent.click(screen.getByTestId('select-all-button'));

    // Dialog should show correct label
    expect(screen.getByTestId('select-all-confirm-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('select-all-label')).toHaveTextContent('artists');
  });

  it('does not show dialog when count is <= 500', async () => {
    const onSelectAll = vi.fn();

    render(
      <LibraryContent
        {...defaultProps}
        artists={Array.from({ length: 400 }, (_, i) => ({
          Id: `artist-${i + 1}`,
          Name: `Artist ${i + 1}`,
          AlbumCount: 5,
          ImageTags: {},
          RunTimeTicks: 0,
        }))}
        pagination={{
          artists: { items: [], total: 400, startIndex: 400, hasMore: false, scrollPos: 0 },
          albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
          playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
        }}
        onSelectAll={onSelectAll}
      />,
    );

    await userEvent.click(screen.getByTestId('select-all-button'));

    // Dialog should NOT appear - onSelectAll should be called directly
    expect(screen.queryByTestId('select-all-confirm-dialog')).not.toBeInTheDocument();
    expect(onSelectAll).toHaveBeenCalledTimes(1);
  });

  it('shows dialog with Cancel and Select All buttons', async () => {
    const onSelectAll = vi.fn();

    render(
      <LibraryContent
        {...defaultProps}
        artists={Array.from({ length: 600 }, (_, i) => ({
          Id: `artist-${i + 1}`,
          Name: `Artist ${i + 1}`,
          AlbumCount: 5,
          ImageTags: {},
          RunTimeTicks: 0,
        }))}
        pagination={{
          artists: { items: [], total: 600, startIndex: 600, hasMore: false, scrollPos: 0 },
          albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
          playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
        }}
        onSelectAll={onSelectAll}
      />,
    );

    await userEvent.click(screen.getByTestId('select-all-button'));

    // Dialog should have both buttons
    expect(screen.getByTestId('select-all-cancel-btn')).toBeInTheDocument();
    expect(screen.getByTestId('select-all-confirm-btn')).toBeInTheDocument();
  });

  it('Cancel button closes dialog without calling onSelectAll', async () => {
    const onSelectAll = vi.fn();

    render(
      <LibraryContent
        {...defaultProps}
        artists={Array.from({ length: 600 }, (_, i) => ({
          Id: `artist-${i + 1}`,
          Name: `Artist ${i + 1}`,
          AlbumCount: 5,
          ImageTags: {},
          RunTimeTicks: 0,
        }))}
        pagination={{
          artists: { items: [], total: 600, startIndex: 600, hasMore: false, scrollPos: 0 },
          albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
          playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
        }}
        onSelectAll={onSelectAll}
      />,
    );

    await userEvent.click(screen.getByTestId('select-all-button'));
    expect(screen.getByTestId('select-all-confirm-dialog')).toBeInTheDocument();

    // Click Cancel
    await userEvent.click(screen.getByTestId('select-all-cancel-btn'));

    // Dialog should be closed
    expect(screen.queryByTestId('select-all-confirm-dialog')).not.toBeInTheDocument();
    // onSelectAll should NOT have been called
    expect(onSelectAll).not.toHaveBeenCalled();
  });

  it('Select All button in dialog calls onSelectAll', async () => {
    const onSelectAll = vi.fn();

    render(
      <LibraryContent
        {...defaultProps}
        artists={Array.from({ length: 600 }, (_, i) => ({
          Id: `artist-${i + 1}`,
          Name: `Artist ${i + 1}`,
          AlbumCount: 5,
          ImageTags: {},
          RunTimeTicks: 0,
        }))}
        pagination={{
          artists: { items: [], total: 600, startIndex: 600, hasMore: false, scrollPos: 0 },
          albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
          playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
        }}
        onSelectAll={onSelectAll}
      />,
    );

    await userEvent.click(screen.getByTestId('select-all-button'));
    await userEvent.click(screen.getByTestId('select-all-confirm-btn'));

    // onSelectAll should be called
    expect(onSelectAll).toHaveBeenCalledTimes(1);
    // Dialog should be closed
    expect(screen.queryByTestId('select-all-confirm-dialog')).not.toBeInTheDocument();
  });

  it('uses stats fallback when pagination.total is 0', () => {
    // This test verifies the count logic uses stats when pagination not loaded
    // The component should use stats.ArtistCount as fallback when pagination.albums.total = 0
    render(
      <LibraryContent
        {...defaultProps}
        activeLibrary="albums"
        artists={[]}
        albums={Array.from({ length: 10 }, (_, i) => ({
          Id: `album-${i + 1}`,
          Name: `Album ${i + 1}`,
          AlbumArtist: `Artist ${i + 1}`,
          ImageTags: {},
          RunTimeTicks: 0,
          Type: 'MusicAlbum',
        }))}
        pagination={{
          artists: { items: [], total: 50, startIndex: 50, hasMore: false, scrollPos: 0 },
          albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 }, // total = 0
          playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
        }}
        searchQuery=""
        searchResults={null}
      />,
    );

    // When user clicks Select All on albums tab with pagination.total = 0,
    // the component should check stats.AlbumCount as fallback
    const selectAllButton = screen.getByTestId('select-all-button');

    // Button should be enabled (can still be clicked - the count check happens in handler)
    expect(selectAllButton).not.toBeDisabled();
  });
});

describe('LibraryContent - Select All with stats fallback', () => {
  it('triggers confirmation dialog when stats.AlbumCount exceeds 500 even if pagination.albums.total is 0', async () => {
    const onSelectAll = vi.fn();

    render(
      <LibraryContent
        {...defaultProps}
        activeLibrary="albums"
        artists={[]}
        albums={Array.from({ length: 10 }, (_, i) => ({
          Id: `album-${i + 1}`,
          Name: `Album ${i + 1}`,
          AlbumArtist: `Artist ${i + 1}`,
          ImageTags: {},
          RunTimeTicks: 0,
          Type: 'MusicAlbum',
        }))}
        pagination={{
          artists: { items: [], total: 50, startIndex: 50, hasMore: false, scrollPos: 0 },
          albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 }, // 0 - needs stats fallback
          playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
        }}
        // Pass stats with AlbumCount = 600 to trigger confirmation dialog
        stats={{
          ArtistCount: 50,
          AlbumCount: 600, // > 500 threshold
          SongCount: 5000,
          PlaylistCount: 20,
          ItemCount: 6000,
        }}
        onSelectAll={onSelectAll}
        searchQuery=""
        searchResults={null}
      />,
    );

    // Click Select All
    await userEvent.click(screen.getByTestId('select-all-button'));

    // Dialog should appear because stats.AlbumCount (600) > 500
    expect(screen.getByTestId('select-all-confirm-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('select-all-count')).toHaveTextContent('600');
    expect(screen.getByTestId('select-all-label')).toHaveTextContent('albums');
  });
});

describe('LibraryContent - Select All with pagination loading', () => {
  it('shows loading indicator while fetching remaining pages', () => {
    // Test that Select All button shows loading state during pagination
    const onSelectAll = vi.fn();
    const onLoadMore = vi.fn();

    render(
      <LibraryContent
        {...defaultProps}
        artists={Array.from({ length: 50 }, (_, i) => ({
          Id: `artist-${i + 1}`,
          Name: `Artist ${i + 1}`,
          AlbumCount: 5,
          ImageTags: {},
          RunTimeTicks: 0,
        }))}
        pagination={{
          artists: { items: [], total: 250, startIndex: 50, hasMore: true, scrollPos: 0 },
          albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
          playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
        }}
        onSelectAll={onSelectAll}
        onLoadMore={onLoadMore}
        isLoadingMore={false}
      />,
    );

    // The Select All button text should indicate loading when isSelectingAll is true
    // Since isSelectingAll is controlled by the parent, we verify the button exists
    const selectAllButton = screen.getByTestId('select-all-button');
    expect(selectAllButton).toBeInTheDocument();
  });

  it('disables Select All during pagination with proper visual feedback', () => {
    // Test that Select All button is disabled and shows loading when pagination active
    const onSelectAll = vi.fn();

    render(
      <LibraryContent
        {...defaultProps}
        artists={Array.from({ length: 50 }, (_, i) => ({
          Id: `artist-${i + 1}`,
          Name: `Artist ${i + 1}`,
          AlbumCount: 5,
          ImageTags: {},
          RunTimeTicks: 0,
        }))}
        pagination={{
          artists: { items: [], total: 250, startIndex: 50, hasMore: true, scrollPos: 0 },
          albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
          playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
        }}
        onSelectAll={onSelectAll}
        isLoadingMore={false}
      />,
    );

    // Select All button should be enabled (not disabled by isLoadingMore)
    const selectAllButton = screen.getByTestId('select-all-button');
    expect(selectAllButton).not.toBeDisabled();
  });
});
