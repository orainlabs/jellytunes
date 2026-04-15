import { Check } from 'lucide-react'
import type { PreviewData, Bitrate } from '../appTypes'

interface SyncPreviewModalProps {
  data: PreviewData
  convertToMp3: boolean
  bitrate: Bitrate
  onCancel: () => void
  onConfirm: () => void
}

export function SyncPreviewModal({ data, convertToMp3, bitrate, onCancel, onConfirm }: SyncPreviewModalProps): JSX.Element {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <div data-testid="sync-preview-modal" className="bg-surface_container_low border border-outline_variant rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h2 className="text-headline-md mb-4 flex items-center gap-2">
          <Check className="w-5 h-5 text-primary" />
          Sync Preview
        </h2>
        <div className="space-y-3 mb-6">
          <div className="flex justify-between text-body-md">
            <span className="text-on_surface_variant">Tracks to sync</span>
            <span data-testid="preview-track-count" className="text-body-md font-medium">{data.trackCount.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-body-md">
            <span className="text-on_surface_variant">Total size</span>
            <span data-testid="preview-total-size" className="text-body-md font-medium">{(data.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB</span>
          </div>
          {data.alreadySyncedCount > 0 && (
            <div className="flex justify-between text-body-md">
              <span className="text-on_surface_variant">Previously synced</span>
              <span className="text-success">{data.alreadySyncedCount} (will skip if unchanged)</span>
            </div>
          )}
          {(data.willRemoveCount ?? 0) > 0 && (
            <div className="flex justify-between text-body-md">
              <span className="text-on_surface_variant">Will remove from device</span>
              <span className="text-error">{data.willRemoveCount} item(s)</span>
            </div>
          )}
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
              <div>FLAC/lossless and other formats → MP3 {bitrate}</div>
              <div>MP3 tracks above {bitrate} → re-encoded to {bitrate}</div>
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
