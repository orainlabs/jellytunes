// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { formatBytes, formatDuration } from '../utils/format';
import { SyncPreviewModal } from './SyncPreviewModal';
import type { PreviewData, ItemPreview, Bitrate } from '../appTypes';

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
  saveSession: vi.fn().mockResolvedValue(undefined),
  loadSession: vi.fn().mockResolvedValue(null),
  clearSession: vi.fn().mockResolvedValue(undefined),
};
beforeAll(() => {
  Object.defineProperty(window, 'api', { value: mockApi, writable: true });
});
afterEach(() => {
  vi.resetAllMocks();
});

// PreviewData with all fields including new tracksCount, updatedCount, willRemoveCount
// Extended PreviewData type for app-level tests
interface PreviewDataWithItems extends PreviewData {
  removedItems: ItemPreview[];
  newItems: ItemPreview[];
  updatedItems: ItemPreview[];
  alreadySyncedItems: ItemPreview[];
}

const samplePreviewDataNewTracks: PreviewData = {
  trackCount: 150,
  totalBytes: 5_000_000_000, // ~5 GB
  totalDurationSeconds: 18000, // 5 hours
  formatBreakdown: { flac: 3_000_000_000, mp3: 2_000_000_000 },
  newTracksCount: 120,
  newTracksBytes: 4_000_000_000,
  updatedTracksCount: 5,
  updatedTracksBytes: 400_000_000,
  alreadySyncedCount: 25,
  alreadySyncedBytes: 600_000_000,
  willRemoveCount: 47,
  willRemoveBytes: 800_000_000,
};

const samplePreviewDataNoUpdates: PreviewData = {
  trackCount: 150,
  totalBytes: 5_000_000_000,
  totalDurationSeconds: 9000, // 2.5 hours
  formatBreakdown: { flac: 3_000_000_000, mp3: 2_000_000_000 },
  newTracksCount: 150,
  newTracksBytes: 5_000_000_000,
  updatedTracksCount: 0,
  updatedTracksBytes: 0,
  alreadySyncedCount: 0,
  alreadySyncedBytes: 0,
  willRemoveCount: 0,
  willRemoveBytes: 0,
};

// Extended data with per-item breakdown
const samplePreviewDataWithItems: PreviewDataWithItems = {
  ...samplePreviewDataNewTracks,
  removedItems: [
    { id: 'a1', name: 'Eraserhead', trackCount: 47, sizeBytes: 800_000_000, durationSeconds: 4200 },
  ],
  newItems: [
    { id: 'a2', name: 'Radiohead', trackCount: 16, sizeBytes: 118_000_000, durationSeconds: 4200 },
  ],
  updatedItems: [
    { id: 'a3', name: 'M83', trackCount: 3, sizeBytes: 50_000_000, durationSeconds: 900 },
  ],
  alreadySyncedItems: [
    { id: 'a4', name: 'Daft Punk', trackCount: 25, sizeBytes: 600_000_000, durationSeconds: 9000 },
  ],
};

const defaultProps = {
  data: samplePreviewDataNewTracks,
  convertToMp3: false,
  bitrate: '320k' as Bitrate,
  onCancel: vi.fn(),
  onConfirm: vi.fn(),
};

describe('SyncPreviewModal', () => {
  // 1. shows new tracks count and size
  it('shows new tracks count and size when newTracksCount > 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />);
    expect(screen.getByTestId('preview-new-tracks-count')).toHaveTextContent('120');
    expect(screen.getByTestId('preview-new-tracks-size')).toHaveTextContent('4.0 GB');
  });

  it('does not show new tracks section when newTracksCount is 0', () => {
    render(
      <SyncPreviewModal
        {...defaultProps}
        data={{ ...samplePreviewDataNoUpdates, newTracksCount: 0, newTracksBytes: 0 }}
      />,
    );
    expect(screen.queryByTestId('preview-new-tracks-count')).not.toBeInTheDocument();
  });

  // 2. shows updated tracks count and size only if updatedTracksCount > 0
  it('shows updated tracks count and size when updatedTracksCount > 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />);
    expect(screen.getByTestId('preview-updated-tracks-count')).toHaveTextContent('5');
    expect(screen.getByTestId('preview-updated-tracks-size')).toHaveTextContent('400 MB');
  });

  it('does not show updated tracks section when updatedTracksCount is 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNoUpdates} />);
    expect(screen.queryByTestId('preview-updated-tracks-count')).not.toBeInTheDocument();
  });

  // 3. shows removed tracks count and size only if willRemoveCount > 0
  it('shows removed tracks count and size when willRemoveCount > 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />);
    expect(screen.getByTestId('preview-will-remove-count')).toHaveTextContent('47');
    expect(screen.getByTestId('preview-will-remove-size')).toHaveTextContent('800 MB');
  });

  it('does not show removed section when willRemoveCount is 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNoUpdates} />);
    expect(screen.queryByTestId('preview-will-remove-count')).not.toBeInTheDocument();
  });

  // AC1: will remove shows track count not item count
  it('shows "Will remove X tracks" label when removedItems present', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataWithItems} />);
    expect(screen.getByTestId('preview-will-remove-count')).toHaveTextContent('47');
    // Text is split across spans, match partially
    expect(
      screen.getByText((content) => content.includes('Will remove') && content.includes('tracks')),
    ).toBeInTheDocument();
  });

  it('shows artist name in "will remove" section', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataWithItems} />);
    expect(screen.getByText((content) => content.includes('Eraserhead'))).toBeInTheDocument();
  });

  it('shows "Will remove 1 track" with singular for single track', () => {
    const singleItem: PreviewData = {
      ...samplePreviewDataNewTracks,
      willRemoveCount: 1,
      willRemoveBytes: 20_000_000,
      removedItems: [
        {
          id: 'a1',
          name: 'Test Artist',
          trackCount: 1,
          sizeBytes: 20_000_000,
          durationSeconds: 180,
        },
      ],
    };
    render(<SyncPreviewModal {...defaultProps} data={singleItem} />);
    expect(
      screen.getByText((content) => content.includes('Will remove') && content.includes('track')),
    ).toBeInTheDocument();
  });

  it('shows per-item breakdown for new items with track count, size, and duration', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataWithItems} />);
    // Use test IDs for unambiguous checks
    expect(screen.getByTestId('preview-new-tracks-section')).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('Radiohead'))).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('16 tracks'))).toBeInTheDocument();
    expect(
      screen.getByText((content) => content.includes('118') && content.includes('MB')),
    ).toBeInTheDocument();
  });

  it('shows per-item breakdown for updated items', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataWithItems} />);
    expect(screen.getByText((content) => content.includes('M83'))).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('3 tracks'))).toBeInTheDocument();
  });

  it('shows per-item breakdown for already-synced items', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataWithItems} />);
    expect(screen.getByText((content) => content.includes('Daft Punk'))).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('25 tracks'))).toBeInTheDocument();
  });

  // AC3 + AC4: total row uses same format and is integrated in the list
  it('shows total row at bottom of list with same format as items', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataWithItems} />);
    expect(screen.getByTestId('preview-total-row')).toBeInTheDocument();
    const text = screen.getByTestId('preview-total-row').textContent || '';
    expect(text).toContain('Total');
    // Total row contains track count and bytes (deduplicated track count = 150)
    expect(text).toContain('150');
    expect(text).toContain(formatBytes(samplePreviewDataWithItems.totalBytes));
    // Total row contains duration
    expect(text).toContain(formatDuration(samplePreviewDataWithItems.totalDurationSeconds));
  });

  // 4. confirm calls onConfirm, cancel calls onCancel
  it('calls onConfirm when confirm button is clicked', async () => {
    const user = userEvent.setup({ delay: null });
    render(<SyncPreviewModal {...defaultProps} />);
    const confirmButton = screen.getByTestId('confirm-sync-button');
    await user.click(confirmButton);
    // Flush React state updates from the click
    await act(async () => {});
    expect(defaultProps.onConfirm).toHaveBeenCalled();
  });
  it('calls onCancel when cancel button is clicked', async () => {
    const user = userEvent.setup({ delay: null });
    render(<SyncPreviewModal {...defaultProps} />);
    const cancelButton = screen.getByTestId('cancel-preview-button');
    await user.click(cancelButton);
    expect(defaultProps.onCancel).toHaveBeenCalled();
  });

  // 5. shows MP3 conversion info only if convertToMp3 = true
  it('shows MP3 conversion info when convertToMp3 is true', () => {
    render(<SyncPreviewModal {...defaultProps} convertToMp3={true} />);
    expect(screen.getByText(/FLAC\/lossless → MP3 320k/)).toBeInTheDocument();
  });

  it('does not show MP3 conversion info when convertToMp3 is false', () => {
    render(<SyncPreviewModal {...defaultProps} convertToMp3={false} />);
    expect(screen.queryByText(/FLAC\/lossless/)).not.toBeInTheDocument();
  });

  // 6. shows track count summary and duration
  it('shows track count summary with plural form', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />);
    expect(screen.getByTestId('preview-track-count')).toHaveTextContent('150 tracks');
  });

  it('shows singular "track" for single track count', () => {
    const singleTrackData = {
      ...samplePreviewDataNoUpdates,
      trackCount: 1,
      totalDurationSeconds: 0,
    };
    render(<SyncPreviewModal {...defaultProps} data={singleTrackData} />);
    expect(screen.getByTestId('preview-track-count')).toHaveTextContent('1 track');
  });

  it('shows duration when totalDurationSeconds > 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />);
    // 18000 seconds = 5:00:00
    expect(screen.getByTestId('preview-duration')).toHaveTextContent('5:00:00');
  });

  it('does not show duration when totalDurationSeconds is 0', () => {
    const noDurationData = { ...samplePreviewDataNoUpdates, totalDurationSeconds: 0 };
    render(<SyncPreviewModal {...defaultProps} data={noDurationData} />);
    expect(screen.queryByTestId('preview-duration')).not.toBeInTheDocument();
  });
});
