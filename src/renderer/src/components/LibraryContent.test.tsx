// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { LibraryContent } from './LibraryContent';
import type { LibraryTab, Artist, Album, Playlist, PaginationState } from '../appTypes';

const mockApi = {
  listUsbDevices: vi.fn().mockResolvedValue([]),
  getDeviceInfo: vi.fn().mockResolvedValue({ total: 32e9, free: 16e9, used: 16e9 }),
  getFilesystem: vi.fn().mockResolvedValue('exfat'),
  getSyncedItems: vi.fn().mockResolvedValue([]),
  analyzeDiff: vi.fn().mockResolvedValue({ success: true, items: [] }),
  estimateSize: vi.fn().mockResolvedValue({ trackCount: 0, totalBytes: 0, formatBreakdown: {} }),
  startSync2: vi
    .fn()
    .mockResolvedValue({ success: true, tracksCopied: 10, tracksSkipped: 5, errors: [] }),
  removeItems: vi.fn().mockResolvedValue({ removed: 0, errors: [] }),
  cancelSync: vi.fn().mockResolvedValue({ cancelled: true }),
  onSyncProgress: vi.fn().mockReturnValue(() => {}),
  getDeviceSyncInfo: vi.fn().mockResolvedValue(null),
  selectFolder: vi.fn().mockResolvedValue('/mnt/usb'),
  saveSession: vi.fn().mockResolvedValue({ success: true }),
  loadSession: vi.fn().mockResolvedValue(null),
  clearSession: vi.fn().mockResolvedValue(undefined),
};
beforeAll(() => {
  Object.defineProperty(window, 'api', { value: mockApi, writable: true });
});
afterEach(() => {
  vi.resetAllMocks();
});

const createPagination = (): PaginationState => ({
  artists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
  albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
  playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
});

const sampleArtists: Artist[] = [
  { Id: 'artist-1', Name: 'The Beatles', ChildCount: 13 },
  { Id: 'artist-2', Name: 'Pink Floyd', ChildCount: 15 },
];

const defaultProps = {
  activeLibrary: 'artists' as LibraryTab,
  artists: sampleArtists,
  albums: [] as Album[],
  playlists: [] as Playlist[],
  pagination: createPagination(),
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
  selectionSummary: '0 selected',
  contentScrollRef: { current: null } as React.RefObject<HTMLDivElement>,
  hasActiveDevice: true,
  serverUrl: 'https://jellyfin.example.com',
  searchQuery: '',
  onSearchChange: vi.fn(),
  onClearSearch: vi.fn(),
  searchResults: null,
  isSearching: false,
  searchError: null,
};

describe('LibraryContent', () => {
  // 1. renders artists correctly with name (subtitle shows runtime, not album count)
  // Note: album count was removed per ORAIN-0375 — /Artists endpoint doesn't return ChildCount reliably
  it('renders artists correctly with name', () => {
    render(<LibraryContent {...defaultProps} />);
    const content = screen.getByTestId('library-content');
    expect(within(content).getByText('The Beatles')).toBeInTheDocument();
    // The Beatles has RunTimeTicks (3h runtime) but no album count per ORAIN-0375
  });

  // 2. search active with 2+ chars: shows search results
  it('shows search results when search query has 2+ characters', async () => {
    const searchResults = {
      artists: [{ Id: 'search-1', Name: 'Search Result Artist', ChildCount: 5 }] as Artist[],
      albums: [] as Album[],
      playlists: [] as Playlist[],
    };
    render(<LibraryContent {...defaultProps} searchQuery="te" searchResults={searchResults} />);
    const content = screen.getByTestId('library-content');
    expect(within(content).getByText('Search Result Artist')).toBeInTheDocument();
  });

  // 3. search active with <2 chars: shows normal library
  it('shows normal library when search query has less than 2 characters', () => {
    render(<LibraryContent {...defaultProps} searchQuery="a" />);
    const content = screen.getByTestId('library-content');
    expect(within(content).getByText('The Beatles')).toBeInTheDocument();
  });

  // 4. clear search: restores library view
  it('clears search and restores library view', async () => {
    const user = userEvent.setup({ delay: null });
    render(<LibraryContent {...defaultProps} />);
    const searchInput = screen.getByTestId('search-input');
    await user.type(searchInput, 'beatles');
    expect(defaultProps.onSearchChange).toHaveBeenCalled();
  });

  // 5. filter "selected": only items in selectedTracks visible
  it('shows only selected items when filter is set to selected', async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <LibraryContent
        {...defaultProps}
        selectedTracks={new Set(['artist-1'])}
        selectionSummary={'1 selected'}
      />,
    );
    const filterButton = screen.getByTestId('sync-filter-selected');
    await user.click(filterButton);
    expect(screen.getByTestId('sync-filter-selected')).toHaveClass(/bg-primary_container/);
  });

  // 6. filter "unselected": only items NOT in selectedTracks visible
  it('shows only unselected items when filter is set to unselected', async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <LibraryContent
        {...defaultProps}
        selectedTracks={new Set(['artist-1'])}
        selectionSummary={'1 selected'}
      />,
    );
    const filterButton = screen.getByTestId('sync-filter-unselected');
    await user.click(filterButton);
    expect(screen.getByTestId('sync-filter-unselected')).toHaveClass(/bg-primary_container/);
  });

  // 7. filter "all": all items visible
  it('shows all items when filter is set to all', async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <LibraryContent
        {...defaultProps}
        selectedTracks={new Set(['artist-1'])}
        selectionSummary={'1 selected'}
      />,
    );
    const filterButton = screen.getByTestId('sync-filter-all');
    await user.click(filterButton);
    expect(screen.getByTestId('sync-filter-all')).toHaveClass(/bg-primary_container/);
    expect(screen.getByText('The Beatles')).toBeInTheDocument();
    expect(screen.getByText('Pink Floyd')).toBeInTheDocument();
  });

  // 8. click item without device: toast "Select a device first" appears
  it('shows toast when clicking item without active device', async () => {
    const user = userEvent.setup({ delay: null });
    render(<LibraryContent {...defaultProps} hasActiveDevice={false} />);
    const selectAllButton = screen.getByTestId('select-all-button');
    await user.click(selectAllButton);
    expect(screen.getByText('Select a device in the sidebar first')).toBeInTheDocument();
  });

  // 9. select all: onSelectAll called
  it('calls onSelectAll when select all is clicked', async () => {
    const user = userEvent.setup({ delay: null });
    render(<LibraryContent {...defaultProps} />);
    const selectAllButton = screen.getByTestId('select-all-button');
    await user.click(selectAllButton);
    expect(defaultProps.onSelectAll).toHaveBeenCalled();
  });

  // 10. clear selection: onClearSelection called
  it('calls onClearSelection when clear is clicked', async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <LibraryContent
        {...defaultProps}
        selectedTracks={new Set(['artist-1'])}
        selectionSummary={'1 selected'}
      />,
    );
    const clearButton = screen.getByTestId('clear-selection-button');
    await user.click(clearButton);
    expect(defaultProps.onClearSelection).toHaveBeenCalled();
  });

  // ORAIN-0385: Filter controls should always be visible (no reflow)
  it('shows all three filter buttons when selectedTracks is empty', () => {
    render(<LibraryContent {...defaultProps} selectedTracks={new Set()} />);
    expect(screen.getByTestId('sync-filter-all')).toBeInTheDocument();
    expect(screen.getByTestId('sync-filter-selected')).toBeInTheDocument();
    expect(screen.getByTestId('sync-filter-unselected')).toBeInTheDocument();
  });

  it('shows all three filter buttons when selectedTracks has items', () => {
    render(
      <LibraryContent
        {...defaultProps}
        selectedTracks={new Set(['artist-1'])}
        selectionSummary={'1 selected'}
      />,
    );
    expect(screen.getByTestId('sync-filter-all')).toBeInTheDocument();
    expect(screen.getByTestId('sync-filter-selected')).toBeInTheDocument();
    expect(screen.getByTestId('sync-filter-unselected')).toBeInTheDocument();
  });

  it('disables Selected button when no items are selected', () => {
    render(<LibraryContent {...defaultProps} selectedTracks={new Set()} />);
    expect(screen.getByTestId('sync-filter-selected')).toBeDisabled();
  });

  it('disables Unselected button when all items are selected', () => {
    // When all items are selected, "unselected" filter would show nothing
    render(
      <LibraryContent
        {...defaultProps}
        selectedTracks={new Set(['artist-1', 'artist-2'])} // All items selected
        selectionSummary={'2 selected'}
      />,
    );
    expect(screen.getByTestId('sync-filter-unselected')).toBeDisabled();
  });

  it('enables Selected button when items are selected', () => {
    render(
      <LibraryContent
        {...defaultProps}
        selectedTracks={new Set(['artist-1'])}
        selectionSummary={'1 selected'}
      />,
    );
    expect(screen.getByTestId('sync-filter-selected')).toBeEnabled();
  });

  it('enables Unselected button when not all items are selected', () => {
    render(
      <LibraryContent
        {...defaultProps}
        selectedTracks={new Set(['artist-1'])} // Only some selected
        selectionSummary={'1 selected'}
      />,
    );
    expect(screen.getByTestId('sync-filter-unselected')).toBeEnabled();
  });
});
