import { Check, Loader2 } from 'lucide-react'
import type { PreviewData, Bitrate } from '../appTypes'
import { formatBytes } from '../utils/format'

interface SyncPreviewModalProps {
  data: PreviewData
  convertToMp3: boolean
  bitrate: Bitrate
  onCancel: () => void
  onConfirm: () => void
}

export function SyncPreviewModal({ data, convertToMp3, bitrate, onCancel, onConfirm }: SyncPreviewModalProps): JSX.Element {
  const showNew = data.newTracksCount > 0
  const showUpdated = data.updatedTracksCount > 0
  const showAlreadySynced = data.alreadySyncedCount > 0
  const showRemove = data.willRemoveCount > 0

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <div data-testid="sync-preview-modal" className="bg-surface_container_low border border-outline_variant rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h2 className="text-headline-md mb-4 flex items-center gap-2">
          <Check className="w-5 h-5 text-primary" />
          Sync Preview
          {data.isRefining && <Loader2 className="w-4 h-4 animate-spin text-on_surface_variant ml-1" />}
        </h2>

        <div className="space-y-3 mb-6">
          {/* New tracks */}
          {showNew && (
            <div className="flex justify-between text-body-md">
              <span className="text-primary">New tracks</span>
              <div className="flex items-center gap-2">
                <span data-testid="preview-new-tracks-count" className="font-medium text-primary">{data.newTracksCount.toLocaleString()}</span>
                <span data-testid="preview-new-tracks-size" className="text-primary">({convertToMp3 ? '~' : ''}{formatBytes(data.newTracksBytes)})</span>
              </div>
            </div>
          )}

          {/* Updated tracks */}
          {showUpdated && (
            <div className="flex justify-between text-body-md">
              <span className="text-warning">Will update</span>
              <div className="flex items-center gap-2">
                <span data-testid="preview-updated-tracks-count" className="font-medium text-warning">{data.updatedTracksCount.toLocaleString()}</span>
                <span data-testid="preview-updated-tracks-size" className="text-warning">({convertToMp3 ? '~' : ''}{formatBytes(data.updatedTracksBytes)})</span>
              </div>
            </div>
          )}

          {/* Already synced tracks */}
          {showAlreadySynced && (
            <div className="flex justify-between text-body-md">
              <span className="text-success">Already on device</span>
              <div className="flex items-center gap-2">
                <span className="font-medium text-success">{data.alreadySyncedCount.toLocaleString()}</span>
                <span className="text-success">({convertToMp3 ? '~' : ''}{formatBytes(data.alreadySyncedBytes)})</span>
              </div>
            </div>
          )}

          {/* Will remove */}
          {showRemove && (
            <div className="flex justify-between text-body-md">
              <span className="text-error">Will remove</span>
              <div className="flex items-center gap-2 text-error">
                <span data-testid="preview-will-remove-count" className="font-medium">{data.willRemoveCount.toLocaleString()}</span>
                {data.willRemoveBytes > 0 && (
                  <span data-testid="preview-will-remove-size" className="opacity-70">(−{formatBytes(data.willRemoveBytes)})</span>
                )}
              </div>
            </div>
          )}

          {/* Total */}
          {(showNew || showUpdated || showAlreadySynced) && (
            <div className="flex justify-between text-body-md border-t border-outline_variant pt-2 mt-2">
              <span className="text-on_surface_variant">Total</span>
              <span className="font-medium">{convertToMp3 ? '~' : ''}{formatBytes(data.totalBytes)}</span>
            </div>
          )}

          {/* Formats */}
          {Object.keys(data.formatBreakdown).length > 0 && (
            <div className="text-body-md">
              <span className="text-on_surface_variant block mb-1">Formats</span>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.formatBreakdown).map(([fmt, bytes]) => (
                  <span key={fmt} className="bg-surface_container_highest px-2 py-0.5 rounded text-caption">
                    {fmt.toUpperCase()} · {(bytes / 1024 / 1024).toFixed(0)} MB
                  </span>
                ))}
              </div>
            </div>
          )}

          {convertToMp3 && (
            <div className="text-caption text-on_surface_variant bg-surface_container_highest rounded p-2 space-y-1">
              <div>FLAC/lossless → MP3 {bitrate} (estimated size)</div>
              <div>MP3 above {bitrate} → re-encoded to {bitrate} (estimated size)</div>
            </div>
          )}
        </div>

        <div className="flex gap-3">
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
  )
}