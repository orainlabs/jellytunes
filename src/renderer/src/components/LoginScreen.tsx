import { X } from 'lucide-react'
import { GradientMusicIcon } from './GradientMusicIcon'

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
    <div data-testid="auth-screen" className="h-screen flex items-center justify-center bg-surface text-on_surface">
      <div className="w-full max-w-md p-8">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <GradientMusicIcon className="w-10 h-10" />
          <h1 className="text-headline-lg">JellyTunes</h1>
        </div>

        <div className="bg-surface_container_low rounded-xl p-6 border border-outline_variant">
          <h2 className="text-headline-md mb-4">Connect to Jellyfin</h2>

          <form onSubmit={(e) => {
            e.preventDefault()
            const url = (e.currentTarget.elements.namedItem('url') as HTMLInputElement).value
            const apiKey = (e.currentTarget.elements.namedItem('apiKey') as HTMLInputElement).value
            onSubmit(url, apiKey)
          }}>
            <div className="space-y-4">
              <div>
                <label className="block text-body-md text-on_surface_variant mb-1">Server URL</label>
                <input
                  data-testid="server-url-input"
                  name="url"
                  type="url"
                  value={urlInput}
                  onChange={(e) => onUrlChange(e.target.value)}
                  placeholder="https://jellyfin.tudominio.com"
                  required
                  className="w-full bg-surface_container_low border border-outline_variant rounded-lg px-4 py-2 text-body-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                />
              </div>
              <div>
                <label className="block text-body-md text-on_surface_variant mb-1">API Key</label>
                <input
                  data-testid="api-key-input"
                  name="apiKey"
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => onApiKeyChange(e.target.value)}
                  placeholder="Your Jellyfin API key"
                  required
                  className="w-full bg-surface_container_low border border-outline_variant rounded-lg px-4 py-2 text-body-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                />
              </div>

              {error && (
                <div data-testid="error-message" className="flex items-center gap-2 text-error text-body-md">
                  <X className="w-4 h-4" />
                  {error}
                </div>
              )}

              <button
                data-testid="connect-button"
                type="submit"
                className="w-full bg-gradient-primary hover:bg-secondary_container py-2 rounded-lg font-medium transition-colors"
              >
                Connect
              </button>
            </div>
          </form>
        </div>

        <p className="text-caption text-on_surface_variant text-center mt-4">
          Get your API Key in Jellyfin → Dashboard → User → API Keys
        </p>
      </div>
    </div>
  )
}
