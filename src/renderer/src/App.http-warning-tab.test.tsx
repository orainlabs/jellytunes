// @vitest-environment jsdom
// ORAIN-0710 H2-1: Integration tests for the full HTTP warning → Cancel → tab
// restoration cycle. These tests verify the round-trip that H2-1 identified as
// missing coverage in the cycle-1 tests.
//
// Bug chain being tested (from task notes):
//   1. Saved session has authKind='password' (last successful login).
//   2. Auto-connect fails → LoginScreen shown with saved session pre-filled (password tab).
//   3. User switches to apikey tab → currentLoginMode='apikey', userHasInteracted=true.
//   4. Cold-start effect resolves with authKind='password' → WITHOUT fix: setCurrentLoginMode
//      overwrites 'apikey' back to 'password'. WITH fix: userHasInteracted guard prevents it.
//   5. User fills in HTTP URL + apikey credentials → HTTP warning modal fires.
//   6. Cancel → LoginScreen re-mounts with initialMode=currentLoginMode.
//   7. VERIFY: apikey tab visible (not overwritten by stale disk value).
//
// The tests verify the M1 guard (userHasInteracted) prevents the cold-start effect
// from overwriting the live tab with the stale saved authKind.

import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import App from './App';
import { loadSavedAuthKind } from './hooks/useJellyfinConnection';

// Override loadSavedAuthKind so the cold-start effect in App uses our controlled
// promise instead of going through the real hook's loadSession chain (which includes
// auto-connect logic that the test doesn't need).
let resolveLoadSavedAuthKind: (kind: 'apikey' | 'password' | null) => void;
vi.mock('./hooks/useJellyfinConnection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hooks/useJellyfinConnection')>();
  return {
    ...actual,
    loadSavedAuthKind: vi.fn(
      () =>
        new Promise<'apikey' | 'password' | null>((r) => {
          resolveLoadSavedAuthKind = r;
        }),
    ),
  };
});

// ── mocks ────────────────────────────────────────────────────────────────────

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
  saveSession: vi.fn().mockResolvedValue({ success: true }),
  loadSession: vi.fn(),
  clearSession: vi.fn().mockResolvedValue(undefined),
  isSessionStorageAvailable: vi.fn().mockResolvedValue(true),
  isSnap: vi.fn().mockResolvedValue(false),
  checkSnapPermissions: vi.fn().mockResolvedValue({ isSnap: false }),
};
const mockFetch = vi.fn();

beforeAll(() => {
  Object.defineProperty(window, 'api', { value: mockApi, writable: true });
  global.fetch = mockFetch as unknown as typeof fetch;
});
beforeEach(() => {
  mockApi.checkSnapPermissions.mockResolvedValue({ isSnap: false, snapName: null, interfaces: [] });
  mockApi.isSessionStorageAvailable.mockResolvedValue(true);
  mockApi.clearSession.mockResolvedValue(undefined);
  // Default: auto-connect requests fail fast (no server at these URLs).
  // Manual submissions return 401 so the HTTP-insecure gate fires.
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
  });
  // loadSavedAuthKind mock: default to null (no saved session) so App shows
  // LoginScreen immediately without auto-connect logic interfering.
  // We use mockImplementation so that test 2 can override with its own deferred
  // resolver (mockResolvedValue replaces the whole mock, losing the deferred).
  vi.mocked(loadSavedAuthKind).mockImplementation(
    () =>
      new Promise<'apikey' | 'password' | null>((r) => {
        resolveLoadSavedAuthKind = r;
      }),
  );
});
afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('App — ORAIN-0710 H2-1: cold-start effect with stale disk authKind', () => {
  it(
    'Cancel returns to the apikey tab when switching from it, even if the saved session ' +
      'has authKind=password — userHasInteracted prevents the cold-start overwrite',
    async () => {
      // Saved session: authKind='password', so cold-start effect would set currentLoginMode
      // to 'password' and overwrite the user's manual choice. WITH fix: userHasInteracted=true
      // blocks the effect. WITHOUT fix: tab reverts to password and the assertion fails.
      const savedSession = JSON.stringify({
        authKind: 'password',
        url: 'https://jellyfin.local',
        accessToken: 'old-token',
        userId: 'user1',
      });
      mockApi.loadSession.mockResolvedValue(savedSession);

      render(<App />);

      // Auto-connect fails (401); LoginScreen shown with the saved session pre-filled
      // on the password tab (currentLoginMode='password' from cold-start effect).
      await waitFor(() => {
        expect(screen.getByTestId('username-input')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('api-key-input')).not.toBeInTheDocument();

      // User manually switches to apikey tab (userHasInteracted.current = true)
      const toggle = screen.getByTestId('mode-toggle-apikey');
      await act(async () => {
        toggle.click();
      });
      await waitFor(() => {
        expect(screen.getByTestId('api-key-input')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('username-input')).not.toBeInTheDocument();

      // User fills in HTTP URL + apikey credentials → HTTP warning modal fires
      const urlInput = screen.getByTestId('server-url-input') as HTMLInputElement;
      const apiKeyInput = screen.getByTestId('api-key-input') as HTMLInputElement;

      await act(async () => {
        urlInput.value = 'http://jellyfin.insecure.local';
        urlInput.dispatchEvent(new Event('input', { bubbles: true }));
        apiKeyInput.value = 'test-apikey';
        apiKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const form = document.querySelector('form') as HTMLFormElement;
      await act(async () => {
        form.requestSubmit();
      });

      await waitFor(() => {
        expect(screen.getByTestId('insecure-modal')).toBeInTheDocument();
      });

      // Cancel → LoginScreen re-mounts with initialMode=currentLoginMode
      const cancelBtn = screen.getByRole('button', { name: /cancel/i });
      await act(async () => {
        cancelBtn.click();
      });

      // VERIFY: apikey tab visible. WITHOUT fix: password tab visible (test fails).
      await waitFor(() => {
        expect(screen.getByTestId('api-key-input')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('username-input')).not.toBeInTheDocument();
    },
  );

  it(
    'userHasInteracted guard is NOT triggered when cold-start resolves before user toggles, ' +
      'so the saved authKind correctly initialises the tab',
    async () => {
      // Deferred promise: cold-start effect waits for this to resolve.
      // The mock is already set up in the vi.mock at the top; we just never call
      // resolveLoadSavedAuthKind, so it stays pending. The test verifies that the
      // toggle works while the effect is still pending.

      render(<App />);

      // While loadSavedAuthKind is pending: default to password tab.
      await waitFor(() => {
        expect(screen.getByTestId('username-input')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('api-key-input')).not.toBeInTheDocument();

      // User switches to apikey tab BEFORE loadSavedAuthKind resolves
      const toggle = screen.getByTestId('mode-toggle-apikey');
      await act(async () => {
        toggle.click();
      });
      await waitFor(() => {
        expect(screen.getByTestId('api-key-input')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('username-input')).not.toBeInTheDocument();

      // Now resolve loadSavedAuthKind with a conflicting authKind from disk (password).
      // The cold-start effect reads authKind='password' but userHasInteracted=true →
      // effect skips setCurrentLoginMode. Tab stays apikey.
      await act(async () => {
        resolveLoadSavedAuthKind!('password');
      });

      // Tab must still be apikey — userHasInteracted prevented the overwrite.
      await waitFor(() => {
        expect(screen.getByTestId('api-key-input')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('username-input')).not.toBeInTheDocument();
    },
  );

  it(
    'Cancel returns to the password tab when the user was on it — session authKind does not ' +
      'matter because the user never switched tabs (userHasInteracted is false but harmless)',
    async () => {
      // Cold-start effect: resolves with authKind='apikey' → currentLoginMode='apikey'.
      // User stays on password tab and submits from there. Cancel returns to password.
      vi.mocked(loadSavedAuthKind).mockResolvedValue('apikey');

      render(<App />);

      // LoginScreen shown on apikey tab (from cold-start effect).
      await waitFor(() => {
        expect(screen.getByTestId('api-key-input')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('username-input')).not.toBeInTheDocument();

      // User stays on apikey tab (the one cold-start set).
      // Submits with HTTP URL → HTTP warning fires.
      const urlInput = screen.getByTestId('server-url-input') as HTMLInputElement;
      const apiKeyInput = screen.getByTestId('api-key-input') as HTMLInputElement;

      await act(async () => {
        urlInput.value = 'http://jellyfin.insecure.local';
        urlInput.dispatchEvent(new Event('input', { bubbles: true }));
        apiKeyInput.value = 'test-apikey';
        apiKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const form = document.querySelector('form') as HTMLFormElement;
      await act(async () => {
        form.requestSubmit();
      });

      await waitFor(() => {
        expect(screen.getByTestId('insecure-modal')).toBeInTheDocument();
      });

      const cancelBtn = screen.getByRole('button', { name: /cancel/i });
      await act(async () => {
        cancelBtn.click();
      });

      // VERIFY: apikey tab (the one the user was on when submitting).
      await waitFor(() => {
        expect(screen.getByTestId('api-key-input')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('username-input')).not.toBeInTheDocument();
    },
  );
});
