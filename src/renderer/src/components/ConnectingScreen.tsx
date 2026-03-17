import { Loader2 } from 'lucide-react'

export function ConnectingScreen(): JSX.Element {
  return (
    <div className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
      <div className="text-center">
        <Loader2 className="w-10 h-10 animate-spin text-blue-500 mx-auto mb-4" />
        <p>Connecting to Jellyfin...</p>
      </div>
    </div>
  )
}
