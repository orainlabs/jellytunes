import { HardDrive, Loader2 } from 'lucide-react'
import type { Bitrate, SyncProgressInfo } from '../appTypes'

interface SyncPanelProps {
  syncFolder: string | null
  convertToMp3: boolean
  bitrate: Bitrate
  isSyncing: boolean
  isLoadingPreview: boolean
  syncProgress: SyncProgressInfo | null
  selectionSummary: string
  selectedCount: number
  onSelectFolder: () => void
  onToggleConvert: () => void
  onBitrateChange: (b: Bitrate) => void
  onStartSync: () => void
}

export function SyncPanel({
  syncFolder,
  convertToMp3,
  bitrate,
  isSyncing,
  isLoadingPreview,
  syncProgress,
  selectionSummary,
  selectedCount,
  onSelectFolder,
  onToggleConvert,
  onBitrateChange,
  onStartSync,
}: SyncPanelProps): JSX.Element {
  return (
    <div className="p-8">
      <h2 className="text-xl font-semibold mb-6">Sync to Device</h2>

      <div className="max-w-lg">
        {/* Selection Summary */}
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 mb-6">
          <h3 className="text-sm font-medium text-zinc-400 mb-2">Items to sync:</h3>
          <p className="text-lg font-semibold">{selectionSummary}</p>
          <p className="text-sm text-zinc-500 mt-1">Total: {selectedCount} item{selectedCount !== 1 ? 's' : ''}</p>
        </div>

        {/* Destination */}
        <div className="bg-zinc-900 rounded-xl p-6 border border-zinc-800 mb-6">
          <h3 className="font-medium mb-4">Select Destination</h3>

          {syncFolder ? (
            <div className="p-4 bg-zinc-800 rounded-lg mb-4">
              <p className="text-sm text-zinc-400 mb-1">Selected folder:</p>
              <p className="text-sm font-mono break-all">{syncFolder}</p>
              <button onClick={onSelectFolder} className="mt-3 text-sm text-blue-500 hover:text-blue-400">
                Change folder
              </button>
            </div>
          ) : (
            <button
              onClick={onSelectFolder}
              className="w-full p-4 border-2 border-dashed border-zinc-700 rounded-lg hover:border-zinc-600 transition-colors text-left"
            >
              <HardDrive className="w-8 h-8 text-zinc-500 mb-2" />
              <p className="text-zinc-400">Click to select a folder</p>
              <p className="text-xs text-zinc-500 mt-1">Choose where to sync your music</p>
            </button>
          )}
        </div>

        {/* Convert to MP3 */}
        <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-sm">Convert to MP3</span>
            <button
              onClick={onToggleConvert}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${convertToMp3 ? 'bg-blue-600' : 'bg-zinc-600'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${convertToMp3 ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          {convertToMp3 && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs text-zinc-400">Bitrate:</span>
              {(['128k', '192k', '320k'] as const).map(b => (
                <button
                  key={b}
                  onClick={() => onBitrateChange(b)}
                  className={`px-2 py-1 text-xs rounded ${bitrate === b ? 'bg-blue-600 text-white' : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'}`}
                >
                  {b}
                </button>
              ))}
            </div>
          )}
          <p className="text-xs text-zinc-500 mt-2">
            {convertToMp3 ? `FLAC/M4A/AAC/OGG → MP3 ${bitrate}` : 'Files copied as-is'}
          </p>
        </div>

        {syncFolder && (
          <button
            onClick={onStartSync}
            disabled={isSyncing || isLoadingPreview}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-700 py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
          >
            {isLoadingPreview ? <><Loader2 className="w-4 h-4 animate-spin" /> Calculating...</> :
              isSyncing ? 'Syncing...' : 'Start Sync'}
          </button>
        )}

        {/* Progress */}
        {syncProgress && (
          <div className="mt-6 p-4 bg-zinc-900 rounded-lg">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-zinc-400">Progress</span>
              <span>{syncProgress.current} / {syncProgress.total}</span>
            </div>
            <div className="w-full bg-zinc-700 rounded-full h-2 mb-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all"
                style={{ width: `${syncProgress.total > 0 ? (syncProgress.current / syncProgress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="text-xs text-zinc-500 truncate">{syncProgress.file}</p>
          </div>
        )}

        <div className="mt-8 p-4 bg-zinc-900 rounded-lg">
          <h4 className="font-medium mb-2">How it works:</h4>
          <ul className="text-sm text-zinc-400 space-y-1">
            <li>1. Select a folder (USB drive, external HDD, etc.)</li>
            <li>2. Click "Start Sync" to begin</li>
            <li>3. Music will be copied to your device</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
