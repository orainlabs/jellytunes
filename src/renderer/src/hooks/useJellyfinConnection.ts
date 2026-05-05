import { useState, useEffect } from 'react'
import type { JellyfinConfig, JellyfinUser } from '../appTypes'
import { jellyfinHeaders } from '../utils/jellyfin'

interface ConnectionState {
  jellyfinConfig: JellyfinConfig | null
  userId: string | null
  isConnected: boolean
  isConnecting: boolean
  error: string | null
  users: JellyfinUser[]
  showUserSelector: boolean
  pendingConfig: { url: string; apiKey: string } | null
  urlInput: string
  apiKeyInput: string
}

interface SavedSession {
  url: string
  apiKey: string
  userId?: string
}

// Session is stored encrypted via main-process safeStorage IPC (not localStorage)
async function saveSession(url: string, apiKey: string, userId: string): Promise<{ success: boolean }> {
  try {
    const result = await window.api.saveSession(JSON.stringify({ url, apiKey, userId }))
    if (!result.success) {
      window.api.logError(`Session save failed: ${result.reason ?? 'unknown'}`)
      return result
    }
    return result
  } catch { /* ignore — connection still works without persistent session */ }
  return { success: true }
}

async function loadSession(): Promise<SavedSession | null> {
  try {
    const raw = await window.api.loadSession()
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed.url && parsed.apiKey ? parsed : null
  } catch {
    return null
  }
}

async function clearSession(): Promise<void> {
  try { await window.api.clearSession() } catch { /* ignore */ }
}

export function useJellyfinConnection(
  onConnected: (url: string, apiKey: string, userId: string) => void
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
  })

  const connectWithUser = async (url: string, apiKey: string, userId: string): Promise<void> => {
    await saveSession(url, apiKey, userId)
    setState(prev => ({
      ...prev,
      jellyfinConfig: { url, apiKey, userId },
      userId,
      isConnected: true,
      isConnecting: false,
      error: null,
    }))
    onConnected(url, apiKey, userId)
  }

  // Auto-connect on mount if an encrypted session is saved
  useEffect(() => {
    loadSession().then(session => {
      if (!session) {
        setState(prev => ({ ...prev, isConnecting: false }))
        return
      }

      const { url, apiKey, userId } = session
      const normalized = url.replace(/\/$/, '')
      setState(prev => ({ ...prev, urlInput: normalized, apiKeyInput: apiKey }))

      if (userId) {
        // Fast path: we have userId, just validate server is reachable
        fetch(`${normalized}/System/Info/Public`, { signal: AbortSignal.timeout(5000) })
          .then(r => r.ok
            ? connectWithUser(normalized, apiKey, userId)
            : Promise.reject(new Error(`Server returned ${r.status}`))
          )
          .catch(() => {
            clearSession()
            setState(prev => ({ ...prev, isConnecting: false, error: 'Could not reconnect. Please log in again.' }))
          })
      } else {
        // Legacy session without userId — try /Users/Me
        connectToJellyfin(normalized, apiKey)
      }
    })
  }, []) // intentional: run once on mount

  const fetchUserList = async (baseUrl: string, apiKey: string): Promise<JellyfinUser[]> => {
    const headers = jellyfinHeaders(apiKey)
    const authRes = await fetch(`${baseUrl}/Users`, { headers }).catch(() => null)
    if (authRes?.ok) {
      const users: JellyfinUser[] = await authRes.json()
      if (users.length > 0) return users
    }
    const publicRes = await fetch(`${baseUrl}/Users/Public`).catch(() => null)
    if (publicRes?.ok) {
      const users: JellyfinUser[] = await publicRes.json()
      if (users.length > 0) return users
    }
    return []
  }

  const connectToJellyfin = async (url: string, apiKey: string): Promise<boolean> => {
    setState(prev => ({ ...prev, isConnecting: true, error: null }))
    try {
      const normalizedUrl = url.replace(/\/$/, '')
      const headers = jellyfinHeaders(apiKey)
      const response = await fetch(`${normalizedUrl}/System/Info/Public`, { method: 'GET', headers })
      if (!response.ok) {
        throw new Error(`Connection error: ${response.status} ${response.statusText}`)
      }
      const userRes = await fetch(`${normalizedUrl}/Users/Me`, { headers }).catch(() => null)
      if (userRes?.ok) {
        const userData = await userRes.json()
        await connectWithUser(normalizedUrl, apiKey, userData.Id)
        return true
      }
      const userList = await fetchUserList(normalizedUrl, apiKey)
      if (userList.length > 0) {
        setState(prev => ({
          ...prev,
          users: userList,
          pendingConfig: { url: normalizedUrl, apiKey },
          showUserSelector: true,
          isConnecting: false,
        }))
        return false
      }
      setState(prev => ({ ...prev, isConnecting: false, error: 'Could not identify user. Please select manually.' }))
      return false
    } catch (err) {
      setState(prev => ({ ...prev, isConnecting: false, error: err instanceof Error ? err.message : 'Connection failed' }))
      return false
    }
  }

  const handleUserSelect = async (user: JellyfinUser): Promise<void> => {
    if (!state.pendingConfig) return
    const { url, apiKey } = state.pendingConfig
    setState(prev => ({ ...prev, showUserSelector: false, pendingConfig: null }))
    await connectWithUser(url, apiKey, user.Id)
  }

  const handleUserSelectorCancel = (): void => {
    setState(prev => ({ ...prev, showUserSelector: false, pendingConfig: null, users: [], isConnecting: false }))
  }

  const disconnect = (): void => {
    clearSession() // fire-and-forget async clear
    setState(prev => ({ ...prev, isConnected: false, jellyfinConfig: null, userId: null, urlInput: '', apiKeyInput: '' }))
  }

  return {
    ...state,
    connectToJellyfin,
    handleUserSelect,
    handleUserSelectorCancel,
    disconnect,
    setUrlInput: (v: string) => setState(prev => ({ ...prev, urlInput: v })),
    setApiKeyInput: (v: string) => setState(prev => ({ ...prev, apiKeyInput: v })),
  }
}
