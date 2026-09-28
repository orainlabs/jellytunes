import { useEffect, useState } from 'react';

interface SyncError {
  trackName: string;
  message: string;
  phase?: string;
}

interface SyncSuccessModalProps {
  tracksCopied: number;
  tracksSkipped: number;
  tracksRetagged: number;
  lyricsAdded?: number;
  removed: number;
  errors: SyncError[];
  lyricsMode?: string;
  onClose: () => void;
}

const CTAS = [
  {
    label: 'Star us on GitHub',
    url: 'https://github.com/orainlabs/jellytunes',
  },
  {
    label: 'Report issues or suggest features',
    url: 'https://github.com/orainlabs/jellytunes/issues',
  },
  {
    label: 'Support development on Ko-fi ☕',
    url: 'https://ko-fi.com/orainlabs',
  },
];

export function SyncSuccessModal({
  tracksCopied,
  tracksSkipped,
  tracksRetagged,
  lyricsAdded,
  removed,
  errors,
  lyricsMode,
  onClose,
}: SyncSuccessModalProps): JSX.Element {
  const [cta] = useState(() => CTAS[Math.floor(Date.now() / (24 * 60 * 60 * 1000)) % CTAS.length]);
  const success = errors.length === 0 || tracksCopied > 0;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleOpenLogFolder = async () => {
    try {
      await window.api.openLogFolder();
    } catch {
      // best-effort: support the user wanted the button, log folder may not exist
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface_container_low border border-outline_variant rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          {success ? (
            <span className="text-2xl">✓</span>
          ) : (
            // ORAIN-0752 AC1: ⚠ instead of ✗ so the icon next to the title
            // does not look like a window-close control. The data-testid
            // pins the assertion against future glyph changes.
            <span data-testid="sync-failed-icon" className="text-2xl">
              ⚠
            </span>
          )}
          <h2
            className={
              success
                ? 'text-headline-md'
                : // ORAIN-0752 AC1: red title so the failure state is
                  // unambiguous at a glance (contrast ≈ 4.8:1 on
                  // surface_container_low #1a1a27).
                  'text-headline-md text-error'
            }
          >
            {success ? 'Sync complete' : 'Sync failed'}
          </h2>
        </div>

        {success ? (
          <div className="text-body-md text-on_surface_variant space-y-1 mb-5">
            {tracksCopied > 0 && (
              <p>
                Copied: <span className="text-on_surface">{tracksCopied} tracks</span>
              </p>
            )}
            {tracksRetagged > 0 && (
              <p>
                Re-tagged (metadata updated):{' '}
                <span className="text-on_surface">{tracksRetagged} tracks</span>
              </p>
            )}
            {lyricsMode !== 'off' && (
              <>
                {lyricsAdded !== undefined && lyricsAdded > 0 ? (
                  <p>
                    Lyrics added: <span className="text-on_surface">{lyricsAdded} tracks</span>
                  </p>
                ) : lyricsAdded === 0 ? (
                  <p>
                    Lyrics added: <span className="text-on_surface">No lyrics synced</span>
                  </p>
                ) : null}
              </>
            )}
            {tracksSkipped > 0 && (
              <p>
                Skipped (up-to-date): <span className="text-on_surface">{tracksSkipped}</span>
              </p>
            )}
            {removed > 0 && (
              <p>
                Removed: <span className="text-on_surface">{removed} items</span>
              </p>
            )}
            {errors.length > 0 && (
              <p>
                Errors: <span className="text-error">{errors.length}</span>
              </p>
            )}
          </div>
        ) : (
          // ORAIN-0734: full scrollable list with per-track header + wrapped
          // message. The container is constrained to max-h-80 + overflow-y-auto
          // so the modal never grows past the viewport's 90% cap.
          <div
            data-testid="sync-errors-list"
            className="text-body-md text-error max-h-80 overflow-y-auto mb-5 pr-1"
          >
            {errors.map((err, i) => (
              <div
                key={`${err.trackName}-${i}`}
                className="border-b border-outline_variant/40 last:border-b-0 py-2"
              >
                {err.trackName && (
                  // ORAIN-0752 AC2: failed-state track names use
                  // text-error + font-medium for contrast against
                  // surface_container_low (#cf6679 on #1a1a27 ≈ 4.8:1).
                  // The message below stays on_surface_variant by design
                  // (user decision: avoid "too much red" across the list).
                  <div
                    data-testid="sync-error-header"
                    className="text-error font-medium break-words"
                  >
                    {err.trackName}
                  </div>
                )}
                <div
                  data-testid="sync-error-message"
                  className="text-on_surface_variant text-xs break-words [overflow-wrap:anywhere]"
                >
                  {err.message}
                </div>
              </div>
            ))}
          </div>
        )}

        {success && (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.open(cta.url);
            }}
            className="block w-full text-center px-4 py-2 text-body-md text-on_surface_variant hover:text-on_surface hover:bg-surface_container_high rounded-lg transition-colors mb-2"
          >
            {cta.label}
          </a>
        )}

        {errors.length > 0 && (
          <button
            onClick={handleOpenLogFolder}
            className="w-full px-4 py-2 text-body-md text-on_surface_variant hover:text-on_surface hover:bg-surface_container_high rounded-lg transition-colors mb-2"
          >
            Open log folder
          </button>
        )}

        <button
          onClick={onClose}
          className="w-full px-4 py-2 text-body-md bg-surface_container_high hover:bg-surface_container_highest rounded-lg transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}
