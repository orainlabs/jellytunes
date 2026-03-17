import { Music, RefreshCw, Settings, Check, X } from 'lucide-react'

interface AppHeaderProps {
  isConnected: boolean
  onDisconnect: () => void
}

export function AppHeader({ isConnected, onDisconnect }: AppHeaderProps): JSX.Element {
  return (
    <header className="h-14 border-b border-zinc-800 flex items-center justify-between px-4">
      <div className="flex items-center gap-2">
        <Music className="w-6 h-6 text-blue-500" />
        <h1 className="text-lg font-semibold">Jellysync</h1>
        {isConnected && (
          <span className="text-xs text-green-500 flex items-center gap-1">
            <Check className="w-3 h-3" /> Connected
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button className="p-2 hover:bg-zinc-800 rounded-lg">
          <RefreshCw className="w-5 h-5" />
        </button>
        <button className="p-2 hover:bg-zinc-800 rounded-lg">
          <Settings className="w-5 h-5" />
        </button>
        <button onClick={onDisconnect} className="p-2 hover:bg-zinc-800 rounded-lg">
          <X className="w-5 h-5" />
        </button>
      </div>
    </header>
  )
}
