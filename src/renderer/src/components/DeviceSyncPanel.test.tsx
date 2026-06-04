// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { DeviceSyncPanel } from './DeviceSyncPanel';
import type { SyncedItemInfo } from '../hooks/useDeviceSelections';
import type { Artist, Album, Playlist, Bitrate, PreviewData } from '../appTypes';

const mockApi = {
  getDeviceInfo: vi
    .fn()
    .mockImplementation(() => Promise.resolve({ total: 32e9, free: 16e9, used: 16e9 })),
  getFilesystem: vi.fn().mockImplementation(() => Promise.resolve('exfat')),
  getSyncedItems: vi.fn().mockResolvedValue([]),
  analyzeDiff: vi.fn().mockResolvedValue({ success: true, items: [] }),
  estimateSize: vi.fn().mockResolvedValue({ trackCount: 0, totalBytes: 0, formatBreakdown: {} }),
  startSync2: vi
    .fn()
    .mockResolvedValue({ success: true, tracksCopied: 10, tracksSkipped: 5, errors: [] }),
  removeItems: vi.fn().mockResolvedValue({ removed: 0, errors: [] }),
  cancelSync: vi.fn().mockResolvedValue({ cancelled: true }),
  onSyncProgress: vi.fn().mockReturnValue(() => () => {}),
  getDeviceSyncInfo: vi.fn().mockResolvedValue(null),
};

beforeAll(() => {
  Object.defineProperty(window, 'api', { value: mockApi, writable: true });
});

afterEach(() => {
  // Only reset mocks that are re-created per-test (e.g. via renderPanel overrides).
  // Do NOT reset module-level mockApi here or the beforeAll setup is lost.
});

const defaultArtists: Artist[] = [
  { Id: 'artist-1', Name: 'Radiohead', AlbumCount: 9 },
  { Id: 'artist-2', Name: 'Pink Floyd', AlbumCount: 15 },
];
const defaultAlbumArtists: Artist[] = [];

const defaultAlbums: Album[] = [
  { Id: 'album-1', Name: 'OK Computer', AlbumArtist: 'Radiohead', ProductionYear: 1997 },
];

const defaultPlaylists: Playlist[] = [{ Id: 'playlist-1', Name: 'Chill Vibes', ChildCount: 25 }];

const defaultSyncedItemsInfo: SyncedItemInfo[] = [
  { id: 'artist-1', name: 'Radiohead', type: 'artist' },
  { id: 'album-1', name: 'OK Computer', type: 'album' },
];

function renderPanel(overrides: Partial<Parameters<typeof DeviceSyncPanel>[0]> = {}) {
  const props = {
    destinationPath: '/mnt/usb',
    destinationName: 'USB Drive',
    isUsbDevice: true,
    isSaved: true,
    convertToMp3: false,
    bitrate: '192k' as Bitrate,
    isSyncing: false,
    isActivatingDevice: false,
    syncProgress: null,
    selectedTracks: new Set<string>(),
    // ORAIN-0551: default the typed sets to empty so existing tests that only
    // set `selectedTracks` get an explicit "no artist typed selection" baseline.
    // Tests that need to exercise the shared-id path pass these explicitly.
    selectedArtists: new Set<string>(),
    selectedAlbumArtists: new Set<string>(),
    syncedItemsInfo: [] as SyncedItemInfo[],
    outOfSyncItems: new Set<string>(),
    artists: defaultArtists,
    albums: defaultAlbums,
    playlists: defaultPlaylists,
    albumArtists: defaultAlbumArtists,
    genres: [],
    showPreview: false,
    previewData: null,
    onToggleItem: vi.fn(),
    onToggleConvert: vi.fn(),
    onBitrateChange: vi.fn(),
    coverArtMode: 'embed' as const,
    onCoverArtModeChange: vi.fn(),
    onStartSync: vi.fn(),
    onCancelSync: vi.fn(),
    onCancelPreview: vi.fn(),
    onConfirmSync: vi.fn(),
    onRemoveDestination: vi.fn(),
    lyricsMode: 'off' as const,
    onLyricsModeChange: vi.fn(),
    hasFlacOrM4a: false,
    ...overrides,
  };
  return render(<DeviceSyncPanel {...props} />);
}

// Renders and waits for device info to load (getDeviceInfo + getFilesystem resolve).
// The storage bar appears as soon as deviceInfo is set, which happens async.
function renderPanelAndSettle(overrides: Partial<Parameters<typeof DeviceSyncPanel>[0]> = {}) {
  const result = renderPanel(overrides);
  // Wait for device info to resolve and skeleton to disappear
  return waitFor(() => {
    expect(document.querySelector('.animate-pulse')).not.toBeInTheDocument();
  }).then(() => result);
}

describe('DeviceSyncPanel', () => {
  describe('initial state', () => {
    it('shows "No items selected" when nothing is selected', async () => {
      await renderPanelAndSettle({ selectedTracks: new Set(), syncedItemsInfo: [] });
      expect(screen.getByText('No items selected')).toBeInTheDocument();
    });

    it('shows loading skeleton when isActivatingDevice is true', async () => {
      renderPanel({ isActivatingDevice: true });
      expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    });

    it('does not show loading skeleton when isActivatingDevice is false', async () => {
      renderPanel({ isActivatingDevice: false });
      // device info loads async, but skeleton should not show without isActivatingDevice
      await waitFor(() => {
        expect(document.querySelector('.animate-pulse')).not.toBeInTheDocument();
      });
    });
  });

  describe('badges', () => {
    it('shows "On device" badge for synced items', async () => {
      await renderPanelAndSettle({
        selectedTracks: new Set(['artist-1']),
        syncedItemsInfo: defaultSyncedItemsInfo,
      });
      expect(screen.getByText(/^On device · /)).toBeInTheDocument();
    });

    it('shows "Out of sync" badge for out-of-sync items', async () => {
      await renderPanelAndSettle({
        selectedTracks: new Set(['artist-1']),
        syncedItemsInfo: defaultSyncedItemsInfo,
        outOfSyncItems: new Set(['artist-1']),
      });
      expect(screen.getByText(/out of sync/i)).toBeInTheDocument();
    });

    it('shows "Will remove" badge with strikethrough for deselected synced items', async () => {
      await renderPanelAndSettle({
        selectedTracks: new Set(),
        syncedItemsInfo: defaultSyncedItemsInfo,
      });
      expect(screen.getByText(/will remove/i)).toBeInTheDocument();
    });

    it('shows "New" badge for newly selected items not yet synced', async () => {
      await renderPanelAndSettle({
        // ORAIN-0551: artist selections now live in the typed set, not the union.
        selectedArtists: new Set(['artist-2']),
        syncedItemsInfo: [],
        artists: defaultArtists,
      });
      expect(screen.getByText(/new/i)).toBeInTheDocument();
    });
  });

  describe('MP3 conversion', () => {
    it('shows "Copy files as-is" when MP3 conversion is off', async () => {
      await renderPanelAndSettle({ convertToMp3: false });
      expect(screen.getByText(/copy files as-is/i)).toBeInTheDocument();
    });

    it('shows bitrate selector when MP3 conversion is on', async () => {
      await renderPanelAndSettle({ convertToMp3: true });
      expect(screen.getByText('128k')).toBeInTheDocument();
      expect(screen.getByText('192k')).toBeInTheDocument();
      expect(screen.getByText('320k')).toBeInTheDocument();
    });

    it('calls onBitrateChange when bitrate is clicked', async () => {
      const onBitrateChange = vi.fn();
      await renderPanelAndSettle({ convertToMp3: true, onBitrateChange });
      await userEvent.click(screen.getByText('320k'));
      expect(onBitrateChange).toHaveBeenCalledWith('320k');
    });
  });

  describe('ORAIN-0534: React duplicate key for artist + albumArtist with same id', () => {
    it('does NOT emit React duplicate-key warning when artists and albumArtists share an id', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const sharedId = 'shared-id';
        // Both lists include the same id — must not cause React duplicate-key warning
        await renderPanelAndSettle({
          // ORAIN-0551: id is "selected as artist" only. The duplicate-key
          // test focuses on the rendering path; routing correctness is
          // covered by the new ORAIN-0551 describe block below.
          selectedArtists: new Set([sharedId]),
          syncedItemsInfo: [],
          artists: [{ Id: sharedId, Name: 'As Artist', AlbumCount: 5 }],
          albumArtists: [{ Id: sharedId, Name: 'As AlbumArtist', AlbumCount: 7 }],
        });
        const duplicateKeyCalls = consoleErrorSpy.mock.calls.filter((args) =>
          args.some(
            (a) =>
              typeof a === 'string' && a.includes('Encountered two children with the same key'),
          ),
        );
        expect(duplicateKeyCalls).toHaveLength(0);
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });

  describe('cover art mode', () => {
    const getCoverArtSection = () =>
      screen
        .getByText('Cover art')
        .closest('div[class*="bg-surface_container_low"]') as HTMLElement;

    it('shows cover art section', async () => {
      await renderPanelAndSettle();
      expect(screen.getByText('Cover art')).toBeInTheDocument();
    });

    it('shows three cover art mode buttons: None, Embed, Folder image', async () => {
      await renderPanelAndSettle();
      const coverArtSection = getCoverArtSection();
      const { getByRole } = within(coverArtSection);
      expect(getByRole('button', { name: 'None' })).toBeInTheDocument();
      expect(getByRole('button', { name: 'Embed' })).toBeInTheDocument();
      expect(getByRole('button', { name: 'Folder image' })).toBeInTheDocument();
    });

    it('calls onCoverArtModeChange with "off" when None is clicked', async () => {
      const onCoverArtModeChange = vi.fn();
      await renderPanelAndSettle({ coverArtMode: 'embed', onCoverArtModeChange });
      const coverArtSection = getCoverArtSection();
      await userEvent.click(within(coverArtSection).getByRole('button', { name: 'None' }));
      expect(onCoverArtModeChange).toHaveBeenCalledWith('off');
    });

    it('calls onCoverArtModeChange with "embed" when Embed is clicked', async () => {
      const onCoverArtModeChange = vi.fn();
      await renderPanelAndSettle({ coverArtMode: 'off', onCoverArtModeChange });
      const coverArtSection = getCoverArtSection();
      await userEvent.click(within(coverArtSection).getByRole('button', { name: 'Embed' }));
      expect(onCoverArtModeChange).toHaveBeenCalledWith('embed');
    });

    it('calls onCoverArtModeChange with "companion" when Folder image is clicked', async () => {
      const onCoverArtModeChange = vi.fn();
      await renderPanelAndSettle({ coverArtMode: 'embed', onCoverArtModeChange });
      const coverArtSection = getCoverArtSection();
      await userEvent.click(within(coverArtSection).getByText('Folder image'));
      expect(onCoverArtModeChange).toHaveBeenCalledWith('companion');
    });

    it('shows description for "off" mode', async () => {
      await renderPanelAndSettle({ coverArtMode: 'off' });
      expect(screen.getByText('No cover art')).toBeInTheDocument();
    });

    it('shows description for "embed" mode', async () => {
      await renderPanelAndSettle({ coverArtMode: 'embed' });
      expect(screen.getByText('Cover embedded in audio file')).toBeInTheDocument();
    });

    it('shows description for "companion" mode', async () => {
      await renderPanelAndSettle({ coverArtMode: 'companion' });
      expect(screen.getByText('Cover saved as cover.jpg in album folder')).toBeInTheDocument();
    });

    it('buttons are disabled when isSyncing is true', async () => {
      await renderPanelAndSettle({ isSyncing: true });
      const coverArtSection = getCoverArtSection();
      const { getByRole } = within(coverArtSection);
      expect(getByRole('button', { name: 'None' })).toBeDisabled();
      expect(getByRole('button', { name: 'Embed' })).toBeDisabled();
      expect(getByRole('button', { name: 'Folder image' })).toBeDisabled();
    });

    it('active button has different styling than inactive buttons', async () => {
      await renderPanelAndSettle({ coverArtMode: 'embed' });
      const coverArtSection = getCoverArtSection();
      const { getByRole } = within(coverArtSection);
      expect(getByRole('button', { name: 'Embed' })).toHaveClass('bg-primary_container');
      expect(getByRole('button', { name: 'None' })).toHaveClass('bg-surface_container_highest');
      expect(getByRole('button', { name: 'Folder image' })).toHaveClass(
        'bg-surface_container_highest',
      );
    });
  });

  describe('sync button', () => {
    it('is disabled when no items selected', async () => {
      await renderPanelAndSettle({ selectedTracks: new Set() });
      expect(screen.getByTestId('sync-button')).toBeDisabled();
    });

    it('is enabled when items are selected', async () => {
      await renderPanelAndSettle({
        // ORAIN-0551: artist selections live in the typed set.
        selectedArtists: new Set(['artist-1']),
      });
      expect(screen.getByTestId('sync-button')).toBeEnabled();
    });

    it('calls onStartSync when clicked', async () => {
      const onStartSync = vi.fn();
      await renderPanelAndSettle({
        // ORAIN-0551: artist selections live in the typed set.
        selectedArtists: new Set(['artist-1']),
        onStartSync,
      });
      await userEvent.click(screen.getByTestId('sync-button'));
      expect(onStartSync).toHaveBeenCalled();
    });
  });

  describe('sync preview modal', () => {
    it('shows preview data when showPreview is true', async () => {
      const previewData: PreviewData = {
        trackCount: 100,
        totalBytes: 5e9,
        totalDurationSeconds: 0,
        formatBreakdown: { flac: 3e9, mp3: 2e9 },
        newTracksCount: 90,
        newTracksBytes: 4.5e9,
        updatedTracksCount: 0,
        updatedTracksBytes: 0,
        alreadySyncedCount: 0,
        alreadySyncedBytes: 0,
        willRemoveCount: 2,
        willRemoveBytes: 0.5e9,
      };
      await renderPanelAndSettle({ showPreview: true, previewData });
      expect(screen.getByTestId('sync-preview-modal')).toBeInTheDocument();
    });

    it('confirm calls onConfirmSync', async () => {
      const onConfirmSync = vi.fn();
      const previewData: PreviewData = {
        trackCount: 100,
        totalBytes: 5e9,
        totalDurationSeconds: 0,
        formatBreakdown: {},
        newTracksCount: 100,
        newTracksBytes: 5e9,
        updatedTracksCount: 0,
        updatedTracksBytes: 0,
        alreadySyncedCount: 0,
        alreadySyncedBytes: 0,
        willRemoveCount: 0,
        willRemoveBytes: 0,
      };
      await renderPanelAndSettle({ showPreview: true, previewData, onConfirmSync });
      await userEvent.click(screen.getByTestId('confirm-sync-button'));
      expect(onConfirmSync).toHaveBeenCalled();
    });

    it('cancel calls onCancelPreview', async () => {
      const onCancelPreview = vi.fn();
      const previewData: PreviewData = {
        trackCount: 100,
        totalBytes: 5e9,
        totalDurationSeconds: 0,
        formatBreakdown: {},
        newTracksCount: 100,
        newTracksBytes: 5e9,
        updatedTracksCount: 0,
        updatedTracksBytes: 0,
        alreadySyncedCount: 0,
        alreadySyncedBytes: 0,
        willRemoveCount: 0,
        willRemoveBytes: 0,
      };
      await renderPanelAndSettle({ showPreview: true, previewData, onCancelPreview });
      await userEvent.click(screen.getByTestId('cancel-preview-button'));
      expect(onCancelPreview).toHaveBeenCalled();
    });
  });

  describe('lyrics mode', () => {
    const getLyricsSection = () =>
      screen.getByText('Lyrics').closest('div[class*="bg-surface_container_low"]') as HTMLElement;

    it('shows lyrics section', async () => {
      await renderPanelAndSettle();
      expect(screen.getByText('Lyrics')).toBeInTheDocument();
    });

    it('shows three lyrics mode buttons: None, LRC File, Embed', async () => {
      await renderPanelAndSettle();
      const lyricsSection = getLyricsSection();
      const { getByRole } = within(lyricsSection);
      expect(getByRole('button', { name: 'None' })).toBeInTheDocument();
      expect(getByRole('button', { name: 'LRC File' })).toBeInTheDocument();
      expect(getByRole('button', { name: 'Embed' })).toBeInTheDocument();
    });

    it('calls onLyricsModeChange with "off" when None is clicked', async () => {
      const onLyricsModeChange = vi.fn();
      await renderPanelAndSettle({ lyricsMode: 'lrc', onLyricsModeChange });
      const lyricsSection = getLyricsSection();
      await userEvent.click(within(lyricsSection).getByRole('button', { name: 'None' }));
      expect(onLyricsModeChange).toHaveBeenCalledWith('off');
    });

    it('calls onLyricsModeChange with "lrc" when LRC File is clicked', async () => {
      const onLyricsModeChange = vi.fn();
      await renderPanelAndSettle({ lyricsMode: 'off', onLyricsModeChange });
      const lyricsSection = getLyricsSection();
      await userEvent.click(within(lyricsSection).getByRole('button', { name: 'LRC File' }));
      expect(onLyricsModeChange).toHaveBeenCalledWith('lrc');
    });

    it('calls onLyricsModeChange with "embed" when Embed is clicked', async () => {
      const onLyricsModeChange = vi.fn();
      await renderPanelAndSettle({ lyricsMode: 'off', onLyricsModeChange });
      const lyricsSection = getLyricsSection();
      await userEvent.click(within(lyricsSection).getByRole('button', { name: 'Embed' }));
      expect(onLyricsModeChange).toHaveBeenCalledWith('embed');
    });

    it('shows description for "off" mode', async () => {
      await renderPanelAndSettle({ lyricsMode: 'off' });
      expect(screen.getByText('No lyrics')).toBeInTheDocument();
    });

    it('shows description for "lrc" mode', async () => {
      await renderPanelAndSettle({ lyricsMode: 'lrc' });
      expect(screen.getByText(/synced lyrics.*\.lrc file/i)).toBeInTheDocument();
    });

    it('shows description for "embed" mode', async () => {
      await renderPanelAndSettle({ lyricsMode: 'embed' });
      expect(screen.getByText('Lyrics embedded in audio file')).toBeInTheDocument();
    });

    it('buttons are disabled when isSyncing is true', async () => {
      await renderPanelAndSettle({ isSyncing: true });
      const lyricsSection = getLyricsSection();
      const { getByRole } = within(lyricsSection);
      expect(getByRole('button', { name: 'None' })).toBeDisabled();
      expect(getByRole('button', { name: 'LRC File' })).toBeDisabled();
      expect(getByRole('button', { name: 'Embed' })).toBeDisabled();
    });

    it('active button has different styling than inactive buttons', async () => {
      await renderPanelAndSettle({ lyricsMode: 'lrc' });
      const lyricsSection = getLyricsSection();
      const { getByRole } = within(lyricsSection);
      // Active button (lrc) has bg-primary_container
      expect(getByRole('button', { name: 'LRC File' })).toHaveClass('bg-primary_container');
      // Inactive buttons (off, embed) have bg-surface_container_highest
      expect(getByRole('button', { name: 'None' })).toHaveClass('bg-surface_container_highest');
      expect(getByRole('button', { name: 'Embed' })).toHaveClass('bg-surface_container_highest');
    });
  });

  describe('lyrics warning', () => {
    const LYRICS_WARNING = /FLAC\/M4A no soportan letras sincronizadas/i;

    it('shows FLAC/M4A warning when lyricsMode is embed and has flac tracks', async () => {
      await renderPanelAndSettle({
        lyricsMode: 'embed',
        hasFlacOrM4a: true,
      });
      expect(screen.getByText(LYRICS_WARNING)).toBeInTheDocument();
    });

    it('does not show warning when lyricsMode is embed but no FLAC/M4A tracks', async () => {
      await renderPanelAndSettle({
        lyricsMode: 'embed',
        hasFlacOrM4a: false,
      });
      expect(screen.queryByText(LYRICS_WARNING)).not.toBeInTheDocument();
    });

    it('does not show warning when lyricsMode is lrc even with FLAC/M4A tracks', async () => {
      await renderPanelAndSettle({
        lyricsMode: 'lrc',
        hasFlacOrM4a: true,
      });
      expect(screen.queryByText(LYRICS_WARNING)).not.toBeInTheDocument();
    });

    it('does not show warning when lyricsMode is off even with FLAC/M4A tracks', async () => {
      await renderPanelAndSettle({
        lyricsMode: 'off',
        hasFlacOrM4a: true,
      });
      expect(screen.queryByText(LYRICS_WARNING)).not.toBeInTheDocument();
    });
  });

  describe('cancel sync', () => {
    it('shows cancel button when syncing', async () => {
      await renderPanelAndSettle({ isSyncing: true });
      expect(screen.getByTestId('cancel-sync-button')).toBeInTheDocument();
    });

    it('calls onCancelSync when cancel button clicked', async () => {
      const onCancelSync = vi.fn();
      await renderPanelAndSettle({ isSyncing: true, onCancelSync });
      await userEvent.click(screen.getByTestId('cancel-sync-button'));
      expect(onCancelSync).toHaveBeenCalled();
    });
  });

  describe('filesystem badge', () => {
    it('shows FAT32 badge when filesystem is fat32', async () => {
      mockApi.getFilesystem.mockResolvedValue('fat32');
      renderPanel({ destinationPath: '/mnt/fat32' });
      await waitFor(() => {
        expect(screen.getByText('FAT32')).toBeInTheDocument();
      });
    });
  });

  describe('cover art mode', () => {
    const getCoverArtSection = () =>
      screen
        .getByText('Cover art')
        .closest('div[class*="bg-surface_container_low"]') as HTMLElement;

    it('shows cover art section', async () => {
      await renderPanelAndSettle();
      expect(screen.getByText('Cover art')).toBeInTheDocument();
    });

    it('shows three cover art mode buttons: None, Embed, Folder image', async () => {
      await renderPanelAndSettle();
      const coverArtSection = getCoverArtSection();
      const { getByRole } = within(coverArtSection);
      expect(getByRole('button', { name: 'None' })).toBeInTheDocument();
      expect(getByRole('button', { name: 'Embed' })).toBeInTheDocument();
      expect(getByRole('button', { name: 'Folder image' })).toBeInTheDocument();
    });

    it('calls onCoverArtModeChange with "off" when None is clicked', async () => {
      const onCoverArtModeChange = vi.fn();
      await renderPanelAndSettle({ coverArtMode: 'embed', onCoverArtModeChange });
      const coverArtSection = getCoverArtSection();
      await userEvent.click(within(coverArtSection).getByRole('button', { name: 'None' }));
      expect(onCoverArtModeChange).toHaveBeenCalledWith('off');
    });

    it('calls onCoverArtModeChange with "embed" when Embed is clicked', async () => {
      const onCoverArtModeChange = vi.fn();
      await renderPanelAndSettle({ coverArtMode: 'off', onCoverArtModeChange });
      const coverArtSection = getCoverArtSection();
      await userEvent.click(within(coverArtSection).getByRole('button', { name: 'Embed' }));
      expect(onCoverArtModeChange).toHaveBeenCalledWith('embed');
    });

    it('calls onCoverArtModeChange with "companion" when Folder image is clicked', async () => {
      const onCoverArtModeChange = vi.fn();
      await renderPanelAndSettle({ coverArtMode: 'embed', onCoverArtModeChange });
      const coverArtSection = getCoverArtSection();
      await userEvent.click(within(coverArtSection).getByText('Folder image'));
      expect(onCoverArtModeChange).toHaveBeenCalledWith('companion');
    });
  });

  describe('storage bar audio segment (ORAIN-0528)', () => {
    const findAudioRow = () => {
      const bar = screen.getByTestId('storage-bar');
      // Audio row is the one with the primary_container swatch
      const audioSpan = within(bar).getByText(/Audio$/);
      return audioSpan.parentElement as HTMLElement;
    };

    it('shows 0 B Audio when all synced items are deselected (WILL REMOVE) and no new items selected', async () => {
      // Repro: 133 MB worth of synced audio on device, no new items selected,
      // all previously-synced items are in WILL REMOVE state.
      // projectedAudioBytes represents what will exist on device post-sync.
      await renderPanelAndSettle({
        syncedMusicBytes: 133 * 1024 * 1024,
        projectedAudioBytes: 0,
        estimatedSizeBytes: null,
        selectedTracks: new Set<string>(),
        syncedItemsInfo: defaultSyncedItemsInfo,
      });
      const audioRow = findAudioRow();
      // Audio row must NOT show the inflated 133 MB — items in WILL REMOVE
      // will be deleted, so post-sync the device has 0 audio from us.
      // formatBytes(0) renders as "0 KB" (see src/renderer/src/utils/format.ts).
      expect(audioRow).toHaveTextContent('0 KB');
      expect(audioRow).toHaveTextContent(/Audio$/);
    });

    it('shows projected audio when some synced items are kept and new items are selected', async () => {
      // 200 MB total synced; user kept some + selected new — projected
      // total is 150 MB. The bar must show 150 MB, not the inflated 200 MB.
      await renderPanelAndSettle({
        syncedMusicBytes: 200 * 1024 * 1024,
        projectedAudioBytes: 150 * 1024 * 1024,
        estimatedSizeBytes: 150 * 1024 * 1024,
        selectedTracks: new Set(['artist-1', 'artist-2']),
        syncedItemsInfo: defaultSyncedItemsInfo,
      });
      const audioRow = findAudioRow();
      // formatBytes(157286400) = "157 MB"
      expect(audioRow).toHaveTextContent('157');
      expect(audioRow).toHaveTextContent(/Audio$/);
    });

    it('shows kept audio bytes when only synced items are selected (no new)', async () => {
      // 200 MB total synced; user kept all of it. Audio = 200 MB.
      await renderPanelAndSettle({
        syncedMusicBytes: 200 * 1024 * 1024,
        projectedAudioBytes: 200 * 1024 * 1024,
        estimatedSizeBytes: 200 * 1024 * 1024,
        selectedTracks: new Set(['artist-1', 'album-1']),
        syncedItemsInfo: defaultSyncedItemsInfo,
      });
      const audioRow = findAudioRow();
      // formatBytes(209715200) ≈ "200 MB" or "210 MB" (binary units).
      expect(audioRow).toHaveTextContent(/200|210/);
    });
  });

  describe('isActivatingDevice', () => {
    it('skeleton is hidden after device info loads when isActivatingDevice is false', async () => {
      // renderPanelAndSettle waits for skeleton to disappear
      await renderPanelAndSettle({ isActivatingDevice: false });
      expect(document.querySelector('.animate-pulse')).not.toBeInTheDocument();
    });

    it('skeleton remains visible when isActivatingDevice is true even after device info loads', async () => {
      // renderPanelAndSettle waits for device info to resolve.
      // Skeleton should still be visible because isActivatingDevice keeps it showing.
      renderPanel({ isActivatingDevice: true });
      await waitFor(() => {
        expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
      });
    });

    it('sync button is disabled when isActivatingDevice is true', async () => {
      renderPanel({ isActivatingDevice: true, selectedTracks: new Set(['artist-1']) });
      await waitFor(() => {
        expect(screen.getByTestId('sync-button')).toBeDisabled();
      });
    });

    it('sync button shows "Calculating sync state…" when isActivatingDevice is true', async () => {
      renderPanel({ isActivatingDevice: true, selectedTracks: new Set(['artist-1']) });
      await waitFor(() => {
        expect(screen.getByText('Calculating sync state…')).toBeInTheDocument();
      });
    });
  });

  describe('ORAIN-0551: shared id between artists and albumArtists appears once', () => {
    it('shows the shared id exactly once in the New section even when present in both lists', async () => {
      const sharedId = 'shared-id';
      await renderPanelAndSettle({
        // User selected the id from the Artists view — it lives in the
        // selectedArtists set only. The fact that it ALSO exists in
        // extAlbumArtists must NOT cause it to be rendered twice.
        selectedArtists: new Set([sharedId]),
        selectedAlbumArtists: new Set(),
        selectedTracks: new Set([sharedId]),
        syncedItemsInfo: [],
        artists: [{ Id: sharedId, Name: 'As Artist', AlbumCount: 5 }],
        albumArtists: [{ Id: sharedId, Name: 'As AlbumArtist', AlbumCount: 7 }],
      });
      // The New section should show the artist's display name (from the
      // selectedArtists set, not the album-artist set) exactly once.
      const artistEntries = screen.getAllByText('As Artist');
      expect(artistEntries).toHaveLength(1);
      // And the album-artist display name must not appear at all.
      expect(screen.queryByText('As AlbumArtist')).not.toBeInTheDocument();
    });

    it('shows the shared id with the albumArtist type when only selectedAlbumArtists has it', async () => {
      const sharedId = 'shared-id';
      await renderPanelAndSettle({
        selectedArtists: new Set(),
        selectedAlbumArtists: new Set([sharedId]),
        selectedTracks: new Set([sharedId]),
        syncedItemsInfo: [],
        artists: [{ Id: sharedId, Name: 'As Artist', AlbumCount: 5 }],
        albumArtists: [{ Id: sharedId, Name: 'As AlbumArtist', AlbumCount: 7 }],
      });
      const albumArtistEntries = screen.getAllByText('As AlbumArtist');
      expect(albumArtistEntries).toHaveLength(1);
      expect(screen.queryByText('As Artist')).not.toBeInTheDocument();
      // The type chip ("albumArtist") is rendered as a span next to the name.
      // The whole sync panel must contain at least one "albumArtist" text node.
      expect(document.body.textContent).toMatch(/albumArtist/);
      // And the albumArtist name must appear exactly once (no duplicate from
      // the artists list — that would be the regression we're fixing).
      expect(screen.getAllByText('As AlbumArtist')).toHaveLength(1);
    });

    it('shows the shared id twice if the user actually selected it from BOTH views (intentional)', async () => {
      const sharedId = 'shared-id';
      await renderPanelAndSettle({
        // The user explicitly clicked the id in BOTH views (which is now
        // a no-op toggle-off + toggle-on, but for the test we simulate the
        // intermediate state where both sets contain it).
        selectedArtists: new Set([sharedId]),
        selectedAlbumArtists: new Set([sharedId]),
        selectedTracks: new Set([sharedId]),
        syncedItemsInfo: [],
        artists: [{ Id: sharedId, Name: 'As Artist', AlbumCount: 5 }],
        albumArtists: [{ Id: sharedId, Name: 'As AlbumArtist', AlbumCount: 7 }],
      });
      // In this contrived state, both names show once each — i.e., 2 rows.
      expect(screen.getAllByText('As Artist')).toHaveLength(1);
      expect(screen.getAllByText('As AlbumArtist')).toHaveLength(1);
    });
  });
});
