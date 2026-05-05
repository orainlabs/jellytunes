import type { SyncProgressInfo } from '../appTypes'
import { formatBytes } from '../utils/format'

function getPhaseLabel(phase?: string): string {
  switch (phase) {
    case 'fetching': return 'Fetching...'
    case 'copying': return 'Copying...'
    case 'converting': return 'Converting...'
    case 'validating': return 'Validating...'
    case 'complete': return 'Complete'
    case 'cancelled': return 'Cancelled'
    case 'error': return 'Error'
    default: return 'Syncing...'
  }
}

interface SyncProgressBarProps {
  syncProgress: SyncProgressInfo
}

export function SyncProgressBar({ syncProgress }: SyncProgressBarProps): JSX.Element {
  const { current, total, file, phase, bytesProcessed, totalBytes, isCancelling } = syncProgress

  const isIndeterminate = phase === 'fetching' || !total
  const pct = total > 0 ? (current / total) * 100 : 0

  const phaseLabel = isCancelling ? 'CANCELLING…' : getPhaseLabel(phase)

  const bytesLabel = bytesProcessed !== undefined && totalBytes !== undefined
    ? `${formatBytes(bytesProcessed)} / ${formatBytes(totalBytes)}`
    : total > 0 ? `${current} / ${total}` : ''

  return (
    <div className="p-4 bg-surface_container_low rounded-xl border border-outline_variant">
      {/* Fila 1: phase label ··· bytes */}
      <div className="flex justify-between items-center mb-2">
        <span className="text-label-md uppercase">{phaseLabel}</span>
        {bytesLabel && (
          <span className="text-body-sm text-on_surface_variant" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {bytesLabel}
          </span>
        )}
      </div>

      {/* Progress track */}
      <div className="w-full bg-surface_container_highest rounded-full h-2 overflow-hidden">
        {isIndeterminate ? (
          <div className="h-2 bg-gradient-primary rounded-full animate-shimmer" style={{ width: '100%' }} />
        ) : isCancelling ? (
          <div
            className="h-2 bg-surface_container_high rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div
            className="h-2 bg-gradient-primary rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>

      {/* Fila 2: current/total ··· currentTrack */}
      <div className="flex justify-between items-center mt-2">
        <span className="text-body-sm text-on_surface_variant" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {current} / {total}
        </span>
        <span className="text-body-sm text-on_surface_variant truncate ml-4" title={file}>
          {file}
        </span>
      </div>
    </div>
  )
}
