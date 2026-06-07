// @vitest-environment jsdom
import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AboutModal } from './AboutModal';

beforeEach(() => {
  const mockApi = {
    getVersion: vi.fn().mockResolvedValue('1.2.3'),
    checkForUpdates: vi
      .fn()
      .mockResolvedValue({ updateAvailable: false, latestVersion: '', releaseUrl: '' }),
    getPreferences: vi.fn().mockResolvedValue({ analyticsEnabled: true }),
    setPreferences: vi.fn().mockResolvedValue(undefined),
    reportBug: vi.fn().mockResolvedValue({ success: true }),
    logError: vi.fn(),
    logWarn: vi.fn(),
    logInfo: vi.fn(),
    getLogPath: vi.fn().mockResolvedValue('/mock/log'),
  };
  // @ts-expect-error — Mocking window.api for test environment
  window.api = mockApi;
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
});
