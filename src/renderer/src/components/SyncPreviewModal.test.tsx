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
  newTracksDurationSeconds: 10800, // 3 hours
  updatedTracksCount: 5,
  updatedTracksBytes: 400_000_000,
  updatedTracksDurationSeconds: 900, // 15 minutes
  alreadySyncedCount: 25,
  alreadySyncedBytes: 600_000_000,
  alreadySyncedDurationSeconds: 6300, // 1h 45m
  willRemoveCount: 47,
  willRemoveBytes: 800_000_000,
  willRemoveDurationSeconds: 4200, // 1h 10m
};

const samplePreviewDataNoUpdates: PreviewData = {
  trackCount: 150,
  totalBytes: 5_000_000_000,
  totalDurationSeconds: 9000, // 2.5 hours
  formatBreakdown: { flac: 3_000_000_000, mp3: 2_000_000_000 },
  newTracksCount: 150,
  newTracksBytes: 5_000_000_000,
  newTracksDurationSeconds: 9000,
  updatedTracksCount: 0,
  updatedTracksBytes: 0,
  updatedTracksDurationSeconds: 0,
  alreadySyncedCount: 0,
  alreadySyncedBytes: 0,
  alreadySyncedDurationSeconds: 0,
  willRemoveCount: 0,
  willRemoveBytes: 0,
  willRemoveDurationSeconds: 0,
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
  // 1. Section header uses three-column layout: tracks · duration · size

  it('shows new tracks header with three-column layout (tracks · duration · size)', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />);
    const section = screen.getByTestId('preview-new-tracks-section');
    const text = section.textContent || '';
    expect(text).toContain('New tracks');
    expect(text).toContain('120 tracks');
    expect(text).toContain(formatDuration(10800));
    expect(text).toContain(formatBytes(4_000_000_000));
  });

  it('shows updated tracks header with three-column layout', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />);
    const section = screen.getByTestId('preview-updated-tracks-section');
    const text = section.textContent || '';
    expect(text).toContain('Will update');
    expect(text).toContain('5 tracks');
    expect(text).toContain(formatDuration(900));
    expect(text).toContain(formatBytes(400_000_000));
  });

  it('shows will remove header with three-column layout and negative values', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />);
    const section = screen.getByTestId('preview-will-remove-section');
    const text = section.textContent || '';
    expect(text).toContain('Will remove');
    expect(text).toContain('47 tracks');
    expect(text).toContain('−' + formatBytes(800_000_000));
  });

  it('shows already synced header with three-column layout', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />);
    const section = screen.getByTestId('preview-already-synced-section');
    const text = section.textContent || '';
    expect(text).toContain('Already on device');
    expect(text).toContain('25 tracks');
    expect(text).toContain(formatDuration(6300));
    expect(text).toContain(formatBytes(600_000_000));
  });

  // 2. Column values are vertically aligned (all use ThreeColumns component)

  it('does not have parentheses around size in new tracks section', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} />);
    const section = screen.getByTestId('preview-new-tracks-section');
    // ThreeColumns renders: <span className="font-medium">tracks</span>
    // followed by optional duration, then size — no parentheses anywhere
    const text = section.textContent || '';
    expect(text).not.toMatch(/\(\d/);
  });


  it('hides duration in section header when duration is 0', () => {
    const data = { ...samplePreviewDataNewTracks, alreadySyncedDurationSeconds: 0 };
    render(<SyncPreviewModal {...defaultProps} data={data} />);
    const section = screen.getByTestId('preview-already-synced-section');
    const header = section.querySelector('.flex.justify-between');
    expect(header?.textContent).not.toContain('0:00');
  });


  // 4. Total row uses same three-column layout

  it('shows total row with three-column layout', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataWithItems} />);
    expect(screen.getByTestId('preview-total-row')).toBeInTheDocument();
    const text = screen.getByTestId('preview-total-row').textContent || '';
    expect(text).toContain('Total');
    expect(text).toContain('150 tracks');
    expect(text).toContain(formatDuration(samplePreviewDataWithItems.totalDurationSeconds));
    expect(text).toContain(formatBytes(samplePreviewDataWithItems.totalBytes));
  });


  it('shows total row when only willRemoveCount > 0', () => {
    const deleteOnlyData: PreviewData = {
      trackCount: 0,
      totalBytes: 0,
      totalDurationSeconds: 0,
      formatBreakdown: {},
      newTracksCount: 0,
      newTracksBytes: 0,
      newTracksDurationSeconds: 0,
      updatedTracksCount: 0,
      updatedTracksBytes: 0,
      updatedTracksDurationSeconds: 0,
      alreadySyncedCount: 0,
      alreadySyncedBytes: 0,
      alreadySyncedDurationSeconds: 0,
      willRemoveCount: 47,
      willRemoveBytes: 800_000_000,
      willRemoveDurationSeconds: 4200,
    };
    render(<SyncPreviewModal {...defaultProps} data={deleteOnlyData} />);
    expect(screen.getByTestId('preview-total-row')).toBeInTheDocument();
  });

  // 5. Will remove section header uses ThreeColumns: "Will remove" + "47 tracks"

  it('shows will remove section with three-column header', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataWithItems} />);
    const section = screen.getByTestId('preview-will-remove-section');
    expect(section.textContent).toContain('Will remove');
    expect(section.textContent).toContain('47 tracks');
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
    const section = screen.getByTestId('preview-will-remove-section');
    // Header contains "Will remove" label and "1 track" in ThreeColumns
    expect(section.textContent).toContain('Will remove');
    expect(section.textContent).toContain('1 track');
  });

  // 6. Sections hidden when count is 0

  it('does not show new tracks section when newTracksCount is 0', () => {
    render(
      <SyncPreviewModal
        {...defaultProps}
        data={{ ...samplePreviewDataNoUpdates, newTracksCount: 0, newTracksBytes: 0 }}
      />,
    );
    expect(screen.queryByTestId('preview-new-tracks-section')).not.toBeInTheDocument();
  });

  it('does not show updated tracks section when updatedTracksCount is 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNoUpdates} />);
    expect(screen.queryByTestId('preview-updated-tracks-section')).not.toBeInTheDocument();
  });

  it('does not show removed section when willRemoveCount is 0', () => {
    render(<SyncPreviewModal {...defaultProps} data={samplePreviewDataNoUpdates} />);
    expect(screen.queryByTestId('preview-will-remove-section')).not.toBeInTheDocument();
  });

  // 7. Confirm calls onConfirm, cancel calls onCancel

  it('calls onConfirm when confirm button is clicked', async () => {
    const user = userEvent.setup({ delay: null });
    render(<SyncPreviewModal {...defaultProps} />);
    const confirmButton = screen.getByTestId('confirm-sync-button');
    await user.click(confirmButton);
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

  // 8. MP3 conversion info

  it('shows MP3 conversion info when convertToMp3 is true', () => {
    render(<SyncPreviewModal {...defaultProps} convertToMp3={true} />);
    expect(screen.getByText(/FLAC\/lossless → MP3 320k/)).toBeInTheDocument();
  });

  it('does not show MP3 conversion info when convertToMp3 is false', () => {
    render(<SyncPreviewModal {...defaultProps} convertToMp3={false} />);
    expect(screen.queryByText(/FLAC\/lossless/)).not.toBeInTheDocument();
  });

  // 9. MP3 tilde prefix for estimated sizes

  it('shows tilde prefix for new tracks size when convertToMp3 is true', () => {
    render(
      <SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} convertToMp3={true} />,
    );
    const section = screen.getByTestId('preview-new-tracks-section');
    const text = section.textContent || '';
    expect(text).toContain('~4.0 GB');
  });

  it('does not show tilde prefix when convertToMp3 is false', () => {
    render(
      <SyncPreviewModal {...defaultProps} data={samplePreviewDataNewTracks} convertToMp3={false} />,
    );
    const section = screen.getByTestId('preview-new-tracks-section');
    const text = section.textContent || '';
    expect(text).not.toContain('~');
    expect(text).toContain('4.0 GB');
  });


});
