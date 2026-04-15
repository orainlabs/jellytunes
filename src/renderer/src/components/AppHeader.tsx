import { useState } from 'react'
import { Check, Info, LogOut } from 'lucide-react'
import { GradientMusicIcon } from './GradientMusicIcon'
import { AboutModal } from './AboutModal'

interface AppHeaderProps {
  isConnected: boolean
  serverUrl?: string | null
  onDisconnect: () => void
}

export function AppHeader({ isConnected, serverUrl, onDisconnect }: AppHeaderProps): JSX.Element {
  const hostname = serverUrl ? (() => { try { return new URL(serverUrl).hostname } catch { return serverUrl } })() : null
  const [showAbout, setShowAbout] = useState(false)

  return (
    <header className="h-14 border-b border-outline_variant flex items-center justify-between px-4">
      <div className="flex items-center gap-2">
        <GradientMusicIcon className="w-6 h-6" />
        <h1 className="text-headline-md">JellyTunes</h1>
        {(import.meta.env.DEV || import.meta.env.VITE_DEV_BUILD) && (
          <span className="ml-2 px-1.5 py-0.5 text-xs font-mono font-bold bg-warning/20 text-warning border border-warning/40 rounded">
            DEV
          </span>
        )}
        {isConnected && (
          <span data-testid="connection-status" className="text-label-md text-primary flex items-center gap-1">
            <Check className="w-3 h-3" /> {hostname ?? 'Connected'}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          data-testid="about-button"
          onClick={() => setShowAbout(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-body-md text-on_surface_variant hover:text-on_surface hover:bg-surface_container_high rounded-lg transition-colors"
        >
          <Info className="w-4 h-4" />
          About
        </button>
        {isConnected && (
          <button
            onClick={onDisconnect}
            className="flex items-center gap-1.5 px-3 py-1.5 text-body-md text-on_surface_variant hover:text-on_surface hover:bg-surface_container_high rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Disconnect
          </button>
        )}
      </div>
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
    </header>
  )
}
