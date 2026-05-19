// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { SyncSuccessModal } from './SyncSuccessModal'

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
  saveSession: vi.fn().mockResolvedValue({ success: true }),
  loadSession: vi.fn().mockResolvedValue(null),
  clearSession: vi.fn().mockResolvedValue(undefined),
}
beforeAll(() => { Object.defineProperty(window, 'api', { value: mockApi, writable: true }) })
afterEach(() => { vi.resetAllMocks() })

const defaultProps = {
  tracksCopied: 100,
  tracksSkipped: 20,
  tracksRetagged: 3,
  lyricsAdded: 2,
  removed: 5,
  errors: [] as string[],
  onClose: vi.fn(),
}

describe('SyncSuccessModal', () => {
  // 1. success: shows tracks copied/skipped/removed
  it('shows tracks copied, skipped, and removed counts on success', () => {
    render(<SyncSuccessModal {...defaultProps} />)
    expect(screen.getByText('Copied:')).toBeInTheDocument()
    expect(screen.getByText('100 tracks')).toBeInTheDocument()
    expect(screen.getByText('Skipped (up-to-date):')).toBeInTheDocument()
    expect(screen.getByText('20')).toBeInTheDocument()
    expect(screen.getByText('Removed:')).toBeInTheDocument()
    expect(screen.getByText('5 items')).toBeInTheDocument()
  })

  // 2. failure: shows errors (max 3 + "+N more")
  it('shows errors with max 3 displayed and "+N more" for additional errors', () => {
    const manyErrors = [
      'Error: File not found',
      'Error: Permission denied',
      'Error: Disk full',
      'Error: Network timeout',
      'Error: Unknown error',
    ]
    render(<SyncSuccessModal {...defaultProps} tracksCopied={0} errors={manyErrors} />)
    expect(screen.getByText('Error: File not found')).toBeInTheDocument()
    expect(screen.getByText('Error: Permission denied')).toBeInTheDocument()
    expect(screen.getByText('Error: Disk full')).toBeInTheDocument()
    expect(screen.getByText('+2 more')).toBeInTheDocument()
    expect(screen.queryByText('Error: Network timeout')).not.toBeInTheDocument()
  })

  // 3. close calls onClose
  it('calls onClose when close button is clicked', async () => {
    const user = userEvent.setup({ delay: null })
    render(<SyncSuccessModal {...defaultProps} />)
    const closeButton = screen.getByRole('button', { name: 'Close' })
    await user.click(closeButton)
    expect(defaultProps.onClose).toHaveBeenCalled()
  })
})
