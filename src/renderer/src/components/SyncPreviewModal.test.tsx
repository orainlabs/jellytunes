// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { SyncPreviewModal } from './SyncPreviewModal'
import type { PreviewData, Bitrate } from '../appTypes'

const mockApi = {
  listUsbDevices: vi.fn().mockResolvedValue([]),
  getDeviceInfo: vi.fn().mockResolvedValue({ total: 32e9, free: 16e9, used: 16e9 }),
  getFilesystem: vi.fn().mockResolvedValue('exfat'),
  getSyncedItems: vi.fn().mockResolvedValue([]),
  analyzeDiff: vi.fn().mockResolvedValue({ success: true, items: [] }),
  estimateSize: vi.fn().mockResolvedValue({ trackCount: 0, totalBytes: 0, formatBreakdown: {} }),
  startSync2: vi.fn().mockResolvedValue({ success: true, tracksCopied: 10, tracksSkipped: 5, errors: [] }),
  removeItems: vi.fn().mockResolvedValue({ removed: 0, errors: [] }),
  cancelSync: vi.fn().mockResolvedValue({ cancelled: true }),
  onSyncProgress: vi.fn().mockReturnValue(() => {}),
  getDeviceSyncInfo: vi.fn().mockResolvedValue(null),
  selectFolder: vi.fn().mockResolvedValue('/mnt/usb'),
  saveSession: vi.fn().mockResolvedValue(undefined),
  loadSession: vi.fn().mockResolvedValue(null),
  clearSession: vi.fn().mockResolvedValue(undefined),
}
beforeAll(() => { Object.defineProperty(window, 'api', { value: mockApi, writable: true }) })
afterEach(() => { vi.resetAllMocks() })

// PreviewData with all fields including new tracksCount, updatedCount, willRemoveCount
const samplePreviewDataNewTracks: PreviewData = {
  trackCount: 150,
  totalBytes: 5_000_000_000, // ~5 GB
  formatBreakdown: { flac: 3_000_000_000, mp3: 2_000_000_000 },
  newTracksCount: 120,
  newTracksBytes: 4_000_000_000,
  updatedTracksCount: 5,
  updatedTracksBytes: 400_000_000,
  willRemoveCount: 10,
  willRemoveBytes: 600_000_000,
}

const samplePreviewDataNoUpdates: PreviewData = {
  trackCount: 150,
  totalBytes: 5_000_000_000,
  formatBreakdown: { flac: 3_000_000_000, mp3: 2_000_000_000 },
  newTracksCount: 150,
  newTracksBytes: 5_000_000_000,
  updatedTracksCount: 0,
  updatedTracksBytes: 0,
  willRemoveCount: 0,
  willRemoveBytes: 0,
}

const defaultProps = {
  data: samplePreviewDataNewTracks,
  convertToMp3: false,
  bitrate: '320k' as Bitrate,
  onCancel: vi.fn(),
  onConfirm: vi.fn(),
}

describe('SyncPreviewModal', () => {
  // 1. shows new tracks count and size
  it('shows new tracks count and size when newTracksCount > 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />)
    expect(screen.getByTestId('preview-new-tracks-count')).toHaveTextContent('120')
    expect(screen.getByTestId('preview-new-tracks-size')).toHaveTextContent('3.73 GB')
  })

  it('does not show new tracks section when newTracksCount is 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={{ ...samplePreviewDataNoUpdates, newTracksCount: 0, newTracksBytes: 0 }} />)
    expect(screen.queryByTestId('preview-new-tracks-count')).not.toBeInTheDocument()
  })

  // 2. shows updated tracks count and size only if updatedTracksCount > 0
  it('shows updated tracks count and size when updatedTracksCount > 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />)
    expect(screen.getByTestId('preview-updated-tracks-count')).toHaveTextContent('5')
    expect(screen.getByTestId('preview-updated-tracks-size')).toHaveTextContent('0.37 GB')
  })

  it('does not show updated tracks section when updatedTracksCount is 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNoUpdates} />)
    expect(screen.queryByTestId('preview-updated-tracks-count')).not.toBeInTheDocument()
  })

  // 3. shows removed tracks count and size only if willRemoveCount > 0
  it('shows removed tracks count and size when willRemoveCount > 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />)
    expect(screen.getByTestId('preview-will-remove-count')).toHaveTextContent('10')
    expect(screen.getByTestId('preview-will-remove-size')).toHaveTextContent('0.56 GB')
  })

  it('does not show removed section when willRemoveCount is 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNoUpdates} />)
    expect(screen.queryByTestId('preview-will-remove-count')).not.toBeInTheDocument()
  })

  // 4. confirm calls onConfirm, cancel calls onCancel
  it('calls onConfirm when confirm button is clicked', async () => {
    const user = userEvent.setup({ delay: null })
    render(<SyncPreviewModal {...defaultProps} />)
    const confirmButton = screen.getByTestId('confirm-sync-button')
    await user.click(confirmButton)
    expect(defaultProps.onConfirm).toHaveBeenCalled()
  })

  it('calls onCancel when cancel button is clicked', async () => {
    const user = userEvent.setup({ delay: null })
    render(<SyncPreviewModal {...defaultProps} />)
    const cancelButton = screen.getByTestId('cancel-preview-button')
    await user.click(cancelButton)
    expect(defaultProps.onCancel).toHaveBeenCalled()
  })

  // 5. shows MP3 conversion info only if convertToMp3 = true
  it('shows MP3 conversion info when convertToMp3 is true', () => {
    render(<SyncPreviewModal {...defaultProps} convertToMp3={true} />)
    expect(screen.getByText(/FLAC\/lossless and other formats → MP3 320k/)).toBeInTheDocument()
  })

  it('does not show MP3 conversion info when convertToMp3 is false', () => {
    render(<SyncPreviewModal {...defaultProps} convertToMp3={false} />)
    expect(screen.queryByText(/FLAC\/lossless/)).not.toBeInTheDocument()
  })
})