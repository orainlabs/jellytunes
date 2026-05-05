// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { DeviceSyncPanel } from './DeviceSyncPanel'
import type { SyncedItemInfo } from '../hooks/useDeviceSelections'
import type { Artist, Album, Playlist, Bitrate, PreviewData } from '../appTypes'

const mockApi = {
  getDeviceInfo: vi.fn().mockImplementation(() => Promise.resolve({ total: 32e9, free: 16e9, used: 16e9 })),
  getFilesystem: vi.fn().mockImplementation(() => Promise.resolve('exfat')),
  getSyncedItems: vi.fn().mockResolvedValue([]),
  analyzeDiff: vi.fn().mockResolvedValue({ success: true, items: [] }),
  estimateSize: vi.fn().mockResolvedValue({ trackCount: 0, totalBytes: 0, formatBreakdown: {} }),
  startSync2: vi.fn().mockResolvedValue({ success: true, tracksCopied: 10, tracksSkipped: 5, errors: [] }),
  removeItems: vi.fn().mockResolvedValue({ removed: 0, errors: [] }),
  cancelSync: vi.fn().mockResolvedValue({ cancelled: true }),
  onSyncProgress: vi.fn().mockReturnValue(() => () => {}),
  getDeviceSyncInfo: vi.fn().mockResolvedValue(null),
}

beforeAll(() => {
  Object.defineProperty(window, 'api', { value: mockApi, writable: true })
})

afterEach(() => {
  // Only reset mocks that are re-created per-test (e.g. via renderPanel overrides).
  // Do NOT reset module-level mockApi here or the beforeAll setup is lost.
})

const defaultArtists: Artist[] = [
  { Id: 'artist-1', Name: 'Radiohead', AlbumCount: 9 },
  { Id: 'artist-2', Name: 'Pink Floyd', AlbumCount: 15 },
]

const defaultAlbums: Album[] = [
  { Id: 'album-1', Name: 'OK Computer', AlbumArtist: 'Radiohead', ProductionYear: 1997 },
]

const defaultPlaylists: Playlist[] = [
  { Id: 'playlist-1', Name: 'Chill Vibes', ChildCount: 25 },
]

const defaultSyncedItemsInfo: SyncedItemInfo[] = [
  { id: 'artist-1', name: 'Radiohead', type: 'artist' },
  { id: 'album-1', name: 'OK Computer', type: 'album' },
]

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
    syncedItemsInfo: [] as SyncedItemInfo[],
    outOfSyncItems: new Set<string>(),
    artists: defaultArtists,
    albums: defaultAlbums,
    playlists: defaultPlaylists,
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
    ...overrides,
  }
  return render(<DeviceSyncPanel {...props} />)
}

// Renders and waits for device info to load (getDeviceInfo + getFilesystem resolve).
// The storage bar appears as soon as deviceInfo is set, which happens async.
function renderPanelAndSettle(overrides: Partial<Parameters<typeof DeviceSyncPanel>[0]> = {}) {
  const result = renderPanel(overrides)
  // Wait for device info to resolve and skeleton to disappear
  return waitFor(() => {
    expect(document.querySelector('.animate-pulse')).not.toBeInTheDocument()
  }).then(() => result)
}

describe('DeviceSyncPanel', () => {
  describe('initial state', () => {
    it('shows "No items selected" when nothing is selected', async () => {
      await renderPanelAndSettle({ selectedTracks: new Set(), syncedItemsInfo: [] })
      expect(screen.getByText('No items selected')).toBeInTheDocument()
    })

    it('shows loading skeleton when isActivatingDevice is true', async () => {
      renderPanel({ isActivatingDevice: true })
      expect(document.querySelector('.animate-pulse')).toBeInTheDocument()
    })

    it('does not show loading skeleton when isActivatingDevice is false', async () => {
      renderPanel({ isActivatingDevice: false })
      // device info loads async, but skeleton should not show without isActivatingDevice
      await waitFor(() => {
        expect(document.querySelector('.animate-pulse')).not.toBeInTheDocument()
      })
    })
  })

  describe('badges', () => {
    it('shows "On device" badge for synced items', async () => {
      await renderPanelAndSettle({
        selectedTracks: new Set(['artist-1']),
        syncedItemsInfo: defaultSyncedItemsInfo,
      })
      expect(screen.getByText(/^On device · /)).toBeInTheDocument()
    })

    it('shows "Out of sync" badge for out-of-sync items', async () => {
      await renderPanelAndSettle({
        selectedTracks: new Set(['artist-1']),
        syncedItemsInfo: defaultSyncedItemsInfo,
        outOfSyncItems: new Set(['artist-1']),
      })
      expect(screen.getByText(/out of sync/i)).toBeInTheDocument()
    })

    it('shows "Will remove" badge with strikethrough for deselected synced items', async () => {
      await renderPanelAndSettle({
        selectedTracks: new Set(),
        syncedItemsInfo: defaultSyncedItemsInfo,
      })
      expect(screen.getByText(/will remove/i)).toBeInTheDocument()
    })

    it('shows "New" badge for newly selected items not yet synced', async () => {
      await renderPanelAndSettle({
        selectedTracks: new Set(['artist-2']),
        syncedItemsInfo: [],
        artists: defaultArtists,
      })
      expect(screen.getByText(/new/i)).toBeInTheDocument()
    })
  })

  describe('MP3 conversion', () => {
    it('shows "Copy files as-is" when MP3 conversion is off', async () => {
      await renderPanelAndSettle({ convertToMp3: false })
      expect(screen.getByText(/copy files as-is/i)).toBeInTheDocument()
    })

    it('shows bitrate selector when MP3 conversion is on', async () => {
      await renderPanelAndSettle({ convertToMp3: true })
      expect(screen.getByText('128k')).toBeInTheDocument()
      expect(screen.getByText('192k')).toBeInTheDocument()
      expect(screen.getByText('320k')).toBeInTheDocument()
    })

    it('calls onBitrateChange when bitrate is clicked', async () => {
      const onBitrateChange = vi.fn()
      await renderPanelAndSettle({ convertToMp3: true, onBitrateChange })
      await userEvent.click(screen.getByText('320k'))
      expect(onBitrateChange).toHaveBeenCalledWith('320k')
    })
  })

  describe('sync button', () => {
    it('is disabled when no items selected', async () => {
      await renderPanelAndSettle({ selectedTracks: new Set() })
      expect(screen.getByTestId('sync-button')).toBeDisabled()
    })

    it('is enabled when items are selected', async () => {
      await renderPanelAndSettle({ selectedTracks: new Set(['artist-1']) })
      expect(screen.getByTestId('sync-button')).toBeEnabled()
    })

    it('calls onStartSync when clicked', async () => {
      const onStartSync = vi.fn()
      await renderPanelAndSettle({ selectedTracks: new Set(['artist-1']), onStartSync })
      await userEvent.click(screen.getByTestId('sync-button'))
      expect(onStartSync).toHaveBeenCalled()
    })
  })

  describe('sync preview modal', () => {
    it('shows preview data when showPreview is true', async () => {
      const previewData: PreviewData = {
        trackCount: 100,
        totalBytes: 5e9,
        formatBreakdown: { flac: 3e9, mp3: 2e9 },
        newTracksCount: 90,
        newTracksBytes: 4.5e9,
        updatedTracksCount: 0,
        updatedTracksBytes: 0,
        alreadySyncedCount: 0,
        alreadySyncedBytes: 0,
        willRemoveCount: 2,
        willRemoveBytes: 0.5e9,
      }
      await renderPanelAndSettle({ showPreview: true, previewData })
      expect(screen.getByTestId('sync-preview-modal')).toBeInTheDocument()
    })

    it('confirm calls onConfirmSync', async () => {
      const onConfirmSync = vi.fn()
      const previewData: PreviewData = {
        trackCount: 100,
        totalBytes: 5e9,
        formatBreakdown: {},
        newTracksCount: 100,
        newTracksBytes: 5e9,
        updatedTracksCount: 0,
        updatedTracksBytes: 0,
        alreadySyncedCount: 0,
        alreadySyncedBytes: 0,
        willRemoveCount: 0,
        willRemoveBytes: 0,
      }
      await renderPanelAndSettle({ showPreview: true, previewData, onConfirmSync })
      await userEvent.click(screen.getByTestId('confirm-sync-button'))
      expect(onConfirmSync).toHaveBeenCalled()
    })

    it('cancel calls onCancelPreview', async () => {
      const onCancelPreview = vi.fn()
      const previewData: PreviewData = {
        trackCount: 100,
        totalBytes: 5e9,
        formatBreakdown: {},
        newTracksCount: 100,
        newTracksBytes: 5e9,
        updatedTracksCount: 0,
        updatedTracksBytes: 0,
        alreadySyncedCount: 0,
        alreadySyncedBytes: 0,
        willRemoveCount: 0,
        willRemoveBytes: 0,
      }
      await renderPanelAndSettle({ showPreview: true, previewData, onCancelPreview })
      await userEvent.click(screen.getByTestId('cancel-preview-button'))
      expect(onCancelPreview).toHaveBeenCalled()
    })
  })

  describe('cancel sync', () => {
    it('shows cancel button when syncing', async () => {
      await renderPanelAndSettle({ isSyncing: true })
      expect(screen.getByTestId('cancel-sync-button')).toBeInTheDocument()
    })

    it('calls onCancelSync when cancel button clicked', async () => {
      const onCancelSync = vi.fn()
      await renderPanelAndSettle({ isSyncing: true, onCancelSync })
      await userEvent.click(screen.getByTestId('cancel-sync-button'))
      expect(onCancelSync).toHaveBeenCalled()
    })
  })

  describe('filesystem badge', () => {
    it('shows FAT32 badge when filesystem is fat32', async () => {
      mockApi.getFilesystem.mockResolvedValue('fat32')
      renderPanel({ destinationPath: '/mnt/fat32' })
      await waitFor(() => {
        expect(screen.getByText('FAT32')).toBeInTheDocument()
      })
    })
  })

  describe('isActivatingDevice', () => {
    it('skeleton is hidden after device info loads when isActivatingDevice is false', async () => {
      // renderPanelAndSettle waits for skeleton to disappear
      await renderPanelAndSettle({ isActivatingDevice: false })
      expect(document.querySelector('.animate-pulse')).not.toBeInTheDocument()
    })

    it('skeleton remains visible when isActivatingDevice is true even after device info loads', async () => {
      // renderPanelAndSettle waits for device info to resolve.
      // Skeleton should still be visible because isActivatingDevice keeps it showing.
      renderPanel({ isActivatingDevice: true })
      await waitFor(() => {
        expect(document.querySelector('.animate-pulse')).toBeInTheDocument()
      })
    })

    it('sync button is disabled when isActivatingDevice is true', async () => {
      renderPanel({ isActivatingDevice: true, selectedTracks: new Set(['artist-1']) })
      await waitFor(() => {
        expect(screen.getByTestId('sync-button')).toBeDisabled()
      })
    })

    it('sync button shows "Calculating sync state…" when isActivatingDevice is true', async () => {
      renderPanel({ isActivatingDevice: true, selectedTracks: new Set(['artist-1']) })
      await waitFor(() => {
        expect(screen.getByText('Calculating sync state…')).toBeInTheDocument()
      })
    })
  })
})
