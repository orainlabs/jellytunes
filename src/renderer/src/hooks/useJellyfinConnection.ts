import { useState, useEffect } from 'react';
import type { JellyfinConfig, JellyfinUser } from '../appTypes';
import { jellyfinHeaders } from '../utils/jellyfin';
import { getAuthenticateHeader } from '../utils/authContext';

// Exported so tests can assert on the exact value without a fragile source parser.
// ORAIN-0687: replaced "Could not identify user. Please select manually." which
// implied a selector (confusing when userList is empty) with a message that
// correctly points to the API key as the likely cause.
export const INVALID_API_KEY_ERROR = 'Could not authenticate. Check your API key and try again.';

interface ConnectionState {
  jellyfinConfig: JellyfinConfig | null;
  userId: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  users: JellyfinUser[];
  showUserSelector: boolean;
  pendingConfig: { url: string; apiKey: string } | null;
  urlInput: string;
  apiKeyInput: string;
}

/**
 * ORAIN-0564 SO-1: a saved session is now keyed by `authKind`. SO-2 will
 * take over persistence; this hook only defines the wire shape.
 *
 *   - apikey:    { authKind: 'apikey',    url, apiKey, userId }
 *   - password:  { authKind: 'password',  url, accessToken, userId }   // NEVER the password
 */
interface SavedSession {
  authKind?: 'apikey' | 'password';
  url: string;
  apiKey?: string;
  accessToken?: string;
  userId?: string;
}

// Session is stored encrypted via main-process safeStorage IPC (not localStorage)
async function saveSession(
  payload: SavedSession & { userId: string },
): Promise<{ success: boolean; reason?: string }> {
  try {
    const result = await window.api.saveSession(JSON.stringify(payload));
    if (!result.success) {
      window.api.logError(`Session save failed: ${result.reason ?? 'unknown'}`);
      return result;
    }
    return result;
  } catch {
    /* ignore — connection still works without persistent session */
  }
  return { success: true };
}

async function loadSession(): Promise<SavedSession | null> {
  try {
    const raw = await window.api.loadSession();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.url) return null;
    // Either an apiKey (apikey auth) OR an accessToken (password auth) must
    // be present for the session to be usable.
    if (!parsed.apiKey && !parsed.accessToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function clearSession(): Promise<void> {
  try {
    await window.api.clearSession();
  } catch {
    /* ignore */
  }
}

/**
 * ORAIN-0679: returns the saved authKind without loading the full session.
 * Used by App.tsx to derive initialMode for LoginScreen without triggering
 * a connection attempt.
 */
export async function loadSavedAuthKind(): Promise<'apikey' | 'password' | null> {
  const session = await loadSession();
  return session?.authKind ?? null;
}

/**
 * ORAIN-0564 SO-1: refuse to send credentials over plain HTTP.
 *
 * Loopback hosts are exempt: `http://localhost` / `http://127.0.0.1` / `http://[::1]`
 * never leave the machine, so there is no plaintext-on-the-wire exposure. This
 * mirrors the browser "potentially trustworthy origin" rule (WHATWG secure
 * contexts, RFC 6761) and lets the E2E suite drive the password flow against its
 * local containers without a TLS terminator.
 */
export function isSecureAuthUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'https:') return true;
    if (protocol !== 'http:') return false;
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      /^127(?:\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

export function useJellyfinConnection(
  onConnected: (url: string, apiKey: string, userId: string) => void,
) {
  const [state, setState] = useState<ConnectionState>({
    jellyfinConfig: null,
    userId: null,
    isConnected: false,
    // Start in connecting state — we'll check for a saved session asynchronously on mount
    isConnecting: true,
    error: null,
    users: [],
    showUserSelector: false,
    pendingConfig: null,
    urlInput: '',
    apiKeyInput: '',
  });

  const connectWithUser = async (url: string, apiKey: string, userId: string): Promise<void> => {
    // ORAIN-0578: a failed save no longer drives any UI. The snap keyring
    // warning is one entry of the permission report surfaced by
    // `useSnapPermissions`, which doesn't need a feature to fail first —
    // the old flag was raised in the same update that set `isConnected`,
    // which unmounted the only screen that rendered it.
    await saveSession({ authKind: 'apikey', url, apiKey, userId });
    setState((prev) => ({
      ...prev,
      jellyfinConfig: { url, apiKey, userId },
      userId,
      isConnected: true,
      isConnecting: false,
      error: null,
    }));
    onConnected(url, apiKey, userId);
  };

  // Auto-connect on mount if an encrypted session is saved
  useEffect(() => {
    void loadSession().then((session) => {
      if (!session) {
        setState((prev) => ({ ...prev, isConnecting: false }));
        return;
      }

      const { url, apiKey, accessToken, userId } = session;
      const normalized = url.replace(/\/$/, '');
      // ORAIN-0564 SO-1: SO-2 will own auto-reconnect for password sessions.
      // For this iteration we only auto-reconnect apikey sessions, which
      // already work today. Password sessions keep `urlInput` populated so
      // the user can re-authenticate, but we don't try to re-validate the
      // server or restore the connection.
      setState((prev) => ({
        ...prev,
        urlInput: normalized,
        apiKeyInput: apiKey ?? '',
      }));

      if (userId && apiKey) {
        // Fast path: we have userId + apiKey, just validate server is reachable
        void fetch(`${normalized}/System/Info/Public`, { signal: AbortSignal.timeout(5000) })
          .then((r) =>
            r.ok
              ? connectWithUser(normalized, apiKey, userId)
              : Promise.reject(new Error(`Server returned ${r.status}`)),
          )
          .catch(() => {
            void clearSession();
            setState((prev) => ({
              ...prev,
              isConnecting: false,
              error: 'Could not reconnect. Please log in again.',
            }));
          });
      } else if (userId && accessToken) {
        // ORAIN-0564 SO-2: password sessions now auto-reconnect. We validate
        // the accessToken against /System/Info/Public by sending the same
        // MediaBrowser Authorization header every other Jellyfin request uses
        // — without this, /System/Info/Public would only prove the server is
        // reachable, not that the stored token is still valid. On success,
        // connectWithUser repurposes the accessToken as the `apiKey` field
        // of jellyfinConfig — downstream code already understands that
        // slot's value is just "the credential the server authenticates
        // with".
        //
        // Runtime assumption (test asserts): the request to
        // /System/Info/Public carries `Authorization: MediaBrowser
        // Token="<accessToken>"`. A stored token that fails this check is
        // cleared and we surface the same generic "Could not reconnect"
        // message as the apikey branch — we deliberately don't distinguish
        // server-down from token-revoked, because that distinction would
        // leak which user exists.
        //
        // ORAIN-0564 SO-2 QA: same HTTPS gate as `connectWithPassword`. A
        // stored password session URL must be https:// — otherwise we would
        // leak the accessToken over plaintext HTTP on every restart.
        // connectWithPassword already refuses to save an http:// URL, so
        // today this branch is unreachable; the gate is a defense against a
        // future regression that lets a non-HTTPS password session land in
        // the encrypted file.
        if (!isSecureAuthUrl(normalized)) {
          void clearSession();
          setState((prev) => ({
            ...prev,
            isConnecting: false,
            error: 'Stored session URL is not HTTPS; refusing to reconnect.',
          }));
          return;
        }
        void fetch(`${normalized}/System/Info/Public`, {
          signal: AbortSignal.timeout(5000),
          headers: jellyfinHeaders(accessToken),
        })
          .then((r) =>
            r.ok
              ? connectWithUser(normalized, accessToken, userId)
              : Promise.reject(new Error(`Server returned ${r.status}`)),
          )
          .catch(() => {
            void clearSession();
            setState((prev) => ({
              ...prev,
              isConnecting: false,
              error: 'Could not reconnect. Please log in again.',
            }));
          });
      } else {
        // Legacy session without userId — try /Users/Me
        void connectToJellyfin(normalized, apiKey ?? '');
      }
    });
  }, []); // intentional: run once on mount

  const fetchUserList = async (baseUrl: string, apiKey: string): Promise<JellyfinUser[]> => {
    const headers = jellyfinHeaders(apiKey);
    const authRes = await fetch(`${baseUrl}/Users`, { headers }).catch(() => null);
    if (authRes?.ok) {
      const users: JellyfinUser[] = await authRes.json();
      if (users.length > 0) return users;
    }
    const publicRes = await fetch(`${baseUrl}/Users/Public`).catch(() => null);
    if (publicRes?.ok) {
      const users: JellyfinUser[] = await publicRes.json();
      if (users.length > 0) return users;
    }
    return [];
  };

  const connectToJellyfin = async (url: string, apiKey: string): Promise<boolean> => {
    setState((prev) => ({ ...prev, isConnecting: true, error: null }));
    // ORAIN-0680: same HTTPS gate as connectWithPassword — an API key over
    // plaintext HTTP exposes an admin-capable, non-expiring credential.
    if (!isSecureAuthUrl(url)) {
      setState((prev) => ({
        ...prev,
        isConnecting: false,
        error: 'HTTPS is required for API key authentication.',
      }));
      return false;
    }
    try {
      const normalizedUrl = url.replace(/\/$/, '');
      const headers = jellyfinHeaders(apiKey);
      const response = await fetch(`${normalizedUrl}/System/Info/Public`, {
        method: 'GET',
        headers,
      });
      if (!response.ok) {
        throw new Error(`Connection error: ${response.status} ${response.statusText}`);
      }
      const userRes = await fetch(`${normalizedUrl}/Users/Me`, { headers }).catch(() => null);
      if (userRes?.ok) {
        const userData = await userRes.json();
        await connectWithUser(normalizedUrl, apiKey, userData.Id);
        return true;
      }
      const userList = await fetchUserList(normalizedUrl, apiKey);
      if (userList.length > 0) {
        setState((prev) => ({
          ...prev,
          users: userList,
          pendingConfig: { url: normalizedUrl, apiKey },
          showUserSelector: true,
          isConnecting: false,
        }));
        return false;
      }
      setState((prev) => ({
        ...prev,
        isConnecting: false,
        error: INVALID_API_KEY_ERROR,
      }));
      return false;
    } catch (err) {
      // ORAIN-0685: when fetch fails to reach the server (TypeError with
      // "Failed to fetch") show a clear message; preserve specific HTTP error
      // messages (e.g. "Connection error: 500") for all other errors.
      const isNetworkError = err instanceof TypeError && err.message === 'Failed to fetch';
      if (isNetworkError) {
        window.api.logError(err.message);
        setState((prev) => ({
          ...prev,
          isConnecting: false,
          error: "Couldn't reach the server. Check the address and that Jellyfin is running.",
        }));
      } else {
        setState((prev) => ({
          ...prev,
          isConnecting: false,
          error: err instanceof Error ? err.message : 'Connection failed',
        }));
      }
      return false;
    }
  };

  /**
   * ORAIN-0564 SO-1: connect by username + password.
   *
   * Refuses to transmit over `http://` (returns an error and skips the
   * request). The 401 path is generic — we don't leak whether the user
   * exists, and there is no retry loop: the caller decides what to do.
   */
  const connectWithPassword = async (
    url: string,
    username: string,
    password: string,
  ): Promise<boolean> => {
    setState((prev) => ({ ...prev, isConnecting: true, error: null }));
    try {
      if (!isSecureAuthUrl(url)) {
        setState((prev) => ({
          ...prev,
          isConnecting: false,
          error: 'HTTPS is required for password authentication.',
        }));
        return false;
      }
      const normalizedUrl = url.replace(/\/$/, '');
      const authHeader = getAuthenticateHeader();
      const response = await fetch(`${normalizedUrl}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ Username: username, Pw: password }),
      });
      if (!response.ok) {
        // Generic message — we deliberately don't reveal whether the user
        // exists or the password was wrong.
        setState((prev) => ({
          ...prev,
          isConnecting: false,
          error: 'Invalid username or password',
        }));
        return false;
      }
      const data = await response.json();
      const accessToken: string | undefined = data.AccessToken;
      const userId: string | undefined = data.User?.Id;
      if (!accessToken || !userId) {
        setState((prev) => ({
          ...prev,
          isConnecting: false,
          error: 'Authentication response was incomplete.',
        }));
        return false;
      }
      // Persist the session WITHOUT the password. The accessToken is the
      // secret from now on.
      await saveSession({
        authKind: 'password',
        url: normalizedUrl,
        accessToken,
        userId,
      });
      setState((prev) => ({
        ...prev,
        jellyfinConfig: { url: normalizedUrl, apiKey: accessToken, userId },
        userId,
        isConnected: true,
        isConnecting: false,
        error: null,
      }));
      onConnected(normalizedUrl, accessToken, userId);
      return true;
    } catch (err) {
      // ORAIN-0685: when fetch fails to reach the server (TypeError with
      // "Failed to fetch") show a clear message; preserve specific HTTP error
      // messages (e.g. "Invalid username or password") for all other errors.
      const isNetworkError = err instanceof TypeError && err.message === 'Failed to fetch';
      if (isNetworkError) {
        window.api.logError(err.message);
        setState((prev) => ({
          ...prev,
          isConnecting: false,
          error: "Couldn't reach the server. Check the address and that Jellyfin is running.",
        }));
      } else {
        setState((prev) => ({
          ...prev,
          isConnecting: false,
          error: err instanceof Error ? err.message : 'Connection failed',
        }));
      }
      return false;
    }
  };

  const handleUserSelect = async (user: JellyfinUser): Promise<void> => {
    if (!state.pendingConfig) return;
    const { url, apiKey } = state.pendingConfig;
    setState((prev) => ({ ...prev, showUserSelector: false, pendingConfig: null }));
    await connectWithUser(url, apiKey, user.Id);
  };

  const handleUserSelectorCancel = (): void => {
    setState((prev) => ({
      ...prev,
      showUserSelector: false,
      pendingConfig: null,
      users: [],
      isConnecting: false,
    }));
  };

  const disconnect = (): void => {
    void clearSession(); // fire-and-forget async clear
    setState((prev) => ({
      ...prev,
      isConnected: false,
      jellyfinConfig: null,
      userId: null,
      urlInput: '',
      apiKeyInput: '',
    }));
  };

  return {
    ...state,
    connectToJellyfin,
    connectWithPassword,
    handleUserSelect,
    handleUserSelectorCancel,
    disconnect,
    setUrlInput: (v: string) => setState((prev) => ({ ...prev, urlInput: v })),
    setApiKeyInput: (v: string) => setState((prev) => ({ ...prev, apiKeyInput: v })),
  };
}
