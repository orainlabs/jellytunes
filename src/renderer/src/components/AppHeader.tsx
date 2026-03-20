import { Music, Check, LogOut } from 'lucide-react'

interface AppHeaderProps {
  isConnected: boolean
  serverUrl?: string | null
  onDisconnect: () => void
}

export function AppHeader({ isConnected, serverUrl, onDisconnect }: AppHeaderProps): JSX.Element {
  const hostname = serverUrl ? (() => { try { return new URL(serverUrl).hostname } catch { return serverUrl } })() : null

  return (
    <header className="h-14 border-b border-zinc-800 flex items-center justify-between px-4">
      <div className="flex items-center gap-2">
        <Music className="w-6 h-6 text-jf-purple" />
        <h1 className="text-lg font-semibold">Jellysync</h1>
        {isConnected && (
          <span className="text-xs text-jf-cyan flex items-center gap-1">
            <Check className="w-3 h-3" /> {hostname ?? 'Connected'}
          </span>
        )}
      </div>
      {isConnected && (
        <button
          onClick={onDisconnect}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Disconnect
        </button>
      )}
    </header>
  )
}
