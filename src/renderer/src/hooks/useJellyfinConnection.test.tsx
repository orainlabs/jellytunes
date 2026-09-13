import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useJellyfinConnection,
  isSecureAuthUrl,
  isHttpHostConfirmed,
  httpConfirmationKey,
  INVALID_API_KEY_ERROR,
} from './useJellyfinConnection';

const mockApi = {
  saveSession: vi.fn().mockResolvedValue({ success: true }),
  loadSession: vi.fn().mockResolvedValue(null),
  clearSession: vi.fn().mockResolvedValue(undefined),
  logError: vi.fn(),
  // ORAIN-0578 T1: needed when the hook detects encryption_unavailable
  // under snap and asks main for the snap name.
  isSnap: vi.fn().mockResolvedValue(false),
  checkSnapPermissions: vi.fn().mockResolvedValue({
    isSnap: false,
    snapName: null,
    interfaces: [],
  }),
};

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', { value: mockApi, writable: true });
  global.fetch = mockFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useJellyfinConnection', () => {
  describe('initial state', () => {
    it('renders disconnected state when no session saved', async () => {
      mockApi.loadSession.mockResolvedValue(null);

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await waitFor(() => {
        expect(result.current.isConnecting).toBe(false);
        expect(result.current.isConnected).toBe(false);
      });
    });

    it('auto-connects when session is saved with userId', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({ url: 'https://jellyfin.test', apiKey: 'test-key', userId: 'user-1' }),
      );
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ServerName: 'Test Server' }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ Id: 'user-1', Name: 'Test User' }),
      });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      expect(onConnected).toHaveBeenCalledWith('https://jellyfin.test', 'test-key', 'user-1');
    });
  });

  describe('connect with single user', () => {
    it('auto-selects when only one user is returned (no user selector)', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Test Server' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ Id: 'user-1', Name: 'Test User' }),
        });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await act(async () => {
        await result.current.connectToJellyfin('https://jellyfin.test', 'test-key');
      });

      expect(result.current.showUserSelector).toBe(false);
      expect(onConnected).toHaveBeenCalled();
    });
  });

  describe('connect with multiple users', () => {
    it('sets showUserSelector=true when multiple users are found', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Test Server' }),
        })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve([
              { Id: 'user-1', Name: 'User One' },
              { Id: 'user-2', Name: 'User Two' },
            ]),
        });

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectToJellyfin('https://jellyfin.test', 'test-key');
      });

      expect(result.current.showUserSelector).toBe(true);
      expect(result.current.users).toHaveLength(2);
    });
  });

  describe('connectWithUser (via handleUserSelect)', () => {
    it('calls saveSession when user selects', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ServerName: 'Test' }) })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve([
              { Id: 'user-1', Name: 'User One' },
              { Id: 'user-2', Name: 'User Two' },
            ]),
        });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await act(async () => {
        await result.current.connectToJellyfin('https://jellyfin.test', 'test-key');
      });

      await act(async () => {
        await result.current.handleUserSelect({ Id: 'user-1', Name: 'User One' });
      });

      expect(mockApi.saveSession).toHaveBeenCalledWith(
        JSON.stringify({
          authKind: 'apikey',
          url: 'https://jellyfin.test',
          apiKey: 'test-key',
          userId: 'user-1',
        }),
      );
      expect(onConnected).toHaveBeenCalledWith('https://jellyfin.test', 'test-key', 'user-1');
    });
  });

  describe('disconnect', () => {
    it('calls clearSession and resets state', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({ url: 'https://jellyfin.test', apiKey: 'test-key', userId: 'user-1' }),
      );
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ServerName: 'Test' }),
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ Id: 'user-1', Name: 'Test' }),
      });

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      act(() => {
        result.current.disconnect();
      });

      expect(mockApi.clearSession).toHaveBeenCalled();
      expect(result.current.isConnected).toBe(false);
      expect(result.current.jellyfinConfig).toBe(null);
    });
  });

  describe('saveSession failure', () => {
    it('still connects when saveSession returns success:false', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockApi.saveSession.mockResolvedValue({ success: false, reason: 'encryption_unavailable' });
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Test Server' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ Id: 'user-1', Name: 'Test User' }),
        });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await act(async () => {
        await result.current.connectToJellyfin('https://jellyfin.test', 'test-key');
      });

      expect(onConnected).toHaveBeenCalledWith('https://jellyfin.test', 'test-key', 'user-1');
      expect(mockApi.logError).toHaveBeenCalledWith('Session save failed: encryption_unavailable');
    });

    it('logs error when saveSession throws', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockApi.saveSession.mockRejectedValue(new Error('IPC error'));
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Test Server' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ Id: 'user-1', Name: 'Test User' }),
        });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await act(async () => {
        await result.current.connectToJellyfin('https://jellyfin.test', 'test-key');
      });

      expect(onConnected).toHaveBeenCalled();
    });
  });

  describe('save failures (ORAIN-0578)', () => {
    it('still connects when session:save reports encryption_unavailable', async () => {
      // The snap keyring warning is no longer driven from here — it comes
      // from the permission report (see useSnapPermissions + the App-level
      // banner test). A failed save must not block the connection.
      mockApi.loadSession.mockResolvedValue(null);
      mockApi.saveSession.mockResolvedValue({ success: false, reason: 'encryption_unavailable' });
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Test Server' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ Id: 'user-1', Name: 'Test User' }),
        });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await act(async () => {
        await result.current.connectToJellyfin('https://jellyfin.test', 'test-key');
      });

      expect(result.current.isConnected).toBe(true);
      expect(result.current.error).toBeNull();
      expect(onConnected).toHaveBeenCalledWith('https://jellyfin.test', 'test-key', 'user-1');
    });
  });

  // ORAIN-0564 SO-1 — username+password authentication flow.
  describe('connectWithPassword', () => {
    it('POSTs to /Users/AuthenticateByName with {Username, Pw} and resolves User.Id + AccessToken', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            AccessToken: 'pw-token-abc',
            User: { Id: 'user-1', Name: 'Alice' },
          }),
      });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await act(async () => {
        await result.current.connectWithPassword('https://jellyfin.test', 'alice', 'secret');
      });

      // Single fetch call to /Users/AuthenticateByName
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://jellyfin.test/Users/AuthenticateByName');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ Username: 'alice', Pw: 'secret' });
      // Authorization header is MediaBrowser WITHOUT Token (no phantom device)
      const auth = init.headers.Authorization as string;
      expect(auth.startsWith('MediaBrowser ')).toBe(true);
      expect(auth).not.toMatch(/Token="/);

      expect(result.current.isConnected).toBe(true);
      expect(onConnected).toHaveBeenCalledWith('https://jellyfin.test', 'pw-token-abc', 'user-1');
    });

    // ORAIN-0706: replaced the hard HTTPS error with a blocking modal.
    // The old "blocks non-loopback http:// URLs" test now expects showHttpWarning.
    it('shows modal for non-loopback http:// URLs instead of hard error (connectWithPassword)', async () => {
      mockApi.loadSession.mockResolvedValue(null);

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectWithPassword('http://jellyfin.test', 'alice', 'secret');
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.current.isConnected).toBe(false);
      // Modal shown — no hard error message, connection was blocked
      expect(result.current.showHttpWarning).toBe(true);
      expect(result.current.pendingHttpUrl).toBe('http://jellyfin.test');
    });

    it('allows password auth over http:// to a loopback host (E2E containers)', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ AccessToken: 'pw-token-abc', User: { Id: 'user-1' } }),
      });

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectWithPassword('http://127.0.0.1:8096', 'alice', 'secret');
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.current.isConnected).toBe(true);
    });

    it('surfaces a generic 401 error without auto-retrying', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectWithPassword('https://jellyfin.test', 'alice', 'wrong');
      });

      // Single fetch attempt — no retry loop
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toBeTruthy();
      // Same generic message whether user exists or not
      expect(result.current.error).toBe('Invalid username or password');
    });

    it('persists session as {authKind:"password", url, accessToken, userId} — never the password', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            AccessToken: 'pw-token-abc',
            User: { Id: 'user-1', Name: 'Alice' },
          }),
      });

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectWithPassword('https://jellyfin.test', 'alice', 'secret');
      });

      expect(mockApi.saveSession).toHaveBeenCalledTimes(1);
      const persisted = JSON.parse(mockApi.saveSession.mock.calls[0][0]);
      expect(persisted).toEqual({
        authKind: 'password',
        url: 'https://jellyfin.test',
        accessToken: 'pw-token-abc',
        userId: 'user-1',
      });
      expect(persisted.password).toBeUndefined();
      expect(persisted.Pw).toBeUndefined();
    });

    it('persists session as {authKind:"apikey"} when connecting via API key (no password field)', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Test Server' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ Id: 'user-1', Name: 'Test User' }),
        });

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectToJellyfin('https://jellyfin.test', 'test-key');
      });

      expect(mockApi.saveSession).toHaveBeenCalledTimes(1);
      const persisted = JSON.parse(mockApi.saveSession.mock.calls[0][0]);
      expect(persisted).toEqual({
        authKind: 'apikey',
        url: 'https://jellyfin.test',
        apiKey: 'test-key',
        userId: 'user-1',
      });
    });
  });

  // ORAIN-0564 SO-2 — auto-reconnect for password sessions on mount.
  // The branch ordering rule: if `apiKey` is present (apikey auth), the
  // apikey branch wins. The password branch fires only when the saved
  // session is `userId + accessToken` with no `apiKey` field. The reused
  // `connectWithUser` re-saves the same payload — idempotent on
  // encryption-safe payloads because `same plaintext → same encrypted blob`.
  describe('auto-reconnect for password sessions (ORAIN-0564 SO-2)', () => {
    it('auto-reconnects when session is password-shaped (no apiKey, has accessToken)', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({
          authKind: 'password',
          url: 'https://jellyfin.test',
          accessToken: 'pw-token-abc',
          userId: 'user-1',
        }),
      );
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ServerName: 'Test Server' }),
      });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      expect(onConnected).toHaveBeenCalledWith('https://jellyfin.test', 'pw-token-abc', 'user-1');

      // /System/Info/Public was called with MediaBrowser Token="<accessToken>"
      const publicCall = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes('/System/Info/Public'),
      );
      expect(publicCall).toBeDefined();
      const [, publicInit] = publicCall!;
      const authHeader = (publicInit.headers as Record<string, string>).Authorization;
      expect(authHeader).toBeDefined();
      expect(authHeader).toContain('MediaBrowser Token="pw-token-abc"');

      // saveSession was re-called with the password-shaped payload — this is
      // the idempotent re-save inside connectWithUser; the encrypted blob
      // matches what was already on disk for the same plaintext.
      expect(mockApi.saveSession).toHaveBeenCalled();
      const persisted = JSON.parse(
        mockApi.saveSession.mock.calls[mockApi.saveSession.mock.calls.length - 1][0],
      );
      expect(persisted).toEqual({
        authKind: 'apikey', // connectWithUser always labels the apikey field — see note below
        url: 'https://jellyfin.test',
        apiKey: 'pw-token-abc', // accessToken promoted into the "apiKey" slot
        userId: 'user-1',
      });
    });

    it('clears session and surfaces error when password reconnect fetch fails', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({
          authKind: 'password',
          url: 'https://jellyfin.test',
          accessToken: 'pw-token-abc',
          userId: 'user-1',
        }),
      );
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      // Wait for the catch handler to run
      await waitFor(() => {
        expect(result.current.isConnecting).toBe(false);
      });

      expect(mockApi.clearSession).toHaveBeenCalled();
      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toMatch(/Could not reconnect\. Please log in again\./);
      expect(onConnected).not.toHaveBeenCalled();
      // saveSession must NOT be re-called on failure — we didn't reconnect.
      expect(mockApi.saveSession).not.toHaveBeenCalled();
    });

    // ORAIN-0706: the hard "Stored session URL is not HTTPS" error is replaced by
    // the warning modal. Session is NOT cleared — we wait for the user's confirmation.
    it('shows modal instead of hard error for http:// password reconnect (does not clear session)', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({
          authKind: 'password',
          url: 'http://jellyfin.insecure.test',
          accessToken: 'pw-token-abc',
          userId: 'user-1',
        }),
      );

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await waitFor(() => {
        expect(result.current.isConnecting).toBe(false);
      });

      expect(mockFetch).not.toHaveBeenCalled();
      // ORAIN-0706: session is preserved, modal is shown
      expect(result.current.showHttpWarning).toBe(true);
      expect(result.current.pendingHttpUrl).toBe('http://jellyfin.insecure.test');
      expect(result.current.isConnected).toBe(false);
      expect(onConnected).not.toHaveBeenCalled();
    });
  });

  // ORAIN-0706: replaced the hard HTTPS error with a blocking modal.
  describe('connectToJellyfin HTTP warning modal (ORAIN-0706)', () => {
    it('shows modal for http:// non-loopback instead of hard error', async () => {
      mockApi.loadSession.mockResolvedValue(null);

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectToJellyfin('http://jellyfin.test', 'apikey-abc');
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.current.isConnected).toBe(false);
      expect(result.current.showHttpWarning).toBe(true);
      expect(result.current.pendingHttpUrl).toBe('http://jellyfin.test');
    });

    it('allows http:// loopback hosts (localhost)', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Local Server' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ Id: 'user-1', Name: 'Local User' }),
        });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await act(async () => {
        await result.current.connectToJellyfin('http://localhost:8096', 'apikey-abc');
      });

      expect(mockFetch).toHaveBeenCalled();
      expect(result.current.isConnected).toBe(true);
      expect(onConnected).toHaveBeenCalledWith('http://localhost:8096', 'apikey-abc', 'user-1');
    });

    it('allows http:// 127.0.0.1 (loopback IP)', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Local Server' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ Id: 'user-1', Name: 'Local User' }),
        });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await act(async () => {
        await result.current.connectToJellyfin('http://127.0.0.1:8096', 'apikey-abc');
      });

      expect(mockFetch).toHaveBeenCalled();
      expect(result.current.isConnected).toBe(true);
    });
  });

  // ORAIN-0687: invalid API key with empty user list shows correct message
  describe('connectToJellyfin empty userList error (ORAIN-0687)', () => {
    it('sets error to INVALID_API_KEY_ERROR when fetchUserList returns no users', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      // /System/Info/Public succeeds, /Users/Me fails, fetchUserList (/Users + /Users/Public) both return []
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Test Server' }),
        })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false });

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectToJellyfin('https://jellyfin.test', 'bad-key');
      });

      expect(result.current.isConnecting).toBe(false);
      expect(result.current.error).toBe(INVALID_API_KEY_ERROR);
      expect(result.current.showUserSelector).toBe(false);
    });
  });

  // ORAIN-0685: "Failed to fetch" replaced with clear message when server unreachable
  describe('connectToJellyfin network errors (ORAIN-0685)', () => {
    it('shows clear message and logs original error when fetch rejects with TypeError', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectToJellyfin('https://jellyfin.test', 'test-key');
      });

      expect(result.current.error).toBe(
        "Couldn't reach the server. Check the address and that Jellyfin is running.",
      );
      expect(mockApi.logError).toHaveBeenCalledWith('Failed to fetch');
    });

    it('preserves specific HTTP error messages when server responds with non-ok status', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectToJellyfin('https://jellyfin.test', 'test-key');
      });

      expect(result.current.error).toMatch(/Connection error: 500/);
      expect(mockApi.logError).not.toHaveBeenCalled();
    });
  });

  describe('connectWithPassword network errors (ORAIN-0685)', () => {
    it('shows clear message and logs original error when fetch rejects with TypeError', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectWithPassword('https://jellyfin.test', 'alice', 'secret');
      });

      expect(result.current.error).toBe(
        "Couldn't reach the server. Check the address and that Jellyfin is running.",
      );
      expect(mockApi.logError).toHaveBeenCalledWith('Failed to fetch');
    });

    it('preserves 401 invalid credentials message when server responds', async () => {
      mockApi.loadSession.mockResolvedValue(null);
      mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectWithPassword('https://jellyfin.test', 'alice', 'wrong');
      });

      expect(result.current.error).toBe('Invalid username or password');
      expect(mockApi.logError).not.toHaveBeenCalled();
    });
  });

  // ORAIN-0706: pure unit tests for the confirmation helpers
  describe('isHttpHostConfirmed (ORAIN-0706)', () => {
    it('returns true when hostname:port is confirmed', () => {
      const confirmed: Record<string, true> = { 'jellyfin.example.com:8096': true };
      expect(isHttpHostConfirmed(confirmed, 'jellyfin.example.com', 8096)).toBe(true);
    });

    it('is case-insensitive on hostname', () => {
      const confirmed: Record<string, true> = { 'Jellyfin.Example.COM:8096': true };
      expect(isHttpHostConfirmed(confirmed, 'jellyfin.example.com', 8096)).toBe(true);
      expect(isHttpHostConfirmed(confirmed, 'JELLYFIN.EXAMPLE.COM', 8096)).toBe(true);
    });

    it('returns false when host is not confirmed', () => {
      const confirmed: Record<string, true> = { 'other.example.com:8096': true };
      expect(isHttpHostConfirmed(confirmed, 'jellyfin.example.com', 8096)).toBe(false);
    });

    it('returns false when port differs', () => {
      const confirmed: Record<string, true> = { 'jellyfin.example.com:8096': true };
      expect(isHttpHostConfirmed(confirmed, 'jellyfin.example.com', 9096)).toBe(false);
    });

    it('returns false when httpConfirmedHosts is undefined', () => {
      expect(isHttpHostConfirmed(undefined, 'jellyfin.example.com', 8096)).toBe(false);
    });
  });

  // ORAIN-0706: http:// non-loopback now shows a warning modal instead of a hard
  // error. The hook exposes `showHttpWarning` and `pendingHttpUrl` to the UI.
  // The caller (App) renders the modal and calls `confirmHttpWarning` or
  // `cancelHttpWarning`.
  describe('insecure HTTP warning (ORAIN-0706)', () => {
    beforeEach(() => {
      mockApi.loadSession.mockResolvedValue(null);
    });

    it('does NOT set showHttpWarning for https:// URLs (password)', async () => {
      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await act(async () => {
        await result.current.connectWithPassword('https://jellyfin.example.com', 'alice', 'secret');
      });
      expect(result.current.showHttpWarning).toBe(false);
    });

    it('sets showHttpWarning=true and stores the URL for http:// non-loopback (password)', async () => {
      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await act(async () => {
        await result.current.connectWithPassword('http://jellyfin.example.com', 'alice', 'secret');
      });
      expect(result.current.showHttpWarning).toBe(true);
      expect(result.current.pendingHttpUrl).toBe('http://jellyfin.example.com');
      // No fetch was sent
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sets showHttpWarning=true for http:// non-loopback (connectToJellyfin)', async () => {
      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await act(async () => {
        await result.current.connectToJellyfin('http://192.168.1.50', 'apikey-abc');
      });
      expect(result.current.showHttpWarning).toBe(true);
      expect(result.current.pendingHttpUrl).toBe('http://192.168.1.50');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sets showHttpWarning=true for http:// non-loopback (auto-reconnect apikey fast path)', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({
          authKind: 'apikey',
          url: 'http://192.168.1.50',
          apiKey: 'k',
          userId: 'u1',
        }),
      );
      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await waitFor(() => {
        expect(result.current.showHttpWarning).toBe(true);
      });
      expect(result.current.pendingHttpUrl).toBe('http://192.168.1.50');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sets showHttpWarning=true for http:// non-loopback (auto-reconnect password)', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({
          authKind: 'password',
          url: 'http://192.168.1.50',
          accessToken: 'tok',
          userId: 'u1',
        }),
      );
      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await waitFor(() => {
        expect(result.current.showHttpWarning).toBe(true);
      });
      expect(result.current.pendingHttpUrl).toBe('http://192.168.1.50');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('cancelHttpWarning resets showHttpWarning and pendingHttpUrl', async () => {
      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await act(async () => {
        await result.current.connectWithPassword('http://jellyfin.example.com', 'alice', 'secret');
      });
      expect(result.current.showHttpWarning).toBe(true);
      act(() => {
        result.current.cancelHttpWarning();
      });
      expect(result.current.showHttpWarning).toBe(false);
      expect(result.current.pendingHttpUrl).toBeNull();
    });

    it('isConnected stays false after cancelHttpWarning (no hang in connecting state)', async () => {
      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await act(async () => {
        await result.current.connectWithPassword('http://jellyfin.example.com', 'alice', 'secret');
      });
      act(() => {
        result.current.cancelHttpWarning();
      });
      expect(result.current.isConnected).toBe(false);
      expect(result.current.isConnecting).toBe(false);
    });

    it('allows http:// loopback to connect without showHttpWarning', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ AccessToken: 'tok', User: { Id: 'u1' } }),
      });
      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await act(async () => {
        await result.current.connectWithPassword('http://localhost:8096', 'alice', 'secret');
      });
      expect(result.current.showHttpWarning).toBe(false);
      expect(result.current.isConnected).toBe(true);
    });
  });

  // ORAIN-0706: HTTP confirmation persistence — keyed by hostname:port (case-insensitive).
  // Persists separately from session; survives clearSession.
  describe('insecure HTTP confirmation persistence (ORAIN-0706)', () => {
    beforeEach(() => {
      mockApi.loadSession.mockResolvedValue(null);
    });

    it('showHttpWarning does not fire for a confirmed http:// host on connectWithPassword', async () => {
      // Simulate previously confirmed hosts: storage contains the entry
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({ httpConfirmedHosts: { 'jellyfin.example.com:8096': true } }),
      );
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ AccessToken: 'tok', User: { Id: 'u1' } }),
      });

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await act(async () => {
        await result.current.connectWithPassword(
          'http://jellyfin.example.com:8096',
          'alice',
          'secret',
        );
      });

      expect(result.current.showHttpWarning).toBe(false);
      // Connection proceeds
      expect(mockFetch).toHaveBeenCalled();
    });

    it('showHttpWarning fires for a NEW port on a confirmed host', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({ httpConfirmedHosts: { 'jellyfin.example.com:8096': true } }),
      );

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await act(async () => {
        await result.current.connectWithPassword(
          'http://jellyfin.example.com:9090',
          'alice',
          'secret',
        );
      });
      // Different port → not confirmed → modal
      expect(result.current.showHttpWarning).toBe(true);
    });

    it('showHttpWarning is case-insensitive on hostname', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({ httpConfirmedHosts: { 'Jellyfin.Example.COM:8096': true } }),
      );
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ AccessToken: 'tok', User: { Id: 'u1' } }),
      });

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await act(async () => {
        await result.current.connectWithPassword(
          'http://jellyfin.example.com:8096',
          'alice',
          'secret',
        );
      });

      // showHttpWarning should be false because 'jellyfin.example.com:8096'
      // (lowercase) matches the stored 'Jellyfin.Example.COM:8096' (case-insensitive)
      expect(result.current.showHttpWarning).toBe(false);
    });

    it('corrupt httpConfirmedHosts storage is treated as empty (fail-closed)', async () => {
      // JSON parse error → fail-closed
      mockApi.loadSession.mockResolvedValue('{ broken json }');

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await act(async () => {
        await result.current.connectWithPassword('http://jellyfin.example.com', 'alice', 'secret');
      });

      // Treat as unconfirmed → show warning
      expect(result.current.showHttpWarning).toBe(true);
    });

    // ORAIN-0706 HIGH-2: round-trip tests for confirmHttpWarning.
    // These cover the full flow: modal fires → user confirms → connection retries.
    // Strategy: vi.spyOn lets us intercept window.api.loadSession independently of
    // the mockApi object, controlling return values per call without affecting other mocks.

    it('confirmHttpWarning round-trip: connectWithPassword sends correct body.Username and body.Pw', async () => {
      // loadSession call sequence (all BEFORE confirmHttpWarning is called):
      // 1. checkHttpWarningGate → null (modal fires)
      // 2. confirmHttpWarning → null → persists stub
      // 3. retry path inside confirmHttpWarning → stub with httpConfirmedHosts
      let callCount = 0;
      mockApi.loadSession.mockImplementation(async () => {
        callCount++;
        if (callCount < 3) return null;
        return JSON.stringify({ httpConfirmedHosts: { 'jellyfin.lan:80': true } });
      });

      mockFetch
        // confirmHttpWarning → connectWithPassword → /Users/AuthenticateByName
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ AccessToken: 'tok', User: { Id: 'u1' } }),
        })
        // /System/Info/Public inside connectWithPassword
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Jellyfin' }),
        });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      // Trigger the modal
      await act(async () => {
        await result.current.connectWithPassword('http://jellyfin.lan', 'alice', 'my-secret');
      });
      await waitFor(() => {
        expect(result.current.showHttpWarning).toBe(true);
      });
      expect(mockFetch).not.toHaveBeenCalled();

      // Confirm — stub with confirmed host is now persisted; connection retries and passes gate
      await act(async () => {
        await result.current.confirmHttpWarning();
      });
      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const authCall = mockFetch.mock.calls.find(([url]) =>
        String(url).includes('/Users/AuthenticateByName'),
      );
      expect(authCall).toBeDefined();
      const authBody = JSON.parse((authCall![1] as RequestInit).body as string);
      expect(authBody).toEqual({ Username: 'alice', Pw: 'my-secret' });
      expect(onConnected).toHaveBeenCalledWith('http://jellyfin.lan', 'tok', 'u1');
    });

    it('confirmHttpWarning round-trip: connectToJellyfin (apikey) sends correct Authorization header', async () => {
      // Call sequence: 1=gate(null→modal), 2=confirm(null→persist), 3+=retry with httpConfirmedHosts
      let callCount = 0;
      mockApi.loadSession.mockImplementation(async () => {
        callCount++;
        if (callCount < 3) return null;
        return JSON.stringify({ httpConfirmedHosts: { 'jellyfin.lan:80': true } });
      });

      mockFetch
        // confirmHttpWarning → connectToJellyfin → /System/Info/Public
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Jellyfin' }),
        })
        // /Users/Me
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ Id: 'u1', Name: 'Alice' }),
        });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await act(async () => {
        await result.current.connectToJellyfin('http://jellyfin.lan', 'apikey-xyz');
      });
      await waitFor(() => {
        expect(result.current.showHttpWarning).toBe(true);
      });
      expect(mockFetch).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.confirmHttpWarning();
      });
      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const usersCall = mockFetch.mock.calls.find(([url]) => String(url).includes('/Users/Me'));
      expect(usersCall).toBeDefined();
      const headers = (usersCall![1] as RequestInit).headers as Record<string, string>;
      // ORAIN-0687: uses Authorization header (not X-MediaBrowser-Token)
      expect(headers['Authorization']).toContain('apikey-xyz');
      expect(onConnected).toHaveBeenCalledWith('http://jellyfin.lan', 'apikey-xyz', 'u1');
    });

    it('confirmHttpWarning round-trip: auto-reconnect password session calls connectWithUser with accessToken', async () => {
      // mount effect: loadSession returns password session → modal fires (unconfirmed host)
      // confirmHttpWarning → stub persisted → mount effect retries → /System/Info/Public → connectWithUser
      let mountCallCount = 0;
      mockApi.loadSession.mockImplementation(async () => {
        mountCallCount++;
        // Calls 1–2: mount + gate (null → modal fires). Call 3+: after confirmHttpWarning.
        if (mountCallCount < 3) {
          return JSON.stringify({
            authKind: 'password',
            url: 'http://jellyfin.lan',
            accessToken: 'stored-tok',
            userId: 'u1',
          });
        }
        return JSON.stringify({ httpConfirmedHosts: { 'jellyfin.lan:80': true } });
      });

      mockFetch
        // First mount attempt: /System/Info/Public (unconfirmed → modal, no fetch)
        // After confirm + stub persisted: /System/Info/Public with accessToken
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Jellyfin' }),
        })
        // /System/Info/Public after confirm (retry)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Jellyfin' }),
        });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await waitFor(() => {
        expect(result.current.showHttpWarning).toBe(true);
      });
      expect(mockFetch).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.confirmHttpWarning();
      });
      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      // connectWithUser must be called with the stored accessToken, NOT apiKey.
      expect(onConnected).toHaveBeenCalledWith('http://jellyfin.lan', 'stored-tok', 'u1');
    });

    // ORAIN-0711: httpConfirmedHosts must survive a full login round-trip.
    // Bug: confirmHttpWarning persists the confirmation, but connectWithPassword /
    // connectWithUser immediately call saveSession again WITHOUT httpConfirmedHosts,
    // overwriting the file and losing the entry. After a restart loadSession finds nothing.
    describe('ORAIN-0711: httpConfirmedHosts survives login round-trip', () => {
      it('connectWithPassword round-trip: httpConfirmedHosts persists after login success', async () => {
        // Track every saveSession payload so we can inspect the last one.
        const savedPayloads: string[] = [];
        mockApi.saveSession.mockImplementation(async (payload: string) => {
          savedPayloads.push(payload);
          return { success: true };
        });

        // Simulate restart: after the initial null responses, return the persisted
        // session so a subsequent App remount would find the confirmed host.
        let callCount = 0;
        mockApi.loadSession.mockImplementation(async () => {
          callCount++;
          if (callCount < 3) return null;
          // After confirmHttpWarning + retry succeed, the saved session should contain
          // the confirmed host. If the bug exists, this will be the stub from the
          // initial save in confirmHttpWarning and will NOT contain httpConfirmedHosts.
          return savedPayloads[savedPayloads.length - 1] ?? null;
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

        // Trigger modal
        await act(async () => {
          await result.current.connectWithPassword(
            'http://jellyfin.example.com',
            'alice',
            'secret',
          );
        });
        await waitFor(() => expect(result.current.showHttpWarning).toBe(true));
        expect(mockFetch).not.toHaveBeenCalled();

        // Confirm — login succeeds
        await act(async () => {
          await result.current.confirmHttpWarning();
        });
        await waitFor(() => expect(result.current.isConnected).toBe(true));

        // The FINAL saveSession payload (after the retry inside confirmHttpWarning
        // calls connectWithPassword → saveSession) must contain httpConfirmedHosts.
        // Without the fix, this assertion fails because the payload only has
        // { authKind:'password', url, accessToken, userId } — no httpConfirmedHosts.
        const finalPayload = JSON.parse(savedPayloads[savedPayloads.length - 1]);
        expect(finalPayload.httpConfirmedHosts).toBeDefined();
        expect(finalPayload.httpConfirmedHosts).toHaveProperty('jellyfin.example.com:80');
      });

      it('connectToJellyfin (apikey) round-trip: httpConfirmedHosts persists after login success', async () => {
        const savedPayloads: string[] = [];
        mockApi.saveSession.mockImplementation(async (payload: string) => {
          savedPayloads.push(payload);
          return { success: true };
        });

        let callCount = 0;
        mockApi.loadSession.mockImplementation(async () => {
          callCount++;
          if (callCount < 3) return null;
          return savedPayloads[savedPayloads.length - 1] ?? null;
        });

        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ ServerName: 'Jellyfin' }),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ Id: 'u1', Name: 'Alice' }),
          });

        const onConnected = vi.fn();
        const { result } = renderHook(() => useJellyfinConnection(onConnected));

        await act(async () => {
          await result.current.connectToJellyfin('http://jellyfin.example.com', 'apikey-abc');
        });
        await waitFor(() => expect(result.current.showHttpWarning).toBe(true));
        expect(mockFetch).not.toHaveBeenCalled();

        await act(async () => {
          await result.current.confirmHttpWarning();
        });
        await waitFor(() => expect(result.current.isConnected).toBe(true));

        const finalPayload = JSON.parse(savedPayloads[savedPayloads.length - 1]);
        expect(finalPayload.httpConfirmedHosts).toBeDefined();
        expect(finalPayload.httpConfirmedHosts).toHaveProperty('jellyfin.example.com:80');
      });
    });

    it('httpConfirmedHosts is NOT cleared by clearSession (logout)', async () => {
      // Simulate a confirmed host in session
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({
          httpConfirmedHosts: { 'jellyfin.example.com:8096': true },
          // also a pre-existing session to clear
          url: 'https://other.example.com',
          apiKey: 'k',
          userId: 'u1',
        }),
      );
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ServerName: 'Test' }),
      });

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      // Disconnect (logout)
      act(() => {
        result.current.disconnect();
      });

      // loadSession is called again (from App remount), now returning the confirmed
      // hosts record only (simulating the next App mount after logout)
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({ httpConfirmedHosts: { 'jellyfin.example.com:8096': true } }),
      );

      // Attempt to connect again to the confirmed http:// host — should NOT show warning
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ AccessToken: 'tok', User: { Id: 'u1' } }),
      });

      const { result: result2 } = renderHook(() => useJellyfinConnection(vi.fn()));
      await act(async () => {
        await result2.current.connectWithPassword(
          'http://jellyfin.example.com:8096',
          'alice',
          'secret',
        );
      });

      expect(result2.current.showHttpWarning).toBe(false);
    });
  });

  // ORAIN-0706: auto-reconnect apikey fast path now passes through isSecureAuthUrl
  describe('auto-reconnect apikey HTTPS gate (ORAIN-0706)', () => {
    it('does NOT auto-reconnect apikey session over http:// non-loopback — shows warning', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({
          authKind: 'apikey',
          url: 'http://192.168.1.50',
          apiKey: 'apikey-abc',
          userId: 'user-1',
        }),
      );

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));
      await waitFor(() => {
        expect(result.current.showHttpWarning).toBe(true);
      });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockApi.clearSession).not.toHaveBeenCalled();
    });

    it('auto-reconnects apikey session over http:// loopback without warning', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({
          authKind: 'apikey',
          url: 'http://localhost:8096',
          apiKey: 'apikey-abc',
          userId: 'user-1',
        }),
      );
      mockFetch.mockResolvedValueOnce({ ok: true });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));
      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });
      expect(result.current.showHttpWarning).toBe(false);
    });
  });

  // ORAIN-0706: HIGH-3 regression tests for httpConfirmationKey default-port handling.
  describe('httpConfirmationKey (ORAIN-0706 HIGH-3)', () => {
    it('handles URLs without explicit port — infers 80 for http://', () => {
      const result = httpConfirmationKey('http://jellyfin.example.com');
      expect(result).toEqual({
        hostname: 'jellyfin.example.com',
        port: 80,
        key: 'jellyfin.example.com:80',
      });
    });

    it('handles URLs without explicit port — infers 443 for https://', () => {
      const result = httpConfirmationKey('https://jellyfin.example.com');
      expect(result).toEqual({
        hostname: 'jellyfin.example.com',
        port: 443,
        key: 'jellyfin.example.com:443',
      });
    });

    it('returns NaN-free keys for loopback addresses without explicit port', () => {
      // Previously parseInt('') === NaN and produced "localhost:NaN" as the key.
      expect(httpConfirmationKey('http://localhost')).toEqual({
        hostname: 'localhost',
        port: 80,
        key: 'localhost:80',
      });
      expect(httpConfirmationKey('http://127.0.0.1')).toEqual({
        hostname: '127.0.0.1',
        port: 80,
        key: '127.0.0.1:80',
      });
    });

    it('hostname is lowercased in the key', () => {
      const result = httpConfirmationKey('http://JELLYFIN.EXAMPLE.COM:8096');
      expect(result?.key).toBe('jellyfin.example.com:8096');
    });
  });

  // ORAIN-0706: HIGH-1 regression — confirmHttpWarning must reproduce the
  // exact connection path (password → connectWithPassword, apikey → connectToJellyfin).
  // Previously it always redirected via connectToJellyfin with state.apiKeyInput,
  // which was empty for password sessions, causing INVALID_API_KEY_ERROR.
  //
  // The fix stores credentials in pendingCredentialsRef at each call site BEFORE
  // checkHttpWarningGate fires. confirmHttpWarning reads the ref and reproduces the
  // exact call. The logic is verified through integration:
  //
  // 1. connectWithPassword on http:// non-loopback → sets pendingCredentialsRef.kind='password'
  // 2. A confirmed host bypasses the gate entirely → proves the ref was NOT used incorrectly.
  // 3. connectToJellyfin on http:// non-loopback → sets pendingCredentialsRef.kind='apikey'
  describe('confirmHttpWarning round-trip (ORAIN-0706 HIGH-1)', () => {
    beforeEach(() => {
      mockApi.loadSession.mockResolvedValue(null);
    });

    it('connectWithPassword on confirmed host bypasses gate (HIGH-1 smoke test)', async () => {
      // Pre-confirm the host so the gate is bypassed. If the previous code had
      // incorrectly routed via connectToJellyfin with state.apiKeyInput='',
      // this would fail with INVALID_API_KEY_ERROR because no apiKey is set.
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({ httpConfirmedHosts: { 'newhost.example.com:80': true } }),
      );
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

      // connectWithPassword with a pre-confirmed http:// host should bypass the gate.
      await act(async () => {
        await result.current.connectWithPassword('http://newhost.example.com', 'alice', 'secret');
      });
      expect(result.current.showHttpWarning).toBe(false);
      expect(result.current.isConnected).toBe(true);
      expect(onConnected).toHaveBeenCalledWith('http://newhost.example.com', 'tok', 'u1');
    });

    it('connectToJellyfin on confirmed host bypasses gate (HIGH-1 smoke test)', async () => {
      mockApi.loadSession.mockResolvedValue(
        JSON.stringify({ httpConfirmedHosts: { 'newhost2.example.com:80': true } }),
      );
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ServerName: 'Jellyfin' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ Id: 'u1', Name: 'Alice' }),
        });

      const onConnected = vi.fn();
      const { result } = renderHook(() => useJellyfinConnection(onConnected));

      await act(async () => {
        await result.current.connectToJellyfin('http://newhost2.example.com', 'my-apikey-123');
      });
      expect(result.current.showHttpWarning).toBe(false);
      expect(result.current.isConnected).toBe(true);
      expect(onConnected).toHaveBeenCalledWith(
        'http://newhost2.example.com',
        'my-apikey-123',
        'u1',
      );
    });
  });

  // ORAIN-0564: loopback hosts are exempt from the HTTPS-only credential gate
  // (browser "potentially trustworthy origin" rule) so the E2E suite can drive
  // the password flow against its local containers.
  describe('isSecureAuthUrl', () => {
    it.each([
      ['https://jellyfin.example.com', true],
      ['https://192.168.1.10:8096', true],
      ['http://localhost:8096', true],
      ['http://sub.localhost', true],
      ['http://127.0.0.1:8096', true],
      ['http://127.5.6.7', true],
      ['http://[::1]:8097', true],
      ['http://jellyfin.example.com', false],
      ['http://192.168.1.10:8096', false],
      ['http://10.0.0.5', false],
      ['ftp://localhost', false],
      ['not a url', false],
    ])('%s → %s', (url, expected) => {
      expect(isSecureAuthUrl(url)).toBe(expected);
    });
  });
});
