// src/renderer/src/components/AboutModal.snap.test.tsx
// Regression test for ORAIN-0573: under snap, the About modal must show
// a "Managed via Snap Store" indicator in place of the manual update
// check button. Users retain visibility that updates are automatic.

import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AboutModal } from './AboutModal';

function makeMockApi(opts: { isSnap: boolean }) {
  return {
    getVersion: vi.fn().mockResolvedValue('1.2.3'),
    checkForUpdates: vi.fn().mockResolvedValue({
      updateAvailable: false,
      latestVersion: '',
      releaseUrl: '',
      managedBySnap: opts.isSnap,
    }),
    getPreferences: vi.fn().mockResolvedValue({ analyticsEnabled: true }),
    setPreferences: vi.fn().mockResolvedValue(undefined),
    reportBug: vi.fn().mockResolvedValue({ success: true }),
    logError: vi.fn(),
    logWarn: vi.fn(),
    logInfo: vi.fn(),
    getLogPath: vi.fn().mockResolvedValue('/mock/log'),
    // ORAIN-0727: keep the snap-aware tests consistent with the main
    // AboutModal mock — the new log-folder button calls this on click.
    openLogFolder: vi.fn().mockResolvedValue({ success: true }),
    isSnap: vi.fn().mockResolvedValue(opts.isSnap),
    // ORAIN-0578 T2: empty report — these tests only assert the snap
    // indicator behavior; permissions section coverage lives in its own file.
    checkSnapPermissions: vi.fn().mockResolvedValue({
      isSnap: opts.isSnap,
      snapName: opts.isSnap ? 'jellytunes' : null,
      interfaces: [],
    }),
  };
}

beforeEach(() => {
  // @ts-expect-error — Mocking window.api for test environment
  window.api = makeMockApi({ isSnap: false });
});

describe('AboutModal (snap-aware)', () => {
  it('shows the Snap Store indicator and hides Check Updates button under snap', async () => {
    // ORAIN-0573 AC2: under snap, the user must see that updates are
    // automatic (snapd), so they don't think the app is unmaintained.
    // @ts-expect-error — Mocking window.api for test environment
    window.api = makeMockApi({ isSnap: true });
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/Managed via Snap Store/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Check Updates')).not.toBeInTheDocument();
  });

  it('shows the manual Check Updates button when NOT under snap (existing behavior)', async () => {
    // @ts-expect-error — Mocking window.api for test environment
    window.api = makeMockApi({ isSnap: false });
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Check Updates')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Managed via Snap Store/i)).not.toBeInTheDocument();
  });
});
