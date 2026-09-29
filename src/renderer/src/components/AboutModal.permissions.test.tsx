// src/renderer/src/components/AboutModal.permissions.test.tsx
// Integration test: when `checkSnapPermissions` reports missing interfaces
// under snap, AboutModal renders the SnapPermissionsSection with the
// exact commands surfaced.
//
// ORAIN-0578 T2: integration coverage of the section wiring — component
// behavior is covered by SnapPermissionsSection.test.tsx.
// ORAIN-0590: `password-manager-service` is no longer surfaced.
// ORAIN-0591: `hardware-observe` is no longer surfaced.
// ORAIN-0592: `mount-observe` is no longer surfaced — `removable-media` is
// now the only interface that can appear.

import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AboutModal } from './AboutModal';

beforeEach(() => {
  const mockApi = {
    getVersion: vi.fn().mockResolvedValue('1.2.3'),
    checkForUpdates: vi.fn().mockResolvedValue({
      updateAvailable: false,
      latestVersion: '',
      releaseUrl: '',
      managedBySnap: true,
    }),
    getPreferences: vi.fn().mockResolvedValue({ analyticsEnabled: true }),
    setPreferences: vi.fn().mockResolvedValue(undefined),
    reportBug: vi.fn().mockResolvedValue({ success: true }),
    logError: vi.fn(),
    logWarn: vi.fn(),
    logInfo: vi.fn(),
    getLogPath: vi.fn().mockResolvedValue('/mock/log'),
    // ORAIN-0735: keep permissions tests consistent with the main mock.
    // ORAIN-0756: the control is a <button>, not an <a>.
    openLogFolder: vi.fn().mockResolvedValue({ success: true }),
    isSnap: vi.fn().mockResolvedValue(true),
    checkSnapPermissions: vi.fn().mockResolvedValue({
      isSnap: true,
      snapName: 'jellytunes',
      interfaces: [
        {
          interface: 'removable-media',
          status: 'missing',
          command: 'sudo snap connect jellytunes:removable-media',
        },
      ],
    }),
  };
  // @ts-expect-error — Mocking window.api for test environment
  window.api = mockApi;
});

describe('AboutModal (snap permissions integration)', () => {
  it('renders the missing-permissions section when interfaces are missing', async () => {
    render(<AboutModal onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('snap-permissions-section')).toBeInTheDocument();
    });
    expect(screen.getByText('sudo snap connect jellytunes:removable-media')).toBeInTheDocument();
  });

  it('does not render the section when checkSnapPermissions returns no missing interfaces', async () => {
    const updatedApi = {
      ...window.api,
      checkSnapPermissions: vi.fn().mockResolvedValue({
        isSnap: true,
        snapName: 'jellytunes',
        interfaces: [],
      }),
    };
    window.api = updatedApi;
    render(<AboutModal onClose={vi.fn()} />);
    // Wait for isSnap to settle, then assert nothing is shown.
    await waitFor(() => {
      expect(window.api.isSnap).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('snap-permissions-section')).not.toBeInTheDocument();
  });
});
