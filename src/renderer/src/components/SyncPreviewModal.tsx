import { Check } from 'lucide-react';
import type { PreviewData, Bitrate } from '../appTypes';
import { formatBytes, formatDuration } from '../utils/format';

interface SyncPreviewModalProps {
  data: PreviewData;
  convertToMp3: boolean;
  bitrate: Bitrate;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Three-column layout: tracks · duration · size — all values vertically aligned */
function ThreeColumns({ tracks, duration, size }: {
  tracks: string;
  duration: string;
  size: string;
}): JSX.Element {
  return (
    <span className="flex gap-2 items-baseline">
      <span className="font-medium">{tracks}</span>
      {duration && (
        <>
          <span className="opacity-30" aria-hidden="true">·</span>
          <span className="opacity-70">{duration}</span>
        </>
      )}
      {size && (
        <>
          <span className="opacity-30" aria-hidden="true">·</span>
          <span className="opacity-70">{size}</span>
        </>
      )}
    </span>
  );
}


export function SyncPreviewModal({
  data,
  convertToMp3,
  bitrate,
  onCancel,
  onConfirm,
}: SyncPreviewModalProps): JSX.Element {
  const showNew = data.newTracksCount > 0 || Boolean(data.newItems?.length);
  const showUpdated = data.updatedTracksCount > 0;
  const showAlreadySynced = data.alreadySyncedCount > 0;
  const showRemove = data.willRemoveCount > 0;
  const showTotal = showNew || showUpdated || showAlreadySynced || showRemove;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        data-testid="sync-preview-modal"
        className="bg-surface_container_low border border-outline_variant rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-headline-md mb-4 flex items-center gap-2 shrink-0">
          <Check className="w-5 h-5 text-primary" />
          Sync Preview
        </h2>

        <div className="space-y-2 mb-4">
          {/* Will remove */}
          {showRemove && (
            <div data-testid="preview-will-remove-section">
              <div className="text-body-md text-error font-medium flex justify-between items-baseline">
                <span>Will remove</span>
                <ThreeColumns
                  tracks={`${data.willRemoveCount.toLocaleString()} tracks`}
                  duration={data.willRemoveDurationSeconds ? formatDuration(data.willRemoveDurationSeconds) : ''}
                  size={data.willRemoveBytes > 0 ? `−${formatBytes(data.willRemoveBytes)}` : ''}
                />
              </div>
            </div>
          )}

          {/* New tracks */}
          {showNew && (
            <div data-testid="preview-new-tracks-section">
              <div className="text-body-md text-primary font-medium flex justify-between items-baseline">
                <span>New tracks</span>
                <ThreeColumns
                  tracks={`${data.newTracksCount.toLocaleString()} tracks`}
                  duration={data.newTracksDurationSeconds ? formatDuration(data.newTracksDurationSeconds) : ''}
                  size={`${convertToMp3 ? '~' : ''}${formatBytes(data.newTracksBytes)}`}
                />
              </div>
            </div>
          )}

          {/* Updated tracks */}
          {showUpdated && (
            <div data-testid="preview-updated-tracks-section">
              <div className="text-body-md text-warning font-medium flex justify-between items-baseline">
                <span>Will update</span>
                <ThreeColumns
                  tracks={`${data.updatedTracksCount.toLocaleString()} tracks`}
                  duration={data.updatedTracksDurationSeconds ? formatDuration(data.updatedTracksDurationSeconds) : ''}
                  size={`${convertToMp3 ? '~' : ''}${formatBytes(data.updatedTracksBytes)}`}
                />
              </div>
            </div>
          )}

          {/* Already synced */}
          {showAlreadySynced && (
            <div data-testid="preview-already-synced-section">
              <div className="text-body-md text-success font-medium flex justify-between items-baseline">
                <span>Already on device</span>
                <ThreeColumns
                  tracks={`${data.alreadySyncedCount.toLocaleString()} tracks`}
                  duration={data.alreadySyncedDurationSeconds ? formatDuration(data.alreadySyncedDurationSeconds) : ''}
                  size={`${convertToMp3 ? '~' : ''}${formatBytes(data.alreadySyncedBytes)}`}
                />
              </div>
            </div>
          )}

          {/* Total */}
          {showTotal && (
            <div className="text-body-md text-on_surface_variant pt-2 border-t border-outline_variant flex justify-between items-baseline" data-testid="preview-total-row">
              <span>Total</span>
              <ThreeColumns
                tracks={`${data.trackCount.toLocaleString()} tracks`}
                duration={data.totalDurationSeconds ? formatDuration(data.totalDurationSeconds) : ''}
                size={`${convertToMp3 ? '~' : ''}${formatBytes(data.totalBytes)}`}
              />
            </div>
          )}
        </div>

        {/* Formats */}
        {Object.keys(data.formatBreakdown).length > 0 && (
          <div className="text-body-md shrink-0">
            <span className="text-on_surface_variant block mb-1">Formats</span>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.formatBreakdown).map(([fmt, bytes]) => (
                <span
                  key={fmt}
                  className="bg-surface_container_highest px-2 py-0.5 rounded text-caption"
                >
                  {fmt.toUpperCase()} · {(bytes / 1024 / 1024).toFixed(0)} MB
                </span>
              ))}
            </div>
          </div>
        )}

        {convertToMp3 && (
          <div className="text-caption text-on_surface_variant bg-surface_container_highest rounded p-2 space-y-1 shrink-0">
            <div>FLAC/lossless → MP3 {bitrate} (estimated size)</div>
            <div>
              MP3 above {bitrate} → re-encoded to {bitrate} (estimated size)
            </div>
          </div>
        )}

        <div className="flex gap-3 mt-4 shrink-0">
          <button
            data-testid="cancel-preview-button"
            onClick={onCancel}
            className="flex-1 py-2 rounded-lg bg-surface_container_highest hover:bg-surface_bright text-body-md transition-colors"
          >
            Cancel
          </button>
          <button
            data-testid="confirm-sync-button"
            onClick={onConfirm}
            className="flex-1 py-2 rounded-lg bg-gradient-primary hover:bg-secondary_container text-body-md font-medium transition-colors"
          >
            Confirm Sync
          </button>
        </div>
      </div>
    </div>
  );
}
