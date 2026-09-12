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
  // ORAIN-0706: HTTP warning modal state
  showHttpWarning: boolean;
  pendingHttpUrl: string | null;
}

/**
 * ORAIN-0564 SO-1: a saved session is now keyed by `authKind`. SO-2 will
 * take over persistence; this hook only defines the wire shape.
 *
 *   - apikey:    { authKind: 'apikey',    url, apiKey, userId }
 *   - password:  { authKind: 'password',  url, accessToken, userId }   // NEVER the password
 *
 * ORAIN-0706: an optional `httpConfirmedHosts` map is stored alongside
 * the session, keyed by `hostname:port` (lowercase hostname), to remember
 * which insecure (http:// non-loopback) servers the user has explicitly
 * confirmed. This map survives clearSession/logout — it is never cleared.
 */
interface SavedSession {
  authKind?: 'apikey' | 'password';
  url: string;
  apiKey?: string;
  accessToken?: string;
  userId?: string;
  // ORAIN-0706
  httpConfirmedHosts?: Record<string, true>;
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

/**
 * ORAIN-0706: load the raw encrypted storage to read httpConfirmedHosts only.
 * Returns null if the file is absent or corrupt (fail-closed — unconfirmed).
 * Unlike loadSession(), this does NOT require apiKey/accessToken to be present,
 * because httpConfirmedHosts may exist independently of any active session.
 */
async function loadHttpConfirmations(): Promise<Record<string, true> | null> {
  try {
    const raw = await window.api.loadSession();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.httpConfirmedHosts === 'object' && parsed.httpConfirmedHosts !== null) {
      return parsed.httpConfirmedHosts;
    }
    return null;
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

/**
 * ORAIN-0706: check whether a http:// non-loopback host has been previously
 * confirmed by the user. Returns true if `hostname:port` is in the confirmed map.
 * Key matching is case-insensitive on hostname.
 */
export function isHttpHostConfirmed(
  httpConfirmedHosts: Record<string, true> | null | undefined,
  hostname: string,
  port: number,
): boolean {
  if (!httpConfirmedHosts) return false;
  const key = `${hostname.toLowerCase()}:${port}`;
  // ORAIN-0706: both the stored key and lookup key are lowercased so that
  // the hostname comparison is case-insensitive (hostname is case-insensitive per RFC).
  return Boolean(Object.keys(httpConfirmedHosts).some((k) => k.toLowerCase() === key));
}

/**
 * ORAIN-0706: build the confirmation storage key from a URL.
 * Handles default ports: `new URL('http://example.com').port === ''`,
 * so we infer the port from the protocol when the URL doesn't specify one.
 */
export function httpConfirmationKey(
  url: string,
): { hostname: string; port: number; key: string } | null {
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    const port = u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80;
    return { hostname, port, key: `${hostname}:${port}` };
  } catch {
    return null;
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
    showHttpWarning: false,
    pendingHttpUrl: null,
  });

  // ORAIN-0706: mutable ref so that async confirmHttpWarning can read the pending URL
  const pendingHttpUrlRef = { current: '' as string | null };

  // ORAIN-0706: stores the credentials that triggered the modal so confirmHttpWarning
  // can reproduce the exact connection path (password vs apikey).
  type PendingCredentials =
    | { kind: 'password'; url: string; username: string; password: string }
    | { kind: 'apikey'; url: string; apiKey: string }
    | { kind: 'accessToken'; url: string; accessToken: string; userId: string };
  const pendingCredentialsRef = { current: null as PendingCredentials | null };

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
    void (async () => {
      const session = await loadSession();
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

      // ORAIN-0706: before attempting any network, check if we need to show
      // the HTTP warning modal. This gates ALL four reconnect paths.

      if (userId && apiKey) {
        // ORAIN-0706: apikey fast path — check gate before making network request
        const parsed = httpConfirmationKey(normalized);
        if (!isSecureAuthUrl(normalized) && parsed) {
          const confirmations = await loadHttpConfirmations();
          const confirmed = isHttpHostConfirmed(confirmations, parsed.hostname, parsed.port);
          if (!confirmed) {
            pendingHttpUrlRef.current = normalized;
            pendingCredentialsRef.current = { kind: 'apikey', url: normalized, apiKey };
            setState((prev) => ({
              ...prev,
              isConnecting: false,
              showHttpWarning: true,
              pendingHttpUrl: normalized,
            }));
            return;
          }
          // Host confirmed — fall through to connect
        }
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
        // ORAIN-0706: same HTTP warning gate for password sessions.
        const parsed = httpConfirmationKey(normalized);
        if (!isSecureAuthUrl(normalized) && parsed) {
          const confirmations = await loadHttpConfirmations();
          const confirmed = isHttpHostConfirmed(confirmations, parsed.hostname, parsed.port);
          if (!confirmed) {
            pendingHttpUrlRef.current = normalized;
            pendingCredentialsRef.current = {
              kind: 'accessToken',
              url: normalized,
              accessToken,
              userId,
            };
            setState((prev) => ({
              ...prev,
              isConnecting: false,
              showHttpWarning: true,
              pendingHttpUrl: normalized,
            }));
            return;
          }
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
    })();
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

  /**
   * ORAIN-0706: internal helper — checks the HTTP warning gate before proceeding.
   * When the gate fires, sets showHttpWarning=true and returns true (blocked).
   * When the gate passes, returns false (proceed).
   * Stores credentials in pendingCredentialsRef so confirmHttpWarning can reproduce
   * the exact connection path (password vs apikey).
   */
  async function checkHttpWarningGate(credentials: PendingCredentials): Promise<boolean> {
    const { url } = credentials;
    if (isSecureAuthUrl(url)) return false;
    const parsed = httpConfirmationKey(url);
    if (!parsed) return false;
    // ORAIN-0706: always check loadHttpConfirmations directly — the confirmation
    // map survives logout/clearSession even when loadSession() returns null.
    const confirmations = await loadHttpConfirmations();
    const confirmed = isHttpHostConfirmed(confirmations, parsed.hostname, parsed.port);
    if (confirmed) return false;
    // Block — show the modal
    pendingHttpUrlRef.current = url;
    setState((prev) => ({
      ...prev,
      isConnecting: false,
      showHttpWarning: true,
      pendingHttpUrl: url,
    }));
    return true;
  }

  const connectToJellyfin = async (url: string, apiKey: string): Promise<boolean> => {
    setState((prev) => ({ ...prev, isConnecting: true, error: null }));
    // ORAIN-0706: replaced hard HTTPS error with a modal confirmation flow.
    // Fall-through to the modal instead of returning early here.
    // Store credentials before the gate call so confirmHttpWarning can reproduce
    // this exact call (not redirect to a different login path).
    pendingCredentialsRef.current = { kind: 'apikey', url, apiKey };
    const blocked = await checkHttpWarningGate({ kind: 'apikey', url, apiKey });
    if (blocked) return false;

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
   * ORAIN-0706: replaced the hard HTTPS error with a modal confirmation flow.
   */
  const connectWithPassword = async (
    url: string,
    username: string,
    password: string,
  ): Promise<boolean> => {
    setState((prev) => ({ ...prev, isConnecting: true, error: null }));
    // ORAIN-0706: HTTP warning gate instead of hard error
    pendingCredentialsRef.current = { kind: 'password', url, username, password };
    const blocked = await checkHttpWarningGate({ kind: 'password', url, username, password });
    if (blocked) return false;

    try {
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

  // ORAIN-0706: called by App when the user confirms the HTTP warning modal.
  // Persists the host confirmation and re-attempts the connection.
  const confirmHttpWarning = async (): Promise<void> => {
    const pendingUrl = pendingHttpUrlRef.current;
    if (!pendingUrl) return;

    const parsed = httpConfirmationKey(pendingUrl);
    if (!parsed) return;

    // ORAIN-0706: read httpConfirmedHosts separately so we can persist even when
    // no active session exists (confirmation survives logout/clearSession).
    const existingConfirmations = (await loadHttpConfirmations()) ?? {};
    const httpConfirmedHosts = { ...existingConfirmations, [parsed.key]: true };

    // Try to merge with existing session fields; if none, store confirmation only.
    const session = await loadSession();
    if (session) {
      await saveSession({ ...session, httpConfirmedHosts } as SavedSession & { userId: string });
    } else {
      await saveSession({ httpConfirmedHosts } as SavedSession & { userId: string });
    }

    // Dismiss the modal and retry the connection.
    // Clear the warning state; the connection call will find the host confirmed.
    setState((prev) => ({ ...prev, showHttpWarning: false, pendingHttpUrl: null }));
    pendingHttpUrlRef.current = null;

    // Reproduce the exact connection path that triggered the modal:
    // password sessions go through connectWithPassword, apikey through connectToJellyfin,
    // accessToken sessions re-run the mount fetch with the stored token.
    const creds = pendingCredentialsRef.current;
    pendingCredentialsRef.current = null;
    setState((prev) => ({ ...prev, isConnecting: true }));
    if (creds?.kind === 'password') {
      await connectWithPassword(creds.url, creds.username, creds.password);
    } else if (creds?.kind === 'apikey') {
      await connectToJellyfin(creds.url, creds.apiKey);
    } else if (creds?.kind === 'accessToken') {
      // Re-run the auto-reconnect fetch with the stored accessToken.
      // On success, connectWithUser will set isConnected=true.
      await fetch(`${creds.url}/System/Info/Public`, {
        signal: AbortSignal.timeout(5000),
        headers: jellyfinHeaders(creds.accessToken),
      })
        .then((r) =>
          r.ok
            ? connectWithUser(creds.url, creds.accessToken, creds.userId)
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
      // Fallback for backward compatibility: try with whatever is in state.
      await connectToJellyfin(pendingUrl, state.apiKeyInput ?? '');
    }
  };

  // ORAIN-0706: called by App when the user cancels the HTTP warning modal.
  const cancelHttpWarning = (): void => {
    pendingHttpUrlRef.current = null;
    setState((prev) => ({
      ...prev,
      showHttpWarning: false,
      pendingHttpUrl: null,
    }));
  };

  return {
    ...state,
    connectToJellyfin,
    connectWithPassword,
    handleUserSelect,
    handleUserSelectorCancel,
    disconnect,
    confirmHttpWarning,
    cancelHttpWarning,
    setUrlInput: (v: string) => setState((prev) => ({ ...prev, urlInput: v })),
    setApiKeyInput: (v: string) => setState((prev) => ({ ...prev, apiKeyInput: v })),
  };
}
