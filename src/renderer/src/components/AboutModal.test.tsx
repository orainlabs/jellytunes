// @vitest-environment jsdom
import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  // jsdom does not implement navigator.clipboard — provide a stub that
  // individual tests can override. Without this, copying throws.
  if (!('clipboard' in navigator)) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });
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
});
