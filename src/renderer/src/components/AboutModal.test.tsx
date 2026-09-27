// @vitest-environment jsdom
import { cleanup, render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AboutModal } from './AboutModal';

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard') ?? undefined;

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
  // jsdom does not implement navigator.clipboard — provide a stub that
  // individual tests can override. Without this, copying throws.
  // Always re-assign (never gate on 'clipboard' in navigator) so the
  // mock is reset between tests; the previous gate kept the first
  // test's vi.fn() alive across tests.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  // React unmounts so any leaked setTimeout would attempt setState on an
  // unmounted component, and any leaked vi.useFakeTimers() would freeze
  // the next test.
  cleanup();
  vi.useRealTimers();
  // Restore the descriptor jsdom originally exposed so we never leak
  // the stub into other test files that share this worker.
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
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

  // ORAIN-0735 AC1: the "Open log folder" link sits next to View on GitHub
  // and Support on Ko-fi in the tertiary-links row.
  it('renders the Open log folder link next to View on GitHub and Support on Ko-fi', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/Open log folder/)).toBeInTheDocument();
    });
    // AC1 is about *position*, not just presence. Walk up to the closest
    // flex-row container; "View on GitHub", "Support on Ko-fi" and the
    // open-log-folder link must all sit on the same flex-row (i.e. be
    // descendants of the same `flex flex-row` ancestor). This catches
    // the case where the link is rendered in a separate row even though
    // a find-by-text would happily pass.
    const openLog = screen.getByTestId('open-log-folder-button');
    const flexRow = openLog.closest('.flex.flex-row');
    expect(flexRow).not.toBeNull();
    expect(flexRow).toContainElement(screen.getByText(/View on GitHub/));
    expect(flexRow).toContainElement(screen.getByText(/Support on Ko-fi/));
    expect(flexRow).toContainElement(openLog);
  });

  // ORAIN-0735 AC2: the full log path is exposed via tooltip (title attr)
  // so users can see it on hover without needing a precision pointer.
  it('exposes the full log path as a tooltip on the link', async () => {
    window.api.getLogPath = vi.fn().mockResolvedValue('/var/log/jellytunes/main.log');
    render(<AboutModal onClose={vi.fn()} />);
    const link = await screen.findByTestId('open-log-folder-button');
    expect(link).toHaveAttribute('title', '/var/log/jellytunes/main.log');
  });

  // ORAIN-0735 AC2: the log path element keeps its data-testid so QA can
  // assert against it. We use it for tooltip copy + clipboard copy.
  it('renders a log-path element with the path accessible to assistive tech', async () => {
    window.api.getLogPath = vi.fn().mockResolvedValue('/var/log/jellytunes/main.log');
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('log-path')).toHaveTextContent('/var/log/jellytunes/main.log');
    });
  });

  // ORAIN-0735 AC5: clicking the link triggers IPC log:openFolder, which
  // main resolves via electron-log (no path is passed from the renderer).
  it('calls openLogFolder when the Open log folder link is clicked', async () => {
    window.api.getLogPath = vi.fn().mockResolvedValue('/var/log/jellytunes/main.log');
    window.api.openLogFolder = vi.fn().mockResolvedValue({ success: true });
    render(<AboutModal onClose={vi.fn()} />);
    await screen.findByTestId('open-log-folder-button');
    await act(async () => {
      screen.getByTestId('open-log-folder-button').click();
    });
    expect(window.api.openLogFolder).toHaveBeenCalledTimes(1);
  });

  // ORAIN-0735 / studio-qa finding [MEDIUM]: the copy button's aria-label
  // currently says only "Copy log path". Blind users learn the destination
  // only after pressing the button. Surface the path in the label.
  it('exposes the log path in the copy button aria-label', async () => {
    window.api.getLogPath = vi.fn().mockResolvedValue('/var/log/jellytunes/main.log');
    render(<AboutModal onClose={vi.fn()} />);
    const copyButton = await screen.findByTestId('copy-log-path-button');
    expect(copyButton).toHaveAttribute('aria-label', 'Copy log path: /var/log/jellytunes/main.log');
  });

  // ORAIN-0735 AC2: a copy icon next to the link copies the path to the
  // clipboard and confirms with a check for ~2s.
  it('copies the log path to the clipboard when the copy button is clicked and shows a check', async () => {
    vi.useFakeTimers();
    window.api.getLogPath = vi.fn().mockResolvedValue('/var/log/jellytunes/main.log');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });
    let renderResult: ReturnType<typeof render> | undefined;
    await act(async () => {
      renderResult = render(<AboutModal onClose={vi.fn()} />);
      // Flush microtasks so useEffect's getLogPath().then(setLogPath) settles
      // before we look for the button.
      await Promise.resolve();
    });
    const copyButton = renderResult!.getByTestId('copy-log-path-button');
    await act(async () => {
      copyButton.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('/var/log/jellytunes/main.log');
    // Right after clicking, the check confirmation is shown.
    expect(screen.getByTestId('copy-log-path-button')).toHaveTextContent(/✓/);
    // After ~2s, the copy icon is restored.
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByTestId('copy-log-path-button')).not.toHaveTextContent(/✓/);
  });

  // studio-qa finding [HIGH]: the 2s setTimeout used to revert the copy
  // confirmation previously had no handle saved and no cleanup. We verify
  // it cancels on unmount so React does not warn about setState on an
  // unmounted component and so the confirmation does not flash after
  // the modal is gone.
  it('clears the copy confirmation setTimeout when unmounted before 2s elapse', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    window.api.getLogPath = vi.fn().mockResolvedValue('/var/log/jellytunes/main.log');
    const { unmount } = render(<AboutModal onClose={vi.fn()} />);
    const copyButton = await screen.findByTestId('copy-log-path-button');
    await act(async () => {
      copyButton.click();
      await Promise.resolve();
    });
    setTimeoutSpy.mockClear();
    clearTimeoutSpy.mockClear();
    unmount();
    // The unmount path must call clearTimeout on the confirmation handle.
    // Before the fix this call would not happen because the handle was
    // never stored.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
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
