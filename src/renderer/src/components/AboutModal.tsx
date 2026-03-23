import { useEffect, useState } from 'react'
import { GradientMusicIcon } from './GradientMusicIcon'

interface AboutModalProps {
  onClose: () => void
}

export function AboutModal({ onClose }: AboutModalProps): JSX.Element {
  const [version, setVersion] = useState<string>('')
  const [reporting, setReporting] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<{ latestVersion: string; releaseUrl: string } | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)

  useEffect(() => {
    window.api.getVersion().then(setVersion).catch(() => {})
    window.api.checkForUpdates().then(result => {
      if (result.updateAvailable) setUpdateInfo({ latestVersion: result.latestVersion, releaseUrl: result.releaseUrl })
    }).catch(() => {})
  }, [])

  const handleReportBug = async (): Promise<void> => {
    setReporting(true)
    try {
      await window.api.reportBug()
    } finally {
      setReporting(false)
    }
  }

  const handleCheckUpdate = async (): Promise<void> => {
    setCheckingUpdate(true)
    setUpdateInfo(null)
    try {
      const result = await window.api.checkForUpdates()
      if (result.updateAvailable) {
        setUpdateInfo({ latestVersion: result.latestVersion, releaseUrl: result.releaseUrl })
      } else {
        setUpdateInfo(null)
      }
    } finally {
      setCheckingUpdate(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        data-testid="about-modal"
        className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex flex-col items-center gap-2 mb-4">
          <GradientMusicIcon className="w-10 h-10" />
          <div className="text-center">
            <h2 className="text-lg font-semibold">JellyTunes</h2>
            {version && <p className="text-xs text-zinc-500">v{version}</p>}
          </div>
        </div>

        <p className="text-sm text-zinc-400 mb-4 text-center">
          Sync music from your Jellyfin server to portable devices.
        </p>

        {updateInfo ? (
          <a
            href="#"
            onClick={e => { e.preventDefault(); window.open(updateInfo.releaseUrl) }}
            className="flex items-center justify-center gap-2 w-full px-4 py-2 mb-4 text-sm rounded-lg bg-jf-purple/20 border border-jf-purple/40 text-jf-purple-light hover:bg-jf-purple/30 transition-colors"
          >
            v{updateInfo.latestVersion} available — download ↗
          </a>
        ) : (
          <button
            onClick={handleCheckUpdate}
            disabled={checkingUpdate}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 mb-4 text-sm rounded-lg bg-jf-purple/10 text-jf-purple-light hover:bg-jf-purple/20 disabled:opacity-50 transition-colors"
          >
            {checkingUpdate ? 'Checking…' : 'Check for updates'}
          </button>
        )}

        <div className="space-y-2">
          <button
            data-testid="report-bug-button"
            onClick={handleReportBug}
            disabled={reporting}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm bg-jf-purple hover:bg-jf-purple-dark disabled:opacity-50 rounded-lg transition-colors font-medium"
          >
            {reporting ? 'Opening…' : 'Report a Bug'}
          </button>

          <a
            href="#"
            onClick={e => { e.preventDefault(); window.open('mailto:hello@oriaflow.dev') }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm bg-jf-purple hover:bg-jf-purple-dark rounded-lg transition-colors font-medium"
          >
            Contact us
          </a>

          <a
            href="#"
            onClick={e => { e.preventDefault(); window.open('https://github.com/oriaflow-labs/jellytunes') }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            View on GitHub
          </a>

          <a
            href="#"
            onClick={e => { e.preventDefault(); window.open('https://ko-fi.com/oriaflowlabs') }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            Support on Ko-fi ☕
          </a>
        </div>

        <button
          data-testid="about-close-button"
          onClick={onClose}
          className="mt-4 w-full px-4 py-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  )
}
