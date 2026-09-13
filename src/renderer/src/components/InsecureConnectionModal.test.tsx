// @vitest-environment jsdom
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InsecureConnectionModal } from './InsecureConnectionModal';

const DEFAULT_PROPS = {
  hostname: 'jellyfin.example.com',
  port: 8096,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InsecureConnectionModal — ORAIN-0706', () => {
  it('renders and is visible', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} />);
    expect(screen.getByTestId('insecure-modal')).toBeInTheDocument();
  });

  it('displays the hostname and port', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} hostname="myserver.local" port={8080} />);
    expect(screen.getByText(/myserver\.local:8080/)).toBeInTheDocument();
  });

  it('shows warning text mentioning unencrypted/insecure', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} />);
    // Must mention the connection is not encrypted
    expect(screen.getByText(/unencrypted|no está cifrada/i)).toBeInTheDocument();
  });

  it('mentions at least one shared-network example (wifi, hotel, office)', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} />);
    // Must name at least one concrete shared-network context
    expect(screen.getByText(/wifi|hotel|oficina|network|red/gi)).toBeInTheDocument();
  });

  it('has a checkbox labelled "I understand the risk"', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} />);
    expect(screen.getByRole('checkbox', { name: /understand|risk|riesgo/i })).toBeInTheDocument();
  });

  it('Continue button is disabled when checkbox is unchecked', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} />);
    const continueBtn = screen.getByRole('button', { name: /continue|continuar/i });
    expect(continueBtn).toBeDisabled();
  });

  it('Continue button is enabled after checking the checkbox', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} />);
    const checkbox = screen.getByRole('checkbox', { name: /understand|risk|riesgo/i });
    const continueBtn = screen.getByRole('button', { name: /continue|continuar/i });

    act(() => {
      fireEvent.click(checkbox);
    });

    expect(continueBtn).not.toBeDisabled();
  });

  it('calls onConfirm when Continue is clicked with checkbox checked', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} />);
    const checkbox = screen.getByRole('checkbox', { name: /understand|risk|riesgo/i });
    const continueBtn = screen.getByRole('button', { name: /continue|continuar/i });

    act(() => {
      fireEvent.click(checkbox);
    });
    act(() => {
      continueBtn.click();
    });

    expect(DEFAULT_PROPS.onConfirm).toHaveBeenCalledTimes(1);
    expect(DEFAULT_PROPS.onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel when Cancel is clicked', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} />);
    const cancelBtn = screen.getByRole('button', { name: /cancel|cancelar/i });

    act(() => {
      cancelBtn.click();
    });

    expect(DEFAULT_PROPS.onCancel).toHaveBeenCalledTimes(1);
    expect(DEFAULT_PROPS.onConfirm).not.toHaveBeenCalled();
  });

  it('Cancel button does not require checkbox to be checked', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} />);
    const cancelBtn = screen.getByRole('button', { name: /cancel|cancelar/i });
    expect(cancelBtn).not.toBeDisabled();
  });

  it('renders the backdrop overlay that dismisses on Cancel (not onConfirm)', () => {
    // Clicking the backdrop should call onCancel, not onConfirm
    render(<InsecureConnectionModal {...DEFAULT_PROPS} />);
    // The backdrop/overlay div (data-testid="insecure-modal-backdrop")
    const backdrop = screen.getByTestId('insecure-modal-backdrop');
    act(() => {
      backdrop.click();
    });
    expect(DEFAULT_PROPS.onCancel).toHaveBeenCalledTimes(1);
    expect(DEFAULT_PROPS.onConfirm).not.toHaveBeenCalled();
  });

  it('shows username/password or credentials exposure in the warning text', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} />);
    // The warning must say what is exposed — at minimum "username", "password" or "credentials"
    const text = document.body.textContent ?? '';
    const mentionsCredential = /username|password|credentials|usuario|contraseña|credenciales/i;
    expect(text).toMatch(mentionsCredential);
  });

  // ORAIN-0710: dynamic copy per credential kind
  it('shows "username and password" and plural verb for kind=password', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} credentialKind="password" />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/username and password/);
    expect(text).toMatch(/they are sent/);
  });

  it('shows "API key" and singular verb for kind=apikey', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} credentialKind="apikey" />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/API key/);
    expect(text).toMatch(/it is sent/);
  });

  it('shows "session data" and singular verb for kind=accessToken', () => {
    render(<InsecureConnectionModal {...DEFAULT_PROPS} credentialKind="accessToken" />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/session data/);
    expect(text).toMatch(/it is sent/);
  });
});
