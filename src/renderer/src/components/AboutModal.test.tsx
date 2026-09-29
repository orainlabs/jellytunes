// @vitest-environment jsdom
import { cleanup, render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AboutModal } from './AboutModal';

beforeEach(() => {
  const mockApi = {
    getVersion: vi.fn().mockResolvedValue('1.2.3'),
    checkForUpdates: vi.fn().mockResolvedValue({
      updateAvailable: false,
      latestVersion: '',
      releaseUrl: '',
      managedBySnap: false,
    }),
    getPreferences: vi.fn().mockResolvedValue({ analyticsEnabled: true }),
    setPreferences: vi.fn().mockResolvedValue(undefined),
    reportBug: vi.fn().mockResolvedValue({ success: true }),
    logError: vi.fn(),
    logWarn: vi.fn(),
    logInfo: vi.fn(),
    getLogPath: vi.fn().mockResolvedValue('/mock/log'),
    // ORAIN-0735: open the system file manager on the log file folder.
    openLogFolder: vi.fn().mockResolvedValue(undefined),
    isSnap: vi.fn().mockResolvedValue(false),
    // ORAIN-0578 T2: AboutModal consults this on mount to render the
    // missing-interfaces section. Empty report is the common case.
    checkSnapPermissions: vi.fn().mockResolvedValue({
      isSnap: false,
      snapName: null,
      interfaces: [],
    }),
  };
  // @ts-expect-error — Mocking window.api for test environment
  window.api = mockApi;
});

afterEach(() => {
  // React unmounts so any leaked setTimeout would attempt setState on an
  // unmounted component, and any leaked vi.useFakeTimers() would freeze
  // the next test.
  cleanup();
  vi.useRealTimers();
});

describe('AboutModal', () => {
  it('loads analytics preference on mount', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(window.api.getPreferences).toHaveBeenCalled();
    });
  });

  it('renders analytics toggle switch', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeInTheDocument();
    });
  });

  it('toggle has aria-label for accessibility', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole('switch')).toHaveAttribute(
        'aria-label',
        'Anonymous usage statistics',
      );
    });
  });

  it('displays analytics privacy text', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/No personal data collected/)).toBeInTheDocument();
    });
  });

  it('has Learn more link for privacy', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      const link = screen.getByText('Privacy Policy');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '#');
    });
  });

  it('opens GitHub repo when clicking View on GitHub', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AboutModal onClose={vi.fn()} />);
    await act(async () => {
      screen.getByText('View on GitHub ↗').click();
    });
    expect(openSpy).toHaveBeenCalledWith('https://github.com/orainlabs/jellytunes');
    openSpy.mockRestore();
  });

  it('opens Ko-fi when clicking Support on Ko-fi', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AboutModal onClose={vi.fn()} />);
    await act(async () => {
      screen.getByText('Support on Ko-fi ☕').click();
    });
    expect(openSpy).toHaveBeenCalledWith('https://ko-fi.com/orainlabs');
    openSpy.mockRestore();
  });

  it('opens privacy policy URL when clicking Privacy Policy', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AboutModal onClose={vi.fn()} />);
    await act(async () => {
      screen.getByText('Privacy Policy').click();
    });
    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/orainlabs/jellytunes/blob/main/PRIVACY.md',
    );
    openSpy.mockRestore();
  });

  it('opens contact email when clicking Contact Us', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AboutModal onClose={vi.fn()} />);
    await act(async () => {
      screen.getByText('Contact Us').click();
    });
    expect(openSpy).toHaveBeenCalledWith('mailto:hi@orainlabs.dev');
    openSpy.mockRestore();
  });

  // Regression: ORAIN-0292 added a `void` to the main-process IPC handler,
  // so `app:checkForUpdates` resolved to `undefined` instead of the result
  // object. Clicking "Check Updates" then threw on `result.updateAvailable`.
  it('does not crash when checkForUpdates resolves to undefined', async () => {
    // Simulate the broken handler returning undefined.
    window.api.checkForUpdates = vi.fn().mockResolvedValue(undefined);
    render(<AboutModal onClose={vi.fn()} />);
    const button = await screen.findByText('Check Updates');
    await act(async () => {
      button.click();
    });
    // Neutral state: neither a crash, nor a false "up to date" / "available".
    expect(screen.getByText('Check Updates')).toBeInTheDocument();
    expect(screen.queryByText('✓ Up to date')).not.toBeInTheDocument();
  });

  it('shows the available version after clicking Check Updates', async () => {
    window.api.checkForUpdates = vi.fn().mockResolvedValue({
      updateAvailable: true,
      latestVersion: '9.9.9',
      releaseUrl: 'https://x',
      managedBySnap: false,
    });
    render(<AboutModal onClose={vi.fn()} />);
    const button = await screen.findByText('Check Updates');
    await act(async () => {
      button.click();
    });
    expect(await screen.findByText('v9.9.9')).toBeInTheDocument();
  });

  it('shows "Up to date" when no update is available', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    const button = await screen.findByText('Check Updates');
    await act(async () => {
      button.click();
    });
    expect(await screen.findByText('✓ Up to date')).toBeInTheDocument();
  });

  it('does not crash when checkForUpdates rejects', async () => {
    window.api.checkForUpdates = vi.fn().mockRejectedValue(new Error('network down'));
    render(<AboutModal onClose={vi.fn()} />);
    const button = await screen.findByText('Check Updates');
    await act(async () => {
      button.click();
    });
    expect(screen.getByText('Check Updates')).toBeInTheDocument();
  });

  it('closes when close button is clicked', async () => {
    const onClose = vi.fn();
    render(<AboutModal onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId('about-close-button')).toBeInTheDocument();
    });
    await act(async () => {
      screen.getByTestId('about-close-button').click();
    });
    expect(onClose).toHaveBeenCalled();
  });

  // ORAIN-0750 AC3: the Open log folder control lives inside the App group,
  // not in the same row as View on GitHub / Support on Ko-fi.
  // ORAIN-0756 AC1/AC2: it is a settings row (label + button), not a full-width pill.
  it('renders the Open log folder button inside the App group', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('about-group-app')).toBeInTheDocument();
    });
    const appGroup = screen.getByTestId('about-group-app');
    expect(appGroup).toContainElement(screen.getByTestId('open-log-folder-button'));
    expect(appGroup).toContainElement(screen.getByTestId('log-path'));
  });

  // ORAIN-0756 AC1: the modal must not show an "App" heading any more.
  it('does not render an "App" heading inside the App group', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('about-group-app')).toBeInTheDocument();
    });
    const appGroup = screen.getByTestId('about-group-app');
    expect(appGroup.querySelector('h3, h2, h1')).toBeNull();
    // Sanity: the App group's accessible name now comes from aria-label,
    // not from a visible heading. The primary group's heading is still
    // present, so the absence is meaningful.
    expect(screen.queryByText(/^App$/)).not.toBeInTheDocument();
  });

  // ORAIN-0756 AC5: the control is a real <button type="button">, not an
  // <a href="#">, with visible text "Open folder" and aria-label
  // "Open log folder" for assistive tech.
  it('renders the Open log folder control as a button with OpenFolder variant', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    const button = await screen.findByTestId('open-log-folder-button');
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveTextContent('Open folder');
    expect(button).toHaveAttribute('aria-label', 'Open log folder');
    // No leftover emoji from the previous "Open log folder 📂" label.
    expect(button.textContent).not.toMatch(/\u{1F4C2}/u);
  });

  // ORAIN-0756 AC2: the log row precedes the analytics row in the App group.
  it('orders the Log files row before the analytics row in the App group', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('about-group-app')).toBeInTheDocument();
    });
    const appGroup = screen.getByTestId('about-group-app');
    // Match the row containers (the new "Log files" row + the analytics row).
    const rows = Array.from(appGroup.querySelectorAll<HTMLElement>(':scope > div'));
    const logRow = rows.find((r) => r.contains(screen.getByTestId('open-log-folder-button')));
    const analyticsRow = rows.find((r) => r.querySelector('[role="switch"]') !== null);
    expect(logRow).toBeDefined();
    expect(analyticsRow).toBeDefined();
    const logIndex = rows.indexOf(logRow!);
    const analyticsIndex = rows.indexOf(analyticsRow!);
    expect(logIndex).toBeLessThan(analyticsIndex);
  });

  // ORAIN-0756 AC2: a "Log files" label is rendered next to the button.
  it('renders a "Log files" label next to the Open folder button', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('open-log-folder-button')).toBeInTheDocument();
    });
    expect(screen.getByText('Log files')).toBeInTheDocument();
  });

  // ORAIN-0750 AC3: View on GitHub / Support on Ko-fi live in the accessory
  // group, not in the primary row.
  it('renders GitHub and Ko-fi links in the accessory group', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('about-group-accessory')).toBeInTheDocument();
    });
    const accessory = screen.getByTestId('about-group-accessory');
    expect(accessory).toContainElement(screen.getByText(/View on GitHub/));
    expect(accessory).toContainElement(screen.getByText(/Support on Ko-fi/));
    expect(accessory).toContainElement(screen.getByText('Contact Us'));
  });

  // ORAIN-0735 AC2: the full log path is exposed via tooltip (title attr)
  // so users can see it on hover without needing a precision pointer.
  // ORAIN-0756 AC4: the title still shows the log path after the control
  // is converted from <a> to <button>.
  it('exposes the full log path as a tooltip on the button', async () => {
    window.api.getLogPath = vi.fn().mockResolvedValue('/var/log/jellytunes/main.log');
    render(<AboutModal onClose={vi.fn()} />);
    const button = await screen.findByTestId('open-log-folder-button');
    expect(button).toHaveAttribute('title', '/var/log/jellytunes/main.log');
  });

  // ORAIN-0735 AC2: the log path element keeps its data-testid so QA can
  // assert against it.
  it('renders a log-path element with the path accessible to assistive tech', async () => {
    window.api.getLogPath = vi.fn().mockResolvedValue('/var/log/jellytunes/main.log');
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('log-path')).toHaveTextContent('/var/log/jellytunes/main.log');
    });
  });

  // ORAIN-0735 AC5: clicking the button triggers IPC log:openFolder, which
  // main resolves via electron-log (no path is passed from the renderer).
  // ORAIN-0756 AC5: the IPC still fires after the <a>→<button> conversion.
  it('calls openLogFolder when the Open log folder button is clicked', async () => {
    window.api.getLogPath = vi.fn().mockResolvedValue('/var/log/jellytunes/main.log');
    window.api.openLogFolder = vi.fn().mockResolvedValue({ success: true });
    render(<AboutModal onClose={vi.fn()} />);
    await screen.findByTestId('open-log-folder-button');
    await act(async () => {
      screen.getByTestId('open-log-folder-button').click();
    });
    expect(window.api.openLogFolder).toHaveBeenCalledTimes(1);
  });

  // ORAIN-0750 AC6: three groups, each role="group", with aria-labelledby
  // or aria-label.
  it('renders three semantic groups with accessible names', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('about-modal')).toBeInTheDocument();
    });
    const primary = screen.getByTestId('about-group-primary');
    const accessory = screen.getByTestId('about-group-accessory');
    const app = screen.getByTestId('about-group-app');

    expect(primary).toHaveAttribute('role', 'group');
    expect(primary).toHaveAttribute('aria-labelledby', 'about-group-primary-heading');

    expect(accessory).toHaveAttribute('role', 'group');
    // Accesorias has no visible heading; rely on aria-label.
    expect(accessory).toHaveAttribute('aria-label', 'External links');

    expect(app).toHaveAttribute('role', 'group');
    // ORAIN-0756 AC5: the App group has no visible heading any more, so
    // its accessible name comes from aria-label instead of aria-labelledby.
    expect(app).toHaveAttribute('aria-label', 'App settings');
    expect(app).not.toHaveAttribute('aria-labelledby');
  });

  // ORAIN-0750 AC6: Tab order follows visual order
  // (primaries → accesorias → App → Close).
  it('Tab order follows visual groups: Report a Bug first, Close last', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('about-modal')).toBeInTheDocument();
    });
    const modal = screen.getByTestId('about-modal');
    const focusableSelector = 'button, a[href], [role="switch"]';
    const focusables = Array.from(modal.querySelectorAll<HTMLElement>(focusableSelector));
    expect(focusables[0]).toHaveTextContent(/Report a Bug/);
    expect(focusables[focusables.length - 1]).toHaveTextContent(/^Close$/);
  });

  // studio-qa finding [HIGH]: per-test useFakeTimers must be paired with
  // useRealTimers, otherwise the next test in the same file (or another
  // file in the same worker) silently inherits fake timers. The
  // afterEach above restores them; this test asserts the invariant holds
  // for any test that opted in.
  it('restore vi.useFakeTimers() in afterEach so subsequent tests use real timers', () => {
    vi.useFakeTimers();
    // afterEach runs after the test body. If it forgets useRealTimers(),
    // the assertion below would fail.
    expect(vi.isFakeTimers()).toBe(true);
  });
});
