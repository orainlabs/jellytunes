import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useJellyfinConnection,
  isSecureAuthUrl,
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

    it('blocks non-loopback http:// URLs and never calls fetch', async () => {
      mockApi.loadSession.mockResolvedValue(null);

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectWithPassword('http://jellyfin.test', 'alice', 'secret');
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toMatch(/https/i);
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

    it('refuses to reconnect over http:// (clears session, never fetches)', async () => {
      // ORAIN-0564 SO-2 QA: a stored password session URL that isn't HTTPS
      // must NOT be used to leak the accessToken over plaintext HTTP on every
      // restart. Defends against a future regression that stores an http://
      // URL into a password session.
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
      expect(mockApi.clearSession).toHaveBeenCalled();
      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toMatch(/Stored session URL is not HTTPS/);
      expect(onConnected).not.toHaveBeenCalled();
      expect(mockApi.saveSession).not.toHaveBeenCalled();
    });
  });

  // ORAIN-0680 — API key mode must block http:// non-loopback, same as password.
  describe('connectToJellyfin HTTPS gate', () => {
    it('blocks http:// non-loopback and never calls fetch', async () => {
      mockApi.loadSession.mockResolvedValue(null);

      const { result } = renderHook(() => useJellyfinConnection(vi.fn()));

      await act(async () => {
        await result.current.connectToJellyfin('http://jellyfin.test', 'apikey-abc');
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toMatch(/https/i);
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
