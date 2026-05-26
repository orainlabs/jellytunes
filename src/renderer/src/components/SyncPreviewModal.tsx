import { Check, Loader2 } from 'lucide-react';
import type { PreviewData, Bitrate, ItemPreview } from '../appTypes';
import { formatBytes, formatDuration } from '../utils/format';

interface SyncPreviewModalProps {
  data: PreviewData;
  convertToMp3: boolean;
  bitrate: Bitrate;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Format a single item row: "Name  N tracks (size · duration)" */
function formatItemRow(item: ItemPreview, convertToMp3: boolean): string {
  return `${item.name}  ${item.trackCount} track${item.trackCount !== 1 ? 's' : ''} (${convertToMp3 ? '~' : ''}${formatBytes(item.sizeBytes)} · ${formatDuration(item.durationSeconds)})`;
}

/** Format the Total row: "Total  N (size · duration)" */
function formatTotalRow(data: PreviewData, convertToMp3: boolean): string {
  return `Total  ${data.trackCount} (${convertToMp3 ? '~' : ''}${formatBytes(data.totalBytes)} · ${formatDuration(data.totalDurationSeconds)})`;
}

export function SyncPreviewModal({
  data,
  convertToMp3,
  bitrate,
  onCancel,
  onConfirm,
}: SyncPreviewModalProps): JSX.Element {
  const showNew = data.newTracksCount > 0;
  const showUpdated = data.updatedTracksCount > 0;
  const showAlreadySynced = data.alreadySyncedCount > 0;
  const showRemove = data.willRemoveCount > 0;
  const showTotal = showNew || showUpdated || showAlreadySynced;

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
          {data.isRefining && (
            <Loader2 className="w-4 h-4 animate-spin text-on_surface_variant ml-1" />
          )}
        </h2>

        {/* Summary stats */}
        <div className="flex gap-4 mb-4 text-body-sm text-on_surface_variant shrink-0">
          <span data-testid="preview-track-count">
            {data.trackCount.toLocaleString()} track{data.trackCount !== 1 ? 's' : ''}
          </span>
          {data.totalDurationSeconds > 0 && (
            <span data-testid="preview-duration">{formatDuration(data.totalDurationSeconds)}</span>
          )}
        </div>

        {/* Scrollable items list */}
        <div className="flex-1 overflow-y-auto space-y-2 mb-4">
          {/* Will remove */}
          {showRemove && (
            <div data-testid="preview-will-remove-section">
              <div className="text-body-md text-error font-medium mb-1">
                Will remove{' '}
                <span data-testid="preview-will-remove-count">
                  {data.willRemoveCount.toLocaleString()}
                </span>{' '}
                track{data.willRemoveCount !== 1 ? 's' : ''}
                {data.willRemoveBytes > 0 && (
                  <span data-testid="preview-will-remove-size" className="opacity-70 ml-1">
                    (−{formatBytes(data.willRemoveBytes)})
                  </span>
                )}
              </div>
              {data.removedItems && data.removedItems.length > 0 && (
                <div className="ml-2 space-y-1">
                  {data.removedItems.map((item) => (
                    <div key={item.id} className="text-body-sm text-error">
                      {formatItemRow(item, convertToMp3)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* New tracks */}
          {showNew && (
            <div data-testid="preview-new-tracks-section">
              <div className="text-body-md text-primary font-medium mb-1">
                New tracks{' '}
                <span data-testid="preview-new-tracks-count">
                  {data.newTracksCount.toLocaleString()}
                </span>{' '}
                <span data-testid="preview-new-tracks-size" className="opacity-70">
                  ({convertToMp3 ? '~' : ''}
                  {formatBytes(data.newTracksBytes)})
                </span>
              </div>
              {data.newItems && data.newItems.length > 0 && (
                <div className="ml-2 space-y-1">
                  {data.newItems.map((item) => (
                    <div key={item.id} className="text-body-sm text-primary">
                      {formatItemRow(item, convertToMp3)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Updated tracks */}
          {showUpdated && (
            <div data-testid="preview-updated-tracks-section">
              <div className="text-body-md text-warning font-medium mb-1">
                Will update{' '}
                <span data-testid="preview-updated-tracks-count">
                  {data.updatedTracksCount.toLocaleString()}
                </span>{' '}
                <span data-testid="preview-updated-tracks-size" className="opacity-70">
                  ({convertToMp3 ? '~' : ''}
                  {formatBytes(data.updatedTracksBytes)})
                </span>
              </div>
              {data.updatedItems && data.updatedItems.length > 0 && (
                <div className="ml-2 space-y-1">
                  {data.updatedItems.map((item) => (
                    <div key={item.id} className="text-body-sm text-warning">
                      {formatItemRow(item, convertToMp3)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Already synced */}
          {showAlreadySynced && (
            <div data-testid="preview-already-synced-section">
              <div className="text-body-md text-success font-medium mb-1">
                Already on device{' '}
                <span className="font-medium">{data.alreadySyncedCount.toLocaleString()}</span>{' '}
                <span className="opacity-70">
                  ({convertToMp3 ? '~' : ''}
                  {formatBytes(data.alreadySyncedBytes)})
                </span>
              </div>
              {data.alreadySyncedItems && data.alreadySyncedItems.length > 0 && (
                <div className="ml-2 space-y-1">
                  {data.alreadySyncedItems.map((item) => (
                    <div key={item.id} className="text-body-sm text-success">
                      {formatItemRow(item, convertToMp3)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Total */}
          {showTotal && (
            <div
              className="text-body-md text-on_surface_variant pt-2 border-t border-outline_variant"
              data-testid="preview-total-row"
            >
              {formatTotalRow(data, convertToMp3)}
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
