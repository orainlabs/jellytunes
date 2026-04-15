import { Loader2 } from 'lucide-react'

interface ConnectingScreenProps {
  serverUrl?: string
}

export function ConnectingScreen({ serverUrl }: ConnectingScreenProps): JSX.Element {
  const hostname = serverUrl ? (() => { try { return new URL(serverUrl).hostname } catch { return serverUrl } })() : null

  return (
    <div className="h-screen flex items-center justify-center bg-surface text-on_surface">
      <div className="text-center">
        <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto mb-4" />
        <p className="text-body-md">Connecting to Jellyfin{hostname ? <span className="text-on_surface_variant"> · {hostname}</span> : '...'}</p>
      </div>
    </div>
  )
}
