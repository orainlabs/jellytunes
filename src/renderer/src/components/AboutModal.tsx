import { useEffect, useState } from 'react';
import { GradientMusicIcon } from './GradientMusicIcon';
import { SnapPermissionsSection } from './SnapPermissionsSection';
import {
  EMPTY_SNAP_PERMISSIONS_REPORT,
  type SnapPermissionsReport,
} from '../utils/snapPermissions';

interface AboutModalProps {
  onClose: () => void;
}

export function AboutModal({ onClose }: AboutModalProps): JSX.Element {
  const [version, setVersion] = useState<string>('');
  const [reporting, setReporting] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    latestVersion: string;
    releaseUrl: string;
  } | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [upToDate, setUpToDate] = useState(false);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(true);
  const [isSnap, setIsSnap] = useState(false);
  // ORAIN-0578 T2: full report (interfaces + commands) for the section
  // shown below the analytics toggle. Empty report outside snap / when
  // every probe is connected — `SnapPermissionsSection` renders nothing.
  const [snapPermissions, setSnapPermissions] = useState<SnapPermissionsReport>(
    EMPTY_SNAP_PERMISSIONS_REPORT,
  );
  // ORAIN-0735: the absolute log file path is exposed via tooltip + sr-only
  // span so assistive tech and QA can read it. ORAIN-0750 AC7 removed the
  // copy button, so the path no longer needs clipboard wiring.
  const [logPath, setLogPath] = useState<string>('');

  useEffect(() => {
    window.api
      .getVersion()
      .then(setVersion)
      .catch(() => {});
    // ORAIN-0573: under snap, snapd handles the refresh — never show the
    // manual update UI. We still call checkForUpdates so the periodic
    // stats ping fires.
    window.api
      .isSnap()
      .then(setIsSnap)
      .catch(() => {});
    window.api
      .checkForUpdates()
      .then((result) => {
        if (result.managedBySnap) return;
        if (result.updateAvailable)
          setUpdateInfo({ latestVersion: result.latestVersion, releaseUrl: result.releaseUrl });
      })
      .catch(() => {});
    window.api
      .getPreferences()
      .then((p) => setAnalyticsEnabled(p.analyticsEnabled))
      .catch(() => {});
    // ORAIN-0727: load the current log file path on mount so it is visible
    // by the time the user decides to attach the log to a bug report.
    window.api
      .getLogPath()
      .then(setLogPath)
      .catch(() => {});
    // ORAIN-0578 T2: load the permission report so the section can render
    // the missing interfaces with their connect commands.
    window.api
      .checkSnapPermissions()
      .then(setSnapPermissions)
      .catch(() => {});
  }, []);

  const handleReportBug = async (): Promise<void> => {
    setReporting(true);
    try {
      await window.api.reportBug();
    } finally {
      setReporting(false);
    }
  };

  const handleCheckUpdate = async (): Promise<void> => {
    // ORAIN-0573: under snap, the Check Updates button is not rendered, but
    // bail out defensively if anything ever invokes this handler.
    if (isSnap) return;
    setCheckingUpdate(true);
    setUpdateInfo(null);
    setUpToDate(false);
    try {
      const result = await window.api.checkForUpdates(true);
      if (result?.updateAvailable) {
        setUpdateInfo({ latestVersion: result.latestVersion, releaseUrl: result.releaseUrl });
      } else if (result) {
        setUpToDate(true);
      }
    } catch {
      // Network/IPC failure — leave UI in a neutral state instead of crashing.
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleAnalyticsToggle = async (): Promise<void> => {
    const next = !analyticsEnabled;
    setAnalyticsEnabled(next);
    await window.api.setPreferences({ analyticsEnabled: next });
  };

  // ORAIN-0735: open the OS file manager on the log file so users do not
  // have to navigate to the path manually. The renderer never supplies the
  // path — main resolves it from electron-log (see log-folder.ts).
  const handleOpenLogFolder = async (): Promise<void> => {
    await window.api.openLogFolder();
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        data-testid="about-modal"
        className="bg-surface_container_low border border-outline_variant rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center gap-2 mb-4">
          <GradientMusicIcon className="w-10 h-10" />
          <div className="text-center">
            <h2 className="text-headline-md">JellyTunes</h2>
            {version && <p className="text-caption text-on_surface_variant">v{version}</p>}
          </div>
        </div>

        <p className="text-body-md text-on_surface_variant mb-4 text-center">
          Take your Jellyfin music offline on MP3 players and storage devices
        </p>

        {/* ── Group 1: Primary actions (Report a Bug + updates) ── */}
        <div
          data-testid="about-group-primary"
          role="group"
          aria-labelledby="about-group-primary-heading"
          className="flex flex-row gap-4 mb-4 items-stretch"
        >
          <h3 id="about-group-primary-heading" className="sr-only">
            Primary actions
          </h3>
          <button
            data-testid="report-bug-button"
            onClick={handleReportBug}
            disabled={reporting}
            className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-3 py-4 h-12 text-body-md bg-gradient-primary hover:bg-secondary_container disabled:opacity-50 rounded-lg transition-colors font-medium whitespace-nowrap"
          >
            {reporting ? '…' : 'Report a Bug'}
          </button>

          {isSnap ? (
            // ORAIN-0573 AC2: under snap, show a static indicator so the user
            // knows updates are automatic (snapd refreshes the snap).
            <div
              data-testid="snap-managed-indicator"
              className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-3 py-4 h-12 text-body-md rounded-lg bg-surface_container_highest text-on_surface_variant whitespace-nowrap"
              title="Updates are managed automatically by snapd via the Snap Store."
            >
              ✓ Managed via Snap Store
            </div>
          ) : updateInfo ? (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                window.open(updateInfo.releaseUrl);
              }}
              className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-3 py-4 h-12 text-body-md rounded-lg bg-primary_container/10 border border-primary_container/40 text-primary hover:bg-primary_container/20 transition-colors font-medium whitespace-nowrap"
            >
              v{updateInfo.latestVersion}
            </a>
          ) : upToDate ? (
            <div className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-3 py-4 h-12 text-body-md rounded-lg bg-surface_container_highest text-on_surface_variant whitespace-nowrap">
              ✓ Up to date
            </div>
          ) : (
            <button
              onClick={handleCheckUpdate}
              disabled={checkingUpdate}
              className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-3 py-4 h-12 text-body-md rounded-lg bg-primary_container/10 border border-primary_container/40 text-primary hover:bg-primary_container/20 disabled:opacity-50 transition-colors font-medium whitespace-nowrap"
            >
              {checkingUpdate ? '…' : 'Check Updates'}
            </button>
          )}
        </div>

        {/* ── Group 2: Accessory / external links ── */}
        <nav
          data-testid="about-group-accessory"
          role="group"
          aria-label="External links"
          className="flex flex-row flex-wrap gap-2 mb-4"
        >
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.open('mailto:hi@orainlabs.dev');
            }}
            className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-3 py-1 text-body-sm text-on_surface_variant border border-transparent hover:border-outline_variant/40 hover:text-on_surface hover:bg-surface_container_high rounded-lg transition-colors"
          >
            Contact Us {'✉\uFE0F'}
          </a>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.open('https://github.com/orainlabs/jellytunes');
            }}
            className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-3 py-1 text-body-sm text-on_surface_variant border border-transparent hover:border-outline_variant/40 hover:text-on_surface hover:bg-surface_container_high rounded-lg transition-colors"
          >
            View on GitHub {'↗\uFE0F'}
          </a>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.open('https://ko-fi.com/orainlabs');
            }}
            className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-3 py-1 text-body-sm text-on_surface_variant border border-transparent hover:border-outline_variant/40 hover:text-on_surface hover:bg-surface_container_high rounded-lg transition-colors"
          >
            Support on Ko-fi {'☕\uFE0F'}
          </a>
        </nav>

        {/* ── Group 3: App-level controls ── */}
        <div
          data-testid="about-group-app"
          role="group"
          aria-label="App settings"
          className="border-t border-outline_variant/40 pt-4 mb-4"
        >
          {/* ORAIN-0756: the App heading is gone — the group is named via
              aria-label. The log-files row sits above the analytics row
              so the privacy line stays glued to the switch it refers to. */}
          <div className="flex items-center justify-between px-1 py-2 text-body-sm text-on_surface_variant">
            <span>Log files</span>
            <button
              type="button"
              data-testid="open-log-folder-button"
              onClick={() => {
                void handleOpenLogFolder();
              }}
              title={logPath || undefined}
              aria-label="Open log folder"
              className="px-3 py-1 text-body-sm text-on_surface_variant border border-outline_variant/40 hover:text-on_surface rounded-lg transition-colors whitespace-nowrap"
            >
              Open folder
            </button>
          </div>
          {/* data-testid="log-path" is preserved (sr-only) so QA can read
              the resolved path without exposing it visually. */}
          <span data-testid="log-path" className="sr-only">
            {logPath}
          </span>

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
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  analyticsEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
          <p className="text-caption text-on_surface_variant/60 text-center mt-2">
            No personal data collected.{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                window.open('https://github.com/orainlabs/jellytunes/blob/main/PRIVACY.md');
              }}
              className="underline"
            >
              Privacy Policy
            </a>
          </p>

          {/* ── ORAIN-0578 T2: missing snap permissions, if any ── */}
          <SnapPermissionsSection report={snapPermissions} />
        </div>

        {/* ── Close ── */}
        <button
          data-testid="about-close-button"
          onClick={onClose}
          className="w-full px-4 py-2 text-body-md text-on_surface_variant hover:text-on_surface transition-colors border border-outline_variant/40 rounded-lg hover:border-outline_variant/60"
        >
          Close
        </button>
      </div>
    </div>
  );
}
