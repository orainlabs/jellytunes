// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { LoginScreen } from './LoginScreen';

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
  // 1. renders with URL and API key inputs visible
  it('renders with URL and API key inputs visible', () => {
    const props = {
      urlInput: '',
      apiKeyInput: '',
      error: null as string | null,
      onUrlChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onSubmit: vi.fn(),
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

  // 4. error visible when error prop is a string
  it('shows error message when error prop is a string', () => {
    const props = {
      urlInput: '',
      apiKeyInput: '',
      error: 'Invalid credentials' as string | null,
      onUrlChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onSubmit: vi.fn(),
    };
    render(<LoginScreen {...props} />);
    expect(screen.getByTestId('error-message')).toHaveTextContent('Invalid credentials');
  });

  // 5. API key helper text visible in Spanish
  it('shows API key helper text in Spanish', () => {
    const props = {
      urlInput: '',
      apiKeyInput: '',
      error: null as string | null,
      onUrlChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onSubmit: vi.fn(),
    };
    render(<LoginScreen {...props} />);
    expect(screen.getByText(/Consigue tu Clave API en Jellyfin/)).toBeInTheDocument();
  });

  // 6. i18n: Spanish strings displayed when locale is es
  it('displays Spanish strings when locale is es', () => {
    const props = {
      urlInput: '',
      apiKeyInput: '',
      error: null as string | null,
      onUrlChange: vi.fn(),
      onApiKeyChange: vi.fn(),
      onSubmit: vi.fn(),
    };
    render(<LoginScreen {...props} />);
    // Header should be in Spanish
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Conectar a Jellyfin');
    // Label should be in Spanish
    expect(screen.getByText('URL del servidor')).toBeInTheDocument();
    // Placeholder should be in Spanish
    expect(screen.getByPlaceholderText(/tuDominio/i)).toBeInTheDocument();
    // API Key label in Spanish
    expect(screen.getByText('Clave API')).toBeInTheDocument();
    // Button should be in Spanish
    expect(screen.getByRole('button')).toHaveTextContent('Conectar');
    // Helper text should be in Spanish
    expect(screen.getByText(/Consigue tu Clave API en Jellyfin/)).toBeInTheDocument();
  });
});
