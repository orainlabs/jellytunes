import { Loader2 } from 'lucide-react'

interface ConnectingScreenProps {
  serverUrl?: string
}

export function ConnectingScreen({ serverUrl }: ConnectingScreenProps): JSX.Element {
  const hostname = serverUrl ? (() => { try { return new URL(serverUrl).hostname } catch { return serverUrl } })() : null

  return (
    <div className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
      <div className="text-center">
        <Loader2 className="w-10 h-10 animate-spin text-jf-purple mx-auto mb-4" />
        <p>Connecting to Jellyfin{hostname ? <span className="text-zinc-400"> · {hostname}</span> : '...'}</p>
      </div>
    </div>
  )
}
