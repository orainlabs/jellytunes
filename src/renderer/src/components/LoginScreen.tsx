import { Music, X } from 'lucide-react'

interface LoginScreenProps {
  urlInput: string
  apiKeyInput: string
  error: string | null
  onUrlChange: (value: string) => void
  onApiKeyChange: (value: string) => void
  onSubmit: (url: string, apiKey: string) => void
}

export function LoginScreen({ urlInput, apiKeyInput, error, onUrlChange, onApiKeyChange, onSubmit }: LoginScreenProps): JSX.Element {
  return (
    <div data-testid="auth-screen" className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
      <div className="w-full max-w-md p-8">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <Music className="w-10 h-10 text-jf-purple" />
          <h1 className="text-2xl font-bold">Jellysync</h1>
        </div>

        <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800">
          <h2 className="text-lg font-semibold mb-4">Connect to Jellyfin</h2>

          <form onSubmit={(e) => {
            e.preventDefault()
            const url = (e.currentTarget.elements.namedItem('url') as HTMLInputElement).value
            const apiKey = (e.currentTarget.elements.namedItem('apiKey') as HTMLInputElement).value
            onSubmit(url, apiKey)
          }}>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Server URL</label>
                <input
                  data-testid="server-url-input"
                  name="url"
                  type="url"
                  value={urlInput}
                  onChange={(e) => onUrlChange(e.target.value)}
                  placeholder="https://jellyfin.tudominio.com"
                  required
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-jf-purple"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">API Key</label>
                <input
                  data-testid="api-key-input"
                  name="apiKey"
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => onApiKeyChange(e.target.value)}
                  placeholder="Your Jellyfin API key"
                  required
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-jf-purple"
                />
              </div>

              {error && (
                <div data-testid="error-message" className="flex items-center gap-2 text-red-400 text-sm">
                  <X className="w-4 h-4" />
                  {error}
                </div>
              )}

              <button
                data-testid="connect-button"
                type="submit"
                className="w-full bg-jf-purple hover:bg-jf-purple-dark py-2 rounded-lg font-medium transition-colors"
              >
                Connect
              </button>
            </div>
          </form>
        </div>

        <p className="text-xs text-zinc-500 text-center mt-4">
          Get your API Key in Jellyfin → Dashboard → User → API Keys
        </p>
      </div>
    </div>
  )
}
