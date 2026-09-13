import { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { GradientMusicIcon } from './GradientMusicIcon';

export type LoginMode = 'password' | 'apikey';

interface LoginScreenProps {
  urlInput: string;
  apiKeyInput: string;
  usernameInput?: string;
  passwordInput?: string;
  error: string | null;
  onUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onUsernameChange?: (value: string) => void;
  onPasswordChange?: (value: string) => void;
  onSubmit: (url: string, apiKey: string) => void;
  onPasswordSubmit?: (url: string, username: string, password: string) => void;
  /** @default 'password' */
  initialMode?: LoginMode;
  /** ORAIN-0710: called whenever the user switches tabs so App can track the live tab. */
  onModeChange?: (mode: LoginMode) => void;
}

/**
 * ORAIN-0679: password mode is the default — new users typically have Jellyfin
 * credentials but not an API key. API-key mode is reachable in one click via
 * the toggle. E1 (tests/e2e/specs/e1-connection.spec.ts) drives apikey mode
 * explicitly via `initialMode="apikey"`; all other existing tests that need
 * the apikey branch do the same (see LoginScreen.test.tsx).
 */
export function LoginScreen({
  urlInput,
  apiKeyInput,
  usernameInput = '',
  passwordInput = '',
  error,
  onUrlChange,
  onApiKeyChange,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
  onPasswordSubmit,
  initialMode = 'password',
  onModeChange,
}: LoginScreenProps): JSX.Element {
  const [mode, setMode] = useState<LoginMode>(initialMode);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const serverUrlRef = useRef<HTMLInputElement>(null);

  // ORAIN-0682: always focus server-url-input on mount and on mode change
  useEffect(() => {
    serverUrlRef.current?.focus();
  }, [mode]);

  return (
    <div
      data-testid="auth-screen"
      className="h-full flex items-center justify-center bg-surface text-on_surface"
    >
      <div className="w-full max-w-md p-8">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <GradientMusicIcon className="w-10 h-10" />
          <h1 className="text-headline-lg">JellyTunes</h1>
        </div>

        <div className="bg-surface_container_low rounded-xl p-6 border border-outline_variant">
          <h2 className="text-headline-md mb-4">Connect to Jellyfin</h2>

          {mode === 'password' ? (
            <form
              data-testid="password-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (!onPasswordSubmit) return;
                const form = e.currentTarget;
                const url = (form.elements.namedItem('url') as HTMLInputElement).value;
                const username = (form.elements.namedItem('username') as HTMLInputElement).value;
                const password = (form.elements.namedItem('password') as HTMLInputElement).value;
                if (!url.trim() || !username.trim() || !password.trim()) {
                  setFieldError('Please fill in all required fields.');
                  return;
                }
                setFieldError(null);
                onPasswordSubmit(url, username, password);
              }}
            >
              <div className="space-y-4">
                <div>
                  <label className="block text-body-md text-on_surface_variant mb-1">
                    Server URL
                  </label>
                  <input
                    ref={serverUrlRef}
                    data-testid="server-url-input"
                    name="url"
                    type="url"
                    value={urlInput}
                    onChange={(e) => {
                      onUrlChange(e.target.value);
                      setFieldError(null);
                    }}
                    placeholder="https://jellyfin.example.com"
                    required
                    className="w-full bg-surface_container_low border border-outline_variant rounded-lg px-4 py-2 text-body-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  />
                </div>
                <div>
                  <label className="block text-body-md text-on_surface_variant mb-1">
                    Username
                  </label>
                  <input
                    data-testid="username-input"
                    name="username"
                    type="text"
                    value={usernameInput}
                    onChange={(e) => {
                      onUsernameChange?.(e.target.value);
                      setFieldError(null);
                    }}
                    placeholder="Your Jellyfin username"
                    required
                    autoComplete="username"
                    className="w-full bg-surface_container_low border border-outline_variant rounded-lg px-4 py-2 text-body-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  />
                </div>
                <div>
                  <label className="block text-body-md text-on_surface_variant mb-1">
                    Password
                  </label>
                  <input
                    data-testid="password-input"
                    name="password"
                    type="password"
                    value={passwordInput}
                    onChange={(e) => {
                      onPasswordChange?.(e.target.value);
                      setFieldError(null);
                    }}
                    placeholder="Your Jellyfin password"
                    required
                    autoComplete="current-password"
                    className="w-full bg-surface_container_low border border-outline_variant rounded-lg px-4 py-2 text-body-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  />
                </div>

                {(error ?? fieldError) && (
                  <div
                    data-testid="error-message"
                    className="flex items-center gap-2 text-error text-body-md"
                  >
                    <X className="w-4 h-4" />
                    {fieldError ?? error}
                  </div>
                )}

                <button
                  data-testid="connect-button"
                  type="submit"
                  className="w-full bg-gradient-primary hover:bg-secondary_container py-2 rounded-lg font-medium transition-colors"
                >
                  Sign in
                </button>

                <button
                  type="button"
                  data-testid="mode-toggle-apikey"
                  onClick={() => {
                    setMode('apikey');
                    onModeChange?.('apikey');
                  }}
                  className="w-full text-body-sm bg-primary_container/10 border border-primary_container/40 text-primary hover:bg-primary_container/20 rounded-lg px-3 py-2 transition-colors font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  Use an API key instead (advanced)
                </button>
              </div>
            </form>
          ) : (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                const url = (e.currentTarget.elements.namedItem('url') as HTMLInputElement).value;
                const apiKey = (e.currentTarget.elements.namedItem('apiKey') as HTMLInputElement)
                  .value;
                if (!url.trim() || !apiKey.trim()) {
                  setFieldError('Please fill in all required fields.');
                  return;
                }
                setFieldError(null);
                onSubmit(url, apiKey);
              }}
            >
              <div className="space-y-4">
                <div>
                  <label className="block text-body-md text-on_surface_variant mb-1">
                    Server URL
                  </label>
                  <input
                    ref={serverUrlRef}
                    data-testid="server-url-input"
                    name="url"
                    type="url"
                    value={urlInput}
                    onChange={(e) => {
                      onUrlChange(e.target.value);
                      setFieldError(null);
                    }}
                    placeholder="https://jellyfin.example.com"
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
                    onChange={(e) => {
                      onApiKeyChange(e.target.value);
                      setFieldError(null);
                    }}
                    placeholder="Your Jellyfin API key"
                    required
                    className="w-full bg-surface_container_low border border-outline_variant rounded-lg px-4 py-2 text-body-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  />
                </div>

                {(error ?? fieldError) && (
                  <div
                    data-testid="error-message"
                    className="flex items-center gap-2 text-error text-body-md"
                  >
                    <X className="w-4 h-4" />
                    {fieldError ?? error}
                  </div>
                )}

                <button
                  data-testid="connect-button"
                  type="submit"
                  className="w-full bg-gradient-primary hover:bg-secondary_container py-2 rounded-lg font-medium transition-colors"
                >
                  Connect
                </button>

                <button
                  type="button"
                  data-testid="mode-toggle-password"
                  onClick={() => {
                    setMode('password');
                    onModeChange?.('password');
                  }}
                  className="w-full text-body-sm bg-primary_container/10 border border-primary_container/40 text-primary hover:bg-primary_container/20 rounded-lg px-3 py-2 transition-colors font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  Back to username + password
                </button>
              </div>
            </form>
          )}
        </div>

        <p className="text-caption text-on_surface_variant text-center mt-4">
          {mode === 'password'
            ? 'Sign in with your Jellyfin username and password.'
            : 'Get your API Key in Jellyfin → Dashboard → Users → API Keys'}
        </p>
      </div>
    </div>
  );
}
