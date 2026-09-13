// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { LoginScreen } from './LoginScreen';

// Mock clipboard for SnapKeyringBanner (re-uses the same navigator.clipboard shim)
beforeAll(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

const mockApi = {
  listUsbDevices: vi.fn().mockResolvedValue([]),
  getDeviceInfo: vi.fn().mockResolvedValue({ total: 32e9, free: 16e9, used: 16e9 }),
  getFilesystem: vi.fn().mockResolvedValue('exfat'),
  getSyncedItems: vi.fn().mockResolvedValue([]),
  analyzeDiff: vi.fn().mockResolvedValue({ success: true, items: [] }),
  estimateSize: vi.fn().mockResolvedValue({ trackCount: 0, totalBytes: 0, formatBreakdown: {} }),
  startSync2: vi
    .fn()
    .mockResolvedValue({ success: true, tracksCopied: 10, tracksSkipped: 5, errors: [] }),
  removeItems: vi.fn().mockResolvedValue({ removed: 0, errors: [] }),
  cancelSync: vi.fn().mockResolvedValue({ cancelled: true }),
  onSyncProgress: vi.fn().mockReturnValue(() => {}),
  getDeviceSyncInfo: vi.fn().mockResolvedValue(null),
  selectFolder: vi.fn().mockResolvedValue('/mnt/usb'),
  saveSession: vi.fn().mockResolvedValue({ success: true }),
  loadSession: vi.fn().mockResolvedValue(null),
  clearSession: vi.fn().mockResolvedValue(undefined),
};
beforeAll(() => {
  Object.defineProperty(window, 'api', { value: mockApi, writable: true });
});
afterEach(() => {
  vi.resetAllMocks();
});

describe('LoginScreen', () => {
  // ORAIN-0564 SO-1: these were written when API key mode was the only mode.
  // They now exercise the API-key branch explicitly via `initialMode="apikey"`.
  // The default mode is "password" — covered by the new "password mode" describe block.

  // 1. renders with URL and API key inputs visible
  it('renders with URL and API key inputs visible', () => {
    const props = {
      urlInput: '',
      apiKeyInput: '',
      error: null as string | null,
      onUrlChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onSubmit: vi.fn(),
      initialMode: 'apikey' as const,
    };
    render(<LoginScreen {...props} />);
    expect(screen.getByTestId('server-url-input')).toBeInTheDocument();
    expect(screen.getByTestId('api-key-input')).toBeInTheDocument();
  });

  // 2. Connect button visible and inputs have required attribute
  it('Connect button is visible and inputs have required attribute', () => {
    const props = {
      urlInput: '',
      apiKeyInput: '',
      error: null as string | null,
      onUrlChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onSubmit: vi.fn(),
      initialMode: 'apikey' as const,
    };
    render(<LoginScreen {...props} />);
    const connectButton = screen.getByTestId('connect-button');
    const urlInput = screen.getByTestId('server-url-input');
    const apiKeyInput = screen.getByTestId('api-key-input');
    expect(connectButton).toBeInTheDocument();
    expect(urlInput).toHaveAttribute('required');
    expect(apiKeyInput).toHaveAttribute('required');
  });

  // 3. submit with values: onSubmit called with url and apiKey
  it('calls onSubmit with url and apiKey when form is submitted', async () => {
    const props = {
      urlInput: '',
      apiKeyInput: '',
      error: null as string | null,
      onUrlChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onSubmit: vi.fn(),
      initialMode: 'apikey' as const,
    };
    render(<LoginScreen {...props} />);
    const form = document.querySelector('form') as HTMLFormElement;

    // Set actual DOM input values (form's onSubmit reads from DOM elements, not React state)
    const urlInput = form.elements.namedItem('url') as HTMLInputElement;
    const apiKeyInput = form.elements.namedItem('apiKey') as HTMLInputElement;

    // Update DOM values and fire input events so React's onChange fires
    await act(async () => {
      urlInput.value = 'https://jellyfin.example.com';
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
      apiKeyInput.value = 'test-api-key-123';
      apiKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Submit the form
    await act(async () => {
      form.requestSubmit();
    });

    expect(props.onSubmit).toHaveBeenCalled();
    const call = props.onSubmit.mock.calls[0];
    expect(call[0]).toBe('https://jellyfin.example.com');
    expect(call[1]).toBe('test-api-key-123');
  });

  // 4. error visible when error prop is a string (renders in password mode too)
  // ORAIN-0679: explicit initialMode needed because LoginScreen now defaults to password mode
  it('shows error message when error prop is a string', () => {
    const props = {
      urlInput: '',
      apiKeyInput: '',
      error: 'Invalid credentials' as string | null,
      onUrlChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onSubmit: vi.fn(),
      initialMode: 'apikey' as const,
    };
    render(<LoginScreen {...props} />);
    expect(screen.getByTestId('error-message')).toHaveTextContent('Invalid credentials');
  });

  // 5. API key helper text visible (API-key mode only)
  it('shows API key helper text', () => {
    const props = {
      urlInput: '',
      apiKeyInput: '',
      error: null as string | null,
      onUrlChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onSubmit: vi.fn(),
      initialMode: 'apikey' as const,
    };
    render(<LoginScreen {...props} />);
    expect(screen.getByText(/Get your API Key in Jellyfin/)).toBeInTheDocument();
  });

  // 6. English strings displayed (API-key mode)
  it('displays English strings', () => {
    const props = {
      urlInput: '',
      apiKeyInput: '',
      error: null as string | null,
      onUrlChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onSubmit: vi.fn(),
      initialMode: 'apikey' as const,
    };
    render(<LoginScreen {...props} />);
    // Header should be in English
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Connect to Jellyfin');
    // Label should be in English
    expect(screen.getByText('Server URL')).toBeInTheDocument();
    // Placeholder should be in English
    expect(screen.getByPlaceholderText(/jellyfin.example.com/i)).toBeInTheDocument();
    // API Key label in English
    expect(screen.getByText('API Key')).toBeInTheDocument();
    // Button should be in English
    expect(screen.getAllByRole('button')[0]).toHaveTextContent('Connect');
    // Helper text should be in English
    expect(screen.getByText(/Get your API Key in Jellyfin/)).toBeInTheDocument();
  });

  // 7. ORAIN-0578: the snap permission banner is owned by `App`, not by this
  // screen. Keeping it here is what made it unreachable — it could only be
  // raised once the connection succeeded, which unmounts this screen.
  // ORAIN-0679: explicit initialMode needed because LoginScreen now defaults to password mode
  it('does not render any snap banner itself', () => {
    const props = {
      urlInput: '',
      apiKeyInput: '',
      error: null as string | null,
      onUrlChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onSubmit: vi.fn(),
      initialMode: 'apikey' as const,
    };
    render(<LoginScreen {...props} />);
    expect(screen.queryByTestId('snap-permissions-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('snap-keyring-banner')).not.toBeInTheDocument();
  });
});

// ORAIN-0564 SO-1 — username+password mode in LoginScreen.
// API-key mode is the default (preserves E1 + every existing user); password
// mode is reachable via the toggle or by passing `initialMode="password"`.
describe('LoginScreen — password mode (ORAIN-0564 SO-1)', () => {
  const baseProps = () => ({
    urlInput: '',
    apiKeyInput: '',
    usernameInput: '',
    passwordInput: '',
    error: null as string | null,
    onUrlChange: vi.fn(),
    onApiKeyChange: vi.fn(),
    onUsernameChange: vi.fn(),
    onPasswordChange: vi.fn(),
    onSubmit: vi.fn(),
    onPasswordSubmit: vi.fn(),
  });

  it('renders password mode when initialMode="password" (username + password inputs visible without clicking a toggle)', () => {
    render(<LoginScreen {...baseProps()} initialMode="password" />);
    expect(screen.getByTestId('username-input')).toBeInTheDocument();
    expect(screen.getByTestId('password-input')).toBeInTheDocument();
  });

  it('renders a visible toggle to switch to API key mode, labelled as advanced', () => {
    render(<LoginScreen {...baseProps()} initialMode="password" />);
    const toggle = screen.getByTestId('mode-toggle-apikey');
    expect(toggle).toBeInTheDocument();
    expect(toggle.textContent ?? '').toMatch(/advanced|administrator|admin/i);
  });

  it('submits with (url, username, password) when password form is submitted', async () => {
    const props = baseProps();
    render(<LoginScreen {...props} initialMode="password" />);

    const urlInput = screen.getByTestId('server-url-input') as HTMLInputElement;
    const usernameInput = screen.getByTestId('username-input') as HTMLInputElement;
    const passwordInput = screen.getByTestId('password-input') as HTMLInputElement;

    await act(async () => {
      urlInput.value = 'https://jellyfin.example.com';
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
      usernameInput.value = 'alice';
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
      passwordInput.value = 's3cret';
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.requestSubmit();
    });

    expect(props.onPasswordSubmit).toHaveBeenCalledTimes(1);
    const call = props.onPasswordSubmit.mock.calls[0];
    expect(call[0]).toBe('https://jellyfin.example.com');
    expect(call[1]).toBe('alice');
    expect(call[2]).toBe('s3cret');
  });

  it('still exposes the API-key inputs when the toggle is activated (password mode reachable via toggle)', () => {
    render(<LoginScreen {...baseProps()} initialMode="password" />);
    // API-key mode needs an explicit toggle click from password mode.
    const toggle = screen.getByTestId('mode-toggle-apikey');
    act(() => {
      toggle.click();
    });
    expect(screen.getByTestId('api-key-input')).toBeInTheDocument();
    expect(screen.queryByTestId('username-input')).not.toBeInTheDocument();
  });
});

// ORAIN-0679: new tests for the password-default and UI restyle changes
describe('LoginScreen — ORAIN-0679 password default + UI restyle', () => {
  const baseProps = () => ({
    urlInput: '',
    apiKeyInput: '',
    usernameInput: '',
    passwordInput: '',
    error: null as string | null,
    onUrlChange: vi.fn(),
    onApiKeyChange: vi.fn(),
    onUsernameChange: vi.fn(),
    onPasswordChange: vi.fn(),
    onSubmit: vi.fn(),
    onPasswordSubmit: vi.fn(),
    initialMode: 'password' as const,
  });

  it('defaults to password mode when initialMode is not specified', () => {
    // Renders LoginScreen without initialMode prop — relies on the component default
    const { initialMode: _, ...propsWithoutMode } = baseProps();
    render(<LoginScreen {...propsWithoutMode} />);
    expect(screen.getByTestId('username-input')).toBeInTheDocument();
    expect(screen.queryByTestId('api-key-input')).not.toBeInTheDocument();
  });

  it('mode-toggle-apikey renders as a styled secondary button with focus-visible ring', () => {
    render(<LoginScreen {...baseProps()} initialMode="password" />);
    const toggle = screen.getByTestId('mode-toggle-apikey');
    expect(toggle).toHaveClass('bg-primary_container/10');
    expect(toggle).toHaveClass('border', 'border-primary_container/40');
    expect(toggle).toHaveClass('text-primary');
    // H1 — AC5: keyboard focus must be visually indicated
    expect(toggle).toHaveClass('focus-visible:outline-none');
    expect(toggle).toHaveClass(
      'focus-visible:ring-2',
      'focus-visible:ring-primary',
      'focus-visible:ring-offset-2',
    );
  });

  it('mode-toggle-password renders as a styled secondary button with focus-visible ring', () => {
    render(<LoginScreen {...baseProps()} initialMode="apikey" />);
    const toggle = screen.getByTestId('mode-toggle-password');
    expect(toggle).toHaveClass('bg-primary_container/10');
    expect(toggle).toHaveClass('border', 'border-primary_container/40');
    expect(toggle).toHaveClass('text-primary');
    // H1 — AC5: keyboard focus must be visually indicated
    expect(toggle).toHaveClass('focus-visible:outline-none');
    expect(toggle).toHaveClass(
      'focus-visible:ring-2',
      'focus-visible:ring-primary',
      'focus-visible:ring-offset-2',
    );
  });

  it('footer in password mode says "Sign in with your Jellyfin username and password." with no HTTPS text', () => {
    render(<LoginScreen {...baseProps()} initialMode="password" />);
    expect(
      screen.getByText('Sign in with your Jellyfin username and password.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/HTTPS is required/i)).not.toBeInTheDocument();
  });

  it('footer in apikey mode still shows the API key hint', () => {
    render(<LoginScreen {...baseProps()} initialMode="apikey" />);
    expect(screen.getByText(/Get your API Key in Jellyfin/)).toBeInTheDocument();
  });

  // H2 — AC6: useEffect autofocus untested — regression guard
  // ORAIN-0682: focus unified on server-url-input in all modes
  it('autofocuses server-url-input when mounted in password mode', () => {
    render(<LoginScreen {...baseProps()} initialMode="password" />);
    expect(screen.getByTestId('server-url-input')).toHaveFocus();
  });

  it('autofocuses server-url-input when mounted in apikey mode', () => {
    render(<LoginScreen {...baseProps()} initialMode="apikey" />);
    expect(screen.getByTestId('server-url-input')).toHaveFocus();
  });

  it('autofocuses server-url-input when toggling from password to apikey mode', () => {
    render(<LoginScreen {...baseProps()} initialMode="password" />);
    const toggle = screen.getByTestId('mode-toggle-apikey');
    act(() => {
      toggle.click();
    });
    expect(screen.getByTestId('server-url-input')).toHaveFocus();
  });

  // ORAIN-0682: native validation bubble suppression — JS validation instead
  it('shows fieldError and does not call onPasswordSubmit when a required field is empty in password mode', async () => {
    const props = baseProps();
    render(<LoginScreen {...props} initialMode="password" />);

    // Fill only URL and username, leave password empty
    const urlInput = screen.getByTestId('server-url-input') as HTMLInputElement;
    const usernameInput = screen.getByTestId('username-input') as HTMLInputElement;

    await act(async () => {
      urlInput.value = 'https://jellyfin.example.com';
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
      usernameInput.value = 'alice';
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.requestSubmit();
    });

    expect(props.onPasswordSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('error-message')).toBeInTheDocument();
  });

  it('shows fieldError and does not call onSubmit when a required field is empty in apikey mode', async () => {
    const props = baseProps();
    render(<LoginScreen {...props} initialMode="apikey" />);

    const urlInput = screen.getByTestId('server-url-input') as HTMLInputElement;

    await act(async () => {
      urlInput.value = 'https://jellyfin.example.com';
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.requestSubmit();
    });

    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('error-message')).toBeInTheDocument();
  });

  it('calls onPasswordSubmit when all fields are filled in password mode', async () => {
    const props = baseProps();
    render(<LoginScreen {...props} initialMode="password" />);

    const urlInput = screen.getByTestId('server-url-input') as HTMLInputElement;
    const usernameInput = screen.getByTestId('username-input') as HTMLInputElement;
    const passwordInput = screen.getByTestId('password-input') as HTMLInputElement;

    await act(async () => {
      urlInput.value = 'https://jellyfin.example.com';
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
      usernameInput.value = 'alice';
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
      passwordInput.value = 's3cret';
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.requestSubmit();
    });

    expect(props.onPasswordSubmit).toHaveBeenCalledTimes(1);
  });

  it('calls onSubmit when all fields are filled in apikey mode', async () => {
    const props = baseProps();
    render(<LoginScreen {...props} initialMode="apikey" />);

    const urlInput = screen.getByTestId('server-url-input') as HTMLInputElement;
    const apiKeyInput = screen.getByTestId('api-key-input') as HTMLInputElement;

    await act(async () => {
      urlInput.value = 'https://jellyfin.example.com';
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
      apiKeyInput.value = 'test-api-key';
      apiKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.requestSubmit();
    });

    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
});

// ORAIN-0710: onModeChange callback — tracks the live tab so that when LoginScreen
// re-mounts after the HTTP warning cycle it restores the correct tab, not the
// last-saved authKind from disk.
describe('LoginScreen — ORAIN-0710 onModeChange', () => {
  const baseProps = () => ({
    urlInput: '',
    apiKeyInput: '',
    usernameInput: '',
    passwordInput: '',
    error: null as string | null,
    onUrlChange: vi.fn(),
    onApiKeyChange: vi.fn(),
    onUsernameChange: vi.fn(),
    onPasswordChange: vi.fn(),
    onSubmit: vi.fn(),
    onPasswordSubmit: vi.fn(),
    onModeChange: vi.fn(),
    initialMode: 'password' as const,
  });

  it('calls onModeChange with "apikey" when toggling from password to apikey', () => {
    const props = baseProps();
    render(<LoginScreen {...props} initialMode="password" />);
    const toggle = screen.getByTestId('mode-toggle-apikey');
    act(() => {
      toggle.click();
    });
    expect(props.onModeChange).toHaveBeenCalledWith('apikey');
  });

  it('calls onModeChange with "password" when toggling from apikey to password', () => {
    const props = baseProps();
    render(<LoginScreen {...props} initialMode="apikey" />);
    const toggle = screen.getByTestId('mode-toggle-password');
    act(() => {
      toggle.click();
    });
    expect(props.onModeChange).toHaveBeenCalledWith('password');
  });
});
