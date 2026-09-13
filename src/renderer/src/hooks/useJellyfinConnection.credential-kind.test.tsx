// @vitest-environment jsdom
// ORAIN-0710 M2: tests that pendingCredentialKind is correctly set for each
// connection path that triggers the HTTP warning modal.
//
// Without these tests, a future refactor that drops `pendingCredentialKind: '<kind>'`
// from one of the checkHttpWarningGate call sites would leave the modal showing
// "username and password" even when the user triggered it with an API key — and the
// existing InsecureConnectionModal tests (which only test the modal in isolation with
// hardcoded props) would still pass.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useJellyfinConnection } from './useJellyfinConnection';

const mockApi = {
  saveSession: vi.fn().mockResolvedValue({ success: true }),
  loadSession: vi.fn().mockResolvedValue(null),
  clearSession: vi.fn().mockResolvedValue(undefined),
  logError: vi.fn(),
  isSnap: vi.fn().mockResolvedValue(false),
  checkSnapPermissions: vi.fn().mockResolvedValue({ isSnap: false }),
};
const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', { value: mockApi, writable: true });
  global.fetch = mockFetch;
});

describe('useJellyfinConnection — pendingCredentialKind plumbing (ORAIN-0710 M2)', () => {
  describe('checkHttpWarningGate sets pendingCredentialKind to the correct kind', () => {
    it('connectWithPassword → pendingCredentialKind is "password"', async () => {
      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectWithPassword('http://insecure.local', 'alice', 'secret');
      });

      expect(result.current.showHttpWarning).toBe(true);
      expect(result.current.pendingCredentialKind).toBe('password');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('connectToJellyfin → pendingCredentialKind is "apikey"', async () => {
      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectToJellyfin('http://insecure.local', 'my-apikey');
      });

      expect(result.current.showHttpWarning).toBe(true);
      expect(result.current.pendingCredentialKind).toBe('apikey');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('auto-reconnect with accessToken (password session) → pendingCredentialKind is "accessToken"', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({
          authKind: 'password',
          url: 'http://insecure.local',
          accessToken: 'stored-token',
          userId: 'u1',
        }),
      );

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await waitFor(() => {
        expect(result.current.showHttpWarning).toBe(true);
      });

      expect(result.current.pendingCredentialKind).toBe('accessToken');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('auto-reconnect with apiKey (apikey session) → pendingCredentialKind is "apikey"', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({
          authKind: 'apikey',
          url: 'http://insecure.local',
          apiKey: 'stored-key',
          userId: 'u1',
        }),
      );

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await waitFor(() => {
        expect(result.current.showHttpWarning).toBe(true);
      });

      expect(result.current.pendingCredentialKind).toBe('apikey');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('cancelHttpWarning resets pendingCredentialKind to null', async () => {
      mockApi.loadSession.mockResolvedValue(null);

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectWithPassword('http://insecure.local', 'alice', 'secret');
      });

      // Wait for the state to settle
      await waitFor(() => {
        expect(result.current.pendingCredentialKind).toBe('password');
      });

      act(() => {
        result.current.cancelHttpWarning();
      });

      // After cancel: pendingCredentialKind is null and modal is dismissed
      expect(result.current.pendingCredentialKind).toBeNull();
      expect(result.current.showHttpWarning).toBe(false);
      expect(result.current.isConnected).toBe(false);
    });

    it('confirmHttpWarning resets pendingCredentialKind to null before retrying', async () => {
      // Setup: after confirming, loadSession returns a confirmed host so the retry succeeds
      let loadCallCount = 0;
      mockApi.loadSession.mockImplementation(async () => {
        loadCallCount++;
        // Call 1: initial null
        // Call 2: null (confirmHttpWarning → save stub)
        // Call 3: stub with confirmed host (mount effect retry)
        if (loadCallCount < 3) return null;
        return JSON.stringify({ httpConfirmedHosts: { 'insecure.local:80': true } });
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ AccessToken: 'tok', User: { Id: 'u1' } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Jellyfin' }),
        });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      // Fire modal
      await act(async () => {
        await result.current.connectWithPassword('http://insecure.local', 'alice', 'secret');
      });
      expect(result.current.pendingCredentialKind).toBe('password');

      // Confirm — pendingCredentialKind must be cleared so the modal doesn't re-trigger
      await act(async () => {
        await result.current.confirmHttpWarning();
      });
      await waitFor(() => {
        expect(result.current.pendingCredentialKind).toBeNull();
      });
      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });
    });
  });
});
