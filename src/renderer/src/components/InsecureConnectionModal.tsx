import { useState, useEffect } from 'react';

// ORAIN-0710 H2-2: single canonical declaration of InsecureCredentialKind in
// useJellyfinConnection.ts; imported here so the modal can accept it as a prop type.
import type { InsecureCredentialKind } from '../hooks/useJellyfinConnection';

interface InsecureConnectionModalProps {
  hostname: string;
  port: number;
  /** @default 'password' */
  credentialKind?: InsecureCredentialKind;
  onConfirm: () => void;
  onCancel: () => void;
}

export function InsecureConnectionModal({
  hostname,
  port,
  credentialKind = 'password',
  onConfirm,
  onCancel,
}: InsecureConnectionModalProps): JSX.Element {
  const [checked, setChecked] = useState(false);

  // ORAIN-0710: dynamic copy driven by credentialKind
  const [credentialLabel, verbPhrase] =
    credentialKind === 'password'
      ? ['username and password', 'they are sent']
      : credentialKind === 'apikey'
        ? ['API key', 'it is sent']
        : ['session data', 'it is sent'];

  // Reset checked state when the modal re-mounts (e.g. after closing and reopening)
  useEffect(() => {
    setChecked(false);
  }, []);

  // Dismiss with Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div
      data-testid="insecure-modal-backdrop"
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        data-testid="insecure-modal"
        className="bg-surface_container_low border border-outline_variant rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="insecure-modal-title"
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <span className="text-2xl text-warning">⚠️</span>
          <h2 id="insecure-modal-title" className="text-headline-md">
            Insecure connection
          </h2>
        </div>

        {/* Body */}
        <div className="text-body-md text-on_surface_variant space-y-3 mb-5">
          <p>
            You are about to connect to{' '}
            <strong className="text-on_surface">
              {hostname}:{port}
            </strong>{' '}
            over an unencrypted connection.
          </p>
          <p>
            This connection is not encrypted. Anyone on the same network, such as your home wifi,
            router, a shared hotel or office wifi, could see your {credentialLabel} while{' '}
            {verbPhrase}.
          </p>
        </div>

        {/* Acknowledgment */}
        <label className="flex items-start gap-3 mb-5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-1 accent-primary"
          />
          <span className="text-body-sm text-on_surface_variant leading-relaxed">
            I understand the risk and want to continue.
          </span>
        </label>

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <button
            onClick={onConfirm}
            disabled={!checked}
            className="w-full px-4 py-2 text-body-md bg-primary_container hover:bg-primary_container/80 disabled:bg-surface_container_highest disabled:text-on_surface_variant rounded-lg transition-colors font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            Continue
          </button>
          <button
            onClick={onCancel}
            className="w-full px-4 py-2 text-body-md bg-surface_container_high hover:bg-surface_container_highest rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
