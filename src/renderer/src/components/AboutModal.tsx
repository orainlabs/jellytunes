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
  const [upToDate, setUpToDate] = useState(false)
  const [analyticsEnabled, setAnalyticsEnabled] = useState(true)

  useEffect(() => {
    window.api.getVersion().then(setVersion).catch(() => {})
    window.api.checkForUpdates().then(result => {
      if (result.updateAvailable) setUpdateInfo({ latestVersion: result.latestVersion, releaseUrl: result.releaseUrl })
    }).catch(() => {})
    window.api.getPreferences().then(p => setAnalyticsEnabled(p.analyticsEnabled)).catch(() => {})
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
    setUpToDate(false)
    try {
      const result = await window.api.checkForUpdates(true)
      if (result.updateAvailable) {
        setUpdateInfo({ latestVersion: result.latestVersion, releaseUrl: result.releaseUrl })
      } else {
        setUpToDate(true)
      }
    } finally {
      setCheckingUpdate(false)
    }
  }

  const handleAnalyticsToggle = async (): Promise<void> => {
    const next = !analyticsEnabled
    setAnalyticsEnabled(next)
    await window.api.setPreferences({ analyticsEnabled: next })
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        data-testid="about-modal"
        className="bg-surface_container_low border border-outline_variant rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex flex-col items-center gap-2 mb-4">
          <GradientMusicIcon className="w-10 h-10" />
          <div className="text-center">
            <h2 className="text-headline-md">JellyTunes</h2>
            {version && <p className="text-caption text-on_surface_variant">v{version}</p>}
          </div>
        </div>

        <p className="text-body-md text-on_surface_variant mb-4 text-center">
          Sync music from your Jellyfin server to portable devices.
        </p>

        {/* ── Row 1: Primary actions ── */}
        <div className="flex flex-row gap-4 mb-4 items-stretch">
          <button
            data-testid="report-bug-button"
            onClick={handleReportBug}
            disabled={reporting}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-4 h-12 text-body-md bg-gradient-primary hover:bg-secondary_container disabled:opacity-50 rounded-lg transition-colors font-medium"
          >
            {reporting ? '…' : 'Report a Bug'}
          </button>

          <a
            href="#"
            onClick={e => { e.preventDefault(); window.open('mailto:hello@tresnola.dev') }}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-4 h-12 text-body-md rounded-lg bg-primary_container/10 border border-primary_container/40 text-primary hover:bg-primary_container/20 transition-colors font-medium"
          >
            Contact Us
          </a>

          {updateInfo ? (
            <a
              href="#"
              onClick={e => { e.preventDefault(); window.open(updateInfo.releaseUrl) }}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-4 h-12 text-body-md rounded-lg bg-primary_container/10 border border-primary_container/40 text-primary hover:bg-primary_container/20 transition-colors font-medium"
            >
              v{updateInfo.latestVersion}
            </a>
          ) : upToDate ? (
            <div className="flex-1 flex items-center justify-center gap-1.5 px-3 py-4 h-12 text-body-md rounded-lg bg-surface_container_highest text-on_surface_variant">
              ✓ Up to date
            </div>
          ) : (
            <button
              onClick={handleCheckUpdate}
              disabled={checkingUpdate}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-4 h-12 text-body-md rounded-lg bg-primary_container/10 border border-primary_container/40 text-primary hover:bg-primary_container/20 disabled:opacity-50 transition-colors font-medium"
            >
              {checkingUpdate ? '…' : 'Check Updates'}
            </button>
          )}
        </div>

        {/* ── Row 2: Tertiary links ── */}
        <div className="flex flex-row gap-4 mb-4 items-stretch">
          <a
            href="#"
            onClick={e => { e.preventDefault(); window.open('https://github.com/tresnola-labs/jellytunes') }}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-4 h-12 text-body-md text-on_surface_variant border border-transparent hover:border-outline_variant/40 hover:text-on_surface hover:bg-surface_container_high rounded-lg transition-colors"
          >
            View on GitHub ↗
          </a>

          <a
            href="#"
            onClick={e => { e.preventDefault(); window.open('https://ko-fi.com/tresnolalabs') }}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-4 h-12 text-body-md text-on_surface_variant border border-transparent hover:border-outline_variant/40 hover:text-on_surface hover:bg-surface_container_high rounded-lg transition-colors"
          >
            Support on Ko-fi ☕
          </a>
        </div>

        {/* ── Analytics toggle ── */}
        <div className="flex items-center justify-between px-1 py-2 text-body-sm text-on_surface_variant">
          <span>Anonymous usage statistics</span>
          <button
            onClick={handleAnalyticsToggle}
            aria-label="Anonymous usage statistics"
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              analyticsEnabled ? 'bg-primary_container' : 'bg-surface_container_highest'
            }`}
            aria-checked={analyticsEnabled}
            role="switch"
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              analyticsEnabled ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>
        <p className="text-caption text-on_surface_variant/60 text-center mb-4">
          No personal data collected.{' '}
          <a href="#" onClick={e => { e.preventDefault(); window.open('https://github.com/tresnola-labs/jellytunes/blob/main/PRIVACY.md') }}
             className="underline">Privacy Policy</a>
        </p>

        {/* ── Close ── */}
        <button
          data-testid="about-close-button"
          onClick={onClose}
          className="w-full px-4 py-2 text-body-md text-on_surface_variant hover:text-on_surface transition-colors border border-outline_variant/40 rounded-lg hover:border-outline_variant/60 mt-4"
        >
          Close
        </button>
      </div>
    </div>
  )
}
