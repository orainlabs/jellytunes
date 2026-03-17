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
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Check className="w-5 h-5 text-blue-500" />
          Sync Preview
        </h2>
        <div className="space-y-3 mb-6">
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Tracks to sync</span>
            <span className="font-medium">{data.trackCount.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Total size</span>
            <span className="font-medium">{(data.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB</span>
          </div>
          {data.alreadySyncedCount > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Previously synced</span>
              <span className="text-green-400">{data.alreadySyncedCount} (will skip if unchanged)</span>
            </div>
          )}
          {(data.willRemoveCount ?? 0) > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Will remove from device</span>
              <span className="text-red-400">{data.willRemoveCount} item(s)</span>
            </div>
          )}
          {Object.keys(data.formatBreakdown).length > 0 && (
            <div className="text-sm">
              <span className="text-zinc-400 block mb-1">Formats</span>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.formatBreakdown).map(([fmt, bytes]) => (
                  <span key={fmt} className="bg-zinc-800 px-2 py-0.5 rounded text-xs">
                    {fmt.toUpperCase()} · {(bytes / 1024 / 1024).toFixed(0)} MB
                  </span>
                ))}
              </div>
            </div>
          )}
          {convertToMp3 && (
            <div className="text-xs text-zinc-500 bg-zinc-800 rounded p-2">
              FLAC/lossless will be converted to MP3 {bitrate}
            </div>
          )}
        </div>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-sm font-medium transition-colors"
          >
            Confirm Sync
          </button>
        </div>
      </div>
    </div>
  )
}
