// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { SyncSuccessModal } from './SyncSuccessModal';

interface SyncError {
  trackName: string;
  message: string;
  phase?: string;
}

const mockApi = {
  listUsbDevices: vi.fn().mockResolvedValue([]),
  getDeviceInfo: vi.fn().mockResolvedValue({ total: 32e9, free: 16e9, used: 16e9 }),
  getFilesystem: vi.fn().mockResolvedValue('exfat'),
  getSyncedItems: vi.fn().mockResolvedValue([]),
  analyzeDiff: vi.fn().mockResolvedValue({ success: true, items: [] }),
  estimateSize: vi.fn().mockResolvedValue({ trackCount: 0, totalBytes: 0, formatBreakdown: {} }),
  startSync2: vi.fn().mockResolvedValue({
    success: true,
    tracksCopied: 10,
    tracksSkipped: 5,
    errors: [] as SyncError[],
  }),
  removeItems: vi.fn().mockResolvedValue({ removed: 0, errors: [] }),
  cancelSync: vi.fn().mockResolvedValue({ cancelled: true }),
  onSyncProgress: vi.fn().mockReturnValue(() => {}),
  getDeviceSyncInfo: vi.fn().mockResolvedValue(null),
  selectFolder: vi.fn().mockResolvedValue('/mnt/usb'),
  saveSession: vi.fn().mockResolvedValue({ success: true }),
  loadSession: vi.fn().mockResolvedValue(null),
  clearSession: vi.fn().mockResolvedValue(undefined),
  openLogFolder: vi.fn().mockResolvedValue({ success: true }),
};
beforeAll(() => {
  Object.defineProperty(window, 'api', { value: mockApi, writable: true });
});
afterEach(() => {
  vi.resetAllMocks();
});

const defaultProps = {
  tracksCopied: 100,
  tracksSkipped: 20,
  tracksRetagged: 3,
  lyricsAdded: 2,
  removed: 5,
  errors: [] as SyncError[],
  onClose: vi.fn(),
};

describe('SyncSuccessModal', () => {
  // AC: success state shows counts
  it('shows tracks copied, skipped, and removed counts on success', () => {
    render(<SyncSuccessModal {...defaultProps} />);
    expect(screen.getByText('Copied:')).toBeInTheDocument();
    expect(screen.getByText('100 tracks')).toBeInTheDocument();
    expect(screen.getByText('Skipped (up-to-date):')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('Removed:')).toBeInTheDocument();
    expect(screen.getByText('5 items')).toBeInTheDocument();
  });

  // AC1: with 1, 5, and 50 errors all of them are readable, list has max-h-80
  // and overflow-y-auto. Popup never exceeds 90% of window height.
  describe('AC1 — all errors visible with scroll', () => {
    const counts = [1, 5, 50];
    for (const n of counts) {
      it(`renders all ${n} errors in the DOM with a scrollable container`, () => {
        const errors: SyncError[] = Array.from({ length: n }, (_, i) => ({
          trackName: `Track ${i}`,
          message: `Failure ${i}`,
        }));
        render(<SyncSuccessModal {...defaultProps} tracksCopied={0} errors={errors} />);

        // Every track name and message is in the DOM
        for (let i = 0; i < n; i++) {
          expect(screen.getByText(`Track ${i}`)).toBeInTheDocument();
          expect(screen.getByText(`Failure ${i}`)).toBeInTheDocument();
        }
        expect(screen.queryByText(/\+\d+ more/)).not.toBeInTheDocument();

        // The list container has max-h-80 + overflow-y-auto
        const list = screen.getByTestId('sync-errors-list');
        expect(list.className).toMatch(/max-h-80/);
        expect(list.className).toMatch(/overflow-y-auto/);
      });
    }
  });

  // AC2: track name on its own line, message on the next. A 200-char
  // unspaced string must wrap inside the modal width without horizontal
  // scroll or text overflow.
  it('AC2 — renders track name and message on separate lines and wraps a 200-char unspaced path', () => {
    const longPath =
      'file:C:\\Users\\dev\\AppData\\Local\\Temp\\jellytunes_conv_abc123def456ghi789jkl012mno345pqr678stu901vwx234yz.mp3: Invalid argument';
    // Pad to >= 200 chars to assert the wrap
    const message200 = (longPath + longPath).slice(0, 220);
    const errors: SyncError[] = [
      { trackName: 'Long Path Track', message: message200 },
      { trackName: 'Short', message: 'Disk full' },
    ];
    render(<SyncSuccessModal {...defaultProps} tracksCopied={0} errors={errors} />);

    // Track name and message for the long-path entry are in the DOM
    expect(screen.getByText('Long Path Track')).toBeInTheDocument();
    expect(screen.getByText(message200)).toBeInTheDocument();

    // The message container applies a wrapping class
    const messageEl = screen.getByText(message200);
    // Either break-words OR [overflow-wrap:anywhere] (Tailwind arbitrary value)
    const wraps = /break-words|overflow-wrap:anywhere|break-all/;
    // Look at the message container OR the message element itself
    const candidate = messageEl.closest('[data-testid="sync-error-message"]') ?? messageEl;
    expect(candidate.className).toMatch(wraps);
  });

  // AC3: when there are errors, a "Open log folder" button is shown and
  // clicking it calls the existing ORAIN-0727 IPC.
  it('AC3 — shows "Open log folder" button when errors are present and invokes openLogFolder on click', async () => {
    const user = userEvent.setup({ delay: null });
    const errors: SyncError[] = [{ trackName: 'T', message: 'oops' }];
    render(<SyncSuccessModal {...defaultProps} tracksCopied={0} errors={errors} />);

    const openBtn = screen.getByRole('button', { name: /open log folder/i });
    await user.click(openBtn);
    expect(window.api.openLogFolder).toHaveBeenCalledTimes(1);
  });

  it('AC3 — does NOT show "Open log folder" button on success (no errors)', () => {
    render(<SyncSuccessModal {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /open log folder/i })).not.toBeInTheDocument();
  });

  // Errors without a track name (global sync failure) render only the
  // message, no track-name header.
  it('renders a trackName="" error without a header line, only the message', () => {
    const errors: SyncError[] = [
      { trackName: '', message: 'Sync was cancelled by user' },
      { trackName: 'Real', message: 'oops' },
    ];
    render(<SyncSuccessModal {...defaultProps} tracksCopied={0} errors={errors} />);

    expect(screen.getByText('Sync was cancelled by user')).toBeInTheDocument();
    // Header for the empty-trackName entry must NOT be rendered as a name
    expect(screen.queryByTestId('sync-error-header')).toHaveTextContent('Real');
  });

  // close calls onClose
  it('calls onClose when close button is clicked', async () => {
    const user = userEvent.setup({ delay: null });
    render(<SyncSuccessModal {...defaultProps} />);
    const closeButton = screen.getByRole('button', { name: 'Close' });
    await user.click(closeButton);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  // ORAIN-0752 AC1: failed title uses the text-error token and the ⚠
  // icon (NOT the ✗ glyph — that looked like a window-close control next
  // to the title).
  it('AC1 — "Sync failed" title uses text-error class and shows the ⚠ icon', () => {
    render(
      <SyncSuccessModal
        {...defaultProps}
        // ORAIN-0766: a "pure failed" sync has no progress (neither copied
        // nor up-to-date). With tracksSkipped=0 here, the modal renders
        // the "Sync failed" title (not the partial-success one).
        tracksCopied={0}
        tracksSkipped={0}
        tracksRetagged={0}
        errors={[{ trackName: 'T', message: 'oops' }]}
      />,
    );
    const title = screen.getByRole('heading', { name: /sync failed/i });
    expect(title.className).toMatch(/text-error/);
    const icon = screen.getByTestId('sync-failed-icon');
    expect(icon.textContent).toBe('⚠');
    // The icon shares the title's red so the failure header reads as one unit.
    expect(icon.className).toMatch(/text-error/);
    // Regression guard: the old glyph must not appear next to the title
    // in the failed state — it is what made the modal look like a
    // window-close control.
    expect(screen.queryByText('✗')).not.toBeInTheDocument();
  });

  // ORAIN-0752 AC2: failed-state track names use text-error + font-medium
  // for contrast against surface_container_low (#cf6679 on #1a1a27 ≈ 4.8:1).
  // The message text below stays on_surface_variant by design — the user
  // explicitly chose not to color the message text to avoid "too much red".
  it('AC2 — failed-state track name uses text-error + font-medium; message stays on_surface_variant', () => {
    render(
      <SyncSuccessModal
        {...defaultProps}
        tracksCopied={0}
        errors={[
          { trackName: 'Track A', message: 'disk full' },
          { trackName: 'Track B', message: 'permission denied' },
        ]}
      />,
    );
    const headers = screen.getAllByTestId('sync-error-header');
    expect(headers).toHaveLength(2);
    for (const h of headers) {
      expect(h.className).toMatch(/text-error/);
      expect(h.className).toMatch(/font-medium/);
    }
    const messages = screen.getAllByTestId('sync-error-message');
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m.className).toMatch(/text-on_surface_variant/);
      expect(m.className).not.toMatch(/text-error/);
    }
  });
});

// =============================================================================
// ORAIN-0766 — partial-success modal state
// AC1: when a sync ends with at least one track copied OR up-to-date AND
//      at least one failure, the popup title is "Sync completed with errors"
//      and it surfaces BOTH the counters (Copied, Up to date, Failed) AND
//      the error list. Without this state, the user reads "Sync failed"
//      and assumes nothing synced (the GitHub #27 confusion).
// AC2: "Sync failed" only when no track copied nor up-to-date, OR a global
//      error (destination unreachable, server fetch failure).
// =============================================================================
describe('ORAIN-0766 — partial-success state', () => {
  it('AC1 — partial sync (some tracks copied, some failed) shows "Sync completed with errors" title AND counters AND errors', () => {
    render(
      <SyncSuccessModal
        {...defaultProps}
        tracksCopied={535}
        tracksSkipped={22647}
        tracksRetagged={0}
        lyricsAdded={0}
        removed={0}
        errors={[
          { trackName: 'Track A', message: 'permission denied' },
          { trackName: 'Track B', message: 'disk full' },
        ]}
      />,
    );

    // AC1: the title is the new "completed with errors" string, NOT
    // "Sync complete" or "Sync failed".
    expect(
      screen.getByRole('heading', { name: /sync completed with errors/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^sync complete$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^sync failed$/i })).not.toBeInTheDocument();

    // AC1: the counters are visible (Copied, Up to date, Failed)
    expect(screen.getByText(/copied:/i)).toBeInTheDocument();
    expect(screen.getByText('535 tracks')).toBeInTheDocument();
    expect(screen.getByText(/skipped \(up-to-date\):/i)).toBeInTheDocument();
    expect(screen.getByText('22647')).toBeInTheDocument();
    expect(screen.getByText(/errors:/i)).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    // AC1: the error list is also visible below the counters
    expect(screen.getByText('Track A')).toBeInTheDocument();
    expect(screen.getByText('permission denied')).toBeInTheDocument();
    expect(screen.getByText('Track B')).toBeInTheDocument();
    expect(screen.getByText('disk full')).toBeInTheDocument();
  });

  it('AC1 — partial sync (some tracks up-to-date, some failed, none copied) also shows "Sync completed with errors"', () => {
    // Edge: tracksCopied=0 but tracksSkipped>0 → still a partial sync.
    render(
      <SyncSuccessModal
        {...defaultProps}
        tracksCopied={0}
        tracksSkipped={100}
        tracksRetagged={0}
        lyricsAdded={0}
        removed={0}
        errors={[{ trackName: 'Track X', message: 'oops' }]}
      />,
    );

    expect(
      screen.getByRole('heading', { name: /sync completed with errors/i }),
    ).toBeInTheDocument();
  });

  it('AC2 — "Sync failed" stays when no track copied AND no track up-to-date (pure failure)', () => {
    render(
      <SyncSuccessModal
        {...defaultProps}
        tracksCopied={0}
        tracksSkipped={0}
        tracksRetagged={0}
        lyricsAdded={0}
        removed={0}
        errors={[
          { trackName: 'Track A', message: 'permission denied' },
          { trackName: 'Track B', message: 'disk full' },
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: /sync failed/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /sync completed with errors/i }),
    ).not.toBeInTheDocument();
  });

  it('AC2 — "Sync failed" stays on a global error (trackName="" with no counter progress)', () => {
    // Global sync failure: destination unreachable, server fetch error.
    render(
      <SyncSuccessModal
        {...defaultProps}
        tracksCopied={0}
        tracksSkipped={0}
        tracksRetagged={0}
        lyricsAdded={0}
        removed={0}
        errors={[{ trackName: '', message: 'Sync was cancelled by user' }]}
      />,
    );

    expect(screen.getByRole('heading', { name: /sync failed/i })).toBeInTheDocument();
  });
});
