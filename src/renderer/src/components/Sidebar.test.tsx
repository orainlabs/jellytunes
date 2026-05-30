// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { Sidebar } from './Sidebar';
import type {
  ActiveSection,
  LibraryTab,
  LibraryStats,
  PaginationState,
  UsbDevice,
  SavedDestination,
  Genre,
} from '../appTypes';

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
  albumArtists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
  albums: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
  playlists: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
  genres: { items: [], total: 0, startIndex: 0, hasMore: false, scrollPos: 0 },
});

const defaultProps = {
  activeSection: 'library' as ActiveSection,
  activeLibrary: 'artists' as LibraryTab,
  activeDestinationPath: null as string | null,
  stats: null as LibraryStats | null,
  pagination: createPagination(),
  artists: [],
  albumArtists: [],
  albums: [],
  playlists: [],
  genres: [] as Genre[],
  selectedGenre: null as Genre | null,
  onLibraryTab: vi.fn(),
  onSelectGenre: vi.fn(),
  onDestinationClick: vi.fn(),
  onAddFolder: vi.fn(),
  onRefreshDevices: vi.fn(),
  onRefreshLibrary: vi.fn(),
  onRemoveDestination: vi.fn(),
  usbDevices: [] as UsbDevice[],
  savedDestinations: [] as SavedDestination[],
};

describe('Sidebar', () => {
  // 1. Artists tab active: correct highlight style
  it('shows correct highlight style when Artists tab is active', () => {
    render(<Sidebar {...defaultProps} activeLibrary="artists" />);
    const artistsTab = screen.getByTestId('tab-artists');
    expect(artistsTab).toHaveClass(/bg-primary_container/);
  });

  // 1b. Album Artists tab is visible and clickable
  it('shows Album Artists tab and calls onLibraryTab when clicked', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Sidebar {...defaultProps} />);
    const albumArtistsTab = screen.getByTestId('tab-albumArtists');
    expect(albumArtistsTab).toBeInTheDocument();
    await user.click(albumArtistsTab);
    expect(defaultProps.onLibraryTab).toHaveBeenCalledWith('albumArtists');
  });

  // 2. click Albums tab: onLibraryTab('albums') called
  it('calls onLibraryTab with albums when Albums tab is clicked', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Sidebar {...defaultProps} />);
    const albumsTab = screen.getByTestId('tab-albums');
    await user.click(albumsTab);
    expect(defaultProps.onLibraryTab).toHaveBeenCalledWith('albums');
  });

  // 3. no USB connected: "No devices connected" text visible
  it('shows No devices connected when no USB devices are present', () => {
    render(<Sidebar {...defaultProps} usbDevices={[]} />);
    expect(screen.getByText('No devices connected')).toBeInTheDocument();
  });

  // 4. with USB device: device name visible
  it('shows device name when USB device is connected', () => {
    const usbDevices: UsbDevice[] = [
      {
        device: '/dev/sda1',
        displayName: 'SanDisk USB',
        size: 32e9,
        mountpoints: [{ path: '/mnt/usb' }],
        isRemovable: true,
      },
    ];
    render(<Sidebar {...defaultProps} usbDevices={usbDevices} />);
    expect(screen.getByText('SanDisk USB')).toBeInTheDocument();
  });

  // 5. click device: onDestinationClick(path) called with correct path
  it('calls onDestinationClick with correct path when device is clicked', async () => {
    const user = userEvent.setup({ delay: null });
    const usbDevices: UsbDevice[] = [
      {
        device: '/dev/sda1',
        displayName: 'SanDisk USB',
        size: 32e9,
        mountpoints: [{ path: '/mnt/usb' }],
        isRemovable: true,
      },
    ];
    render(<Sidebar {...defaultProps} usbDevices={usbDevices} />);
    const deviceItem = screen.getByTestId('device-item');
    await user.click(deviceItem);
    expect(defaultProps.onDestinationClick).toHaveBeenCalledWith('/mnt/usb');
  });

  // 6. saved folder visible with folder name
  it('shows saved folder with folder name', () => {
    const savedDestinations: SavedDestination[] = [
      { id: 'folder-1', name: 'My Music', path: '/mnt/my-music' },
    ];
    render(<Sidebar {...defaultProps} savedDestinations={savedDestinations} />);
    expect(screen.getByText('My Music')).toBeInTheDocument();
  });

  // 7. trash icon appears on hover over saved folder
  it('shows trash icon when hovering over saved folder', async () => {
    const user = userEvent.setup({ delay: null });
    const savedDestinations: SavedDestination[] = [
      { id: 'folder-1', name: 'My Music', path: '/mnt/my-music' },
    ];
    render(<Sidebar {...defaultProps} savedDestinations={savedDestinations} />);
    // Find the device-item containing the saved folder
    const folderItem = screen.getByTestId('device-item');
    await user.hover(folderItem);
    // The trash icon should be visible after hover
    const folderButton = folderItem.parentElement;
    expect(folderButton?.querySelector('button[title="Remove folder"]')).toBeInTheDocument();
  });

  // 8. click trash + confirm -> onRemoveDestination called
  it('calls onRemoveDestination when trash is clicked and confirmed', async () => {
    const user = userEvent.setup({ delay: null });
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const savedDestinations: SavedDestination[] = [
      { id: 'folder-1', name: 'My Music', path: '/mnt/my-music' },
    ];
    render(<Sidebar {...defaultProps} savedDestinations={savedDestinations} />);
    // Hover to reveal trash button
    const folderItem = screen.getByTestId('device-item');
    await user.hover(folderItem);
    // Find the trash button
    const trashButton = screen.getByTitle('Remove folder');
    await user.click(trashButton);
    // Should show the modal, click confirm
    const removeButton = screen.getByText('Remove folder');
    await user.click(removeButton);
    expect(defaultProps.onRemoveDestination).toHaveBeenCalled();
    vi.mocked(confirm).mockRestore();
  });

  describe('Genres tab', () => {
    it('shows Genres tab button in library navigation', () => {
      render(<Sidebar {...defaultProps} />);
      expect(screen.getByTestId('tab-genres')).toBeInTheDocument();
    });

    it('calls onSelectGenre with null when Genres tab is clicked', async () => {
      const user = userEvent.setup({ delay: null });
      render(<Sidebar {...defaultProps} />);
      const genresTab = screen.getByTestId('tab-genres');
      await user.click(genresTab);
      expect(defaultProps.onSelectGenre).toHaveBeenCalledWith(null);
    });

    it('shows correct highlight style when Genres tab is active', () => {
      render(<Sidebar {...defaultProps} activeLibrary="genres" />);
      const genresTab = screen.getByTestId('tab-genres');
      expect(genresTab).toHaveClass(/bg-primary_container/);
    });
  });
});
