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

export function useJellyfinConnection(
  onConnected: (url: string, apiKey: string, userId: string) => void
) {
  const [state, setState] = useState<ConnectionState>({
    jellyfinConfig: null,
    userId: null,
    isConnected: false,
    isConnecting: false,
    error: null,
    users: [],
    showUserSelector: false,
    pendingConfig: null,
    urlInput: '',
    apiKeyInput: '',
  })

  // Load saved config on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('jellysync-config')
      if (saved) {
        const { url, apiKey } = JSON.parse(saved)
        if (url && apiKey) {
          setState(prev => ({ ...prev, pendingConfig: { url, apiKey }, urlInput: url, apiKeyInput: apiKey }))
        }
      }
    } catch { /* ignore */ }
  }, [])

  // Save config when connected
  useEffect(() => {
    if (state.jellyfinConfig?.url && state.jellyfinConfig?.apiKey) {
      try {
        localStorage.setItem('jellysync-config', JSON.stringify({
          url: state.jellyfinConfig.url,
          apiKey: state.jellyfinConfig.apiKey,
        }))
      } catch { /* ignore */ }
    }
  }, [state.jellyfinConfig])

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

  const connectWithUser = async (url: string, apiKey: string, userId: string): Promise<void> => {
    setState(prev => ({
      ...prev,
      jellyfinConfig: { url, apiKey, userId },
      userId,
      isConnected: true,
    }))
    onConnected(url, apiKey, userId)
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
        }))
        return false
      }
      setState(prev => ({ ...prev, error: 'Could not identify user. Please select manually.' }))
      return false
    } catch (err) {
      setState(prev => ({ ...prev, error: err instanceof Error ? err.message : 'Connection failed' }))
      return false
    } finally {
      setState(prev => ({ ...prev, isConnecting: false }))
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
    setState(prev => ({ ...prev, isConnected: false, jellyfinConfig: null }))
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
