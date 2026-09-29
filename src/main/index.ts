import { app, shell, BrowserWindow, ipcMain, dialog, safeStorage, Menu } from 'electron';
import { join, basename } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'node:crypto';

// Import new sync module
import { createSyncCore, type CoverArtMode, type TrackInfo } from '../sync';
import { createNodeFileSystem } from '../sync/sync-files';
// ORAIN-0562: main-side wrapper that injects the auth identity (client/version/
// device/deviceId) so call sites in `main/index.ts` don't repeat themselves.
import { createMainApiClient } from './api-client';
import { detectSnapEnv, type SnapEnv } from './snap-env';
import { buildUpdateCheckResult, type UpdateCheckResult } from './update-checker';
import { createSecureStorageProvider, type StorageProvider } from './secure-storage';
import {
  saveSession as saveSessionHandler,
  loadSession as loadSessionHandler,
  clearSession as clearSessionHandler,
} from './session-handlers';
import { createSecretStore } from './secret-store';
import { createSecretToolRunner } from './secret-tool.adapter';
import { createElectronLogger } from './logger-types';
import { getAppMenuTemplate } from './app-menu';
import {
  buildSnapPermissionsReport,
  type SnapPermissionsReport,
  type BuildSnapPermissionsReportInput,
} from './snap-permissions';
import { runSnapConnectionProbes, type SnapctlResult } from './snap-connections';
import { listRemovableMountpoints } from './removable-mounts';
import { detectLinuxFilesystem } from './filesystem-type';
import {
  detectWindowsFilesystem,
  listWindowsDriveLetters,
  oncePerSession,
  realFsutil,
} from './windows-fsutil';
import { detectDarwinFilesystem, realDarwinFs } from './darwin-diskutil';
import { getOrCreateDeviceId } from './device-id';
import { showLogFileInFolder } from './log-folder';
import { isValidPath } from './path-validation';
import { buildAuthHeader, CLIENT_NAME_DEFAULT, DEFAULT_DEVICE_NAME } from '../shared/auth-headers';
// ORAIN-0740: [sync-start]/[sync-end]/[track-failed] log lines + error scrubbing.
// The wrappers in log-scrub make sure the error object never reaches log.error.
import { logSyncError, diffAndLogVolumes, scrubPath, type VolumeLogState } from './log-scrub';
import { buildBugReportBody } from './bug-report-excerpt';

// ─── Snap detection (ORAIN-0573) ─────────────────────────────────────────
// snapd sets SNAP (mount path) and SNAP_NAME (registered name) on every
// process it launches. Detection is computed once at module load — env
// vars don't change at runtime.
const snapEnv: SnapEnv = detectSnapEnv(process.env);
const IS_SNAP: boolean = snapEnv.isSnap;

// ─── Snap permission probes (ORAIN-0578) ─────────────────────────────────
// Ask snapd directly rather than inferring each plug's state from what the
// filesystem lets us touch. The earlier filesystem probes were unreliable:
// a plug whose files were unreadable was reported "missing" even when
// actually connected, and vice versa for plugs whose files were
// world-readable.
const SNAPCTL_TIMEOUT_MS = 2000;
function runSnapctl(args: string[]): SnapctlResult {
  const result = spawnSync('snapctl', args, {
    encoding: 'utf8',
    timeout: SNAPCTL_TIMEOUT_MS,
  });
  return { status: result.status, error: result.error };
}

// Each probe is a blocking `spawnSync`, and the renderer asks twice (app
// mount + About modal). `snap connect` only takes effect on the next
// launch, so the answer is immutable for this process — probe once.
let snapProbesCache: BuildSnapPermissionsReportInput['probes'] | null = null;

/** Run every probe (under snap only — caller gates on `IS_SNAP`). */
function runSnapPermissionProbes(): BuildSnapPermissionsReportInput['probes'] {
  snapProbesCache ??= runSnapConnectionProbes(runSnapctl);
  return snapProbesCache;
}

// ─── Module-level track cache (ORAIN-0484) ─────────────────────────────────
// Shared between sync:getTracksForItems and sync:analyzeDiff handlers.
// Key format: `${serverUrl}:${userId}:${itemId}` — per-itemId, not per-combination.
// TTL: 1 hour with lazy eviction on read.
// Invalidation: entries removed after successful sync:start2.
const TRACK_CACHE_TTL_MS = 3_600_000; // 1 hour
const _trackCache = new Map<string, { tracks: TrackInfo[]; fetchedAt: number }>();

/** Item types whose tracks are cached. */
type CacheItemType = 'artist' | 'album' | 'playlist' | 'albumArtist' | 'genre';
const CACHE_ITEM_TYPES: readonly CacheItemType[] = [
  'artist',
  'album',
  'playlist',
  'albumArtist',
  'genre',
];

// ─── Cache helpers (exported for testability) ──────────────────────────────
/**
 * Build cache key from serverUrl, userId, itemType, and itemId.
 *
 * The type MUST be part of the key: a Jellyfin id can be queried both as an
 * `artist` (ArtistIds= → every track the person performs on, incl. collaborations)
 * and as an `albumArtist` (AlbumArtistIds= → only albums they own). These return
 * different track sets, so a type-agnostic key let the narrower albumArtist result
 * shadow a later artist request, freezing size/track-count until app restart
 * (ORAIN-0561).
 */
function _buildTrackCacheKey(
  serverUrl: string,
  userId: string,
  itemType: CacheItemType,
  itemId: string,
): string {
  return `${serverUrl}:${userId}:${itemType}:${itemId}`;
}

/** Get tracks from cache if present and not expired; returns undefined otherwise */
function _getFromTrackCache(key: string): TrackInfo[] | undefined {
  const entry = _trackCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > TRACK_CACHE_TTL_MS) {
    _trackCache.delete(key); // lazy eviction
    return undefined;
  }
  return entry.tracks;
}

/** Store tracks in cache with current timestamp */
function _setInTrackCache(key: string, tracks: TrackInfo[]): void {
  _trackCache.set(key, { tracks, fetchedAt: Date.now() });
}

/** Invalidate cache entries for given itemIds across every cached type. */
function _invalidateTrackCache(serverUrl: string, userId: string, itemIds: string[]): void {
  for (const itemId of itemIds) {
    for (const itemType of CACHE_ITEM_TYPES) {
      _trackCache.delete(_buildTrackCacheKey(serverUrl, userId, itemType, itemId));
    }
  }
}

// Import database
import {
  initDatabase,
  recordSyncCompleted,
  getSyncedItems,
  getDeviceSyncInfo,
  getRecentSyncHistory,
  removeSyncedItems,
  clearDestinationRecords,
  getSyncedTracksForDevice,
} from './database';

// Import preferences
import { getPreferences, setPreferences } from './preferences';

// Configure logger before anything else
import { configureLogger, log } from './logger';
configureLogger();
log.info('JellyTunes starting...');

let mainWindow: BrowserWindow | null = null;

// ORAIN-0740 AC4: shared state for the volume-detection diff helper. The
// device-watcher polls `listUsbDevices()` every 15 s; this lets the
// per-poll log line fire only when the device set actually changes.
const volumeLogState: VolumeLogState = { lastDeviceKeys: null, errorLogged: { logged: false } };

// Import device watcher
import { startDeviceWatcher, stopDeviceWatcher } from './device-watcher';

interface UsbDevice {
  device: string;
  displayName: string;
  size: number;
  mountpoints: Array<{ path: string }>;
  isRemovable: boolean;
  vendorName?: string;
  serialNumber?: string;
}

interface DeviceInfo {
  total: number;
  free: number;
  used: number;
}

/**
 * Find mounted volumes under conventional removable-media roots.
 *
 * Detection compares each candidate's `st_dev` against its parent's, which
 * identifies a real mount boundary — so it reaches volumes nested under a
 * per-user directory (the GVFS/udisks2 convention `/media/$USER/$LABEL`)
 * instead of stopping at the intermediate `$USER` directory and treating it
 * as the device. See `removable-mounts.ts`.
 *
 * This replaced a /proc/mounts read, which required the `mount-observe`
 * interface (ORAIN-0592). The scan now stays inside the `removable-media`
 * grant the app already needs, so there is no degraded fallback path.
 */
function listLinuxRemovableMounts(): UsbDevice[] {
  return listRemovableMountpoints(fs).map((mountpoint) => ({
    device: mountpoint,
    displayName: basename(mountpoint),
    size: 0,
    mountpoints: [{ path: mountpoint }],
    isRemovable: true,
  }));
}

async function listUsbDevices(): Promise<UsbDevice[]> {
  // drivelist removed - using folder selection instead
  // For USB detection, user selects folder manually.
  // ORAIN-0740 AC4: the per-poll "Found N volumes" line previously fired
  // every 15 s and produced ~240 lines/hour in main.log for a steady
  // state. The diff helper below only logs when the device set changes.
  const devices = listMountedVolumesFallback();
  diffAndLogVolumes(volumeLogState, devices, log);
  return devices;
}

function listMountedVolumesFallback(): UsbDevice[] {
  const platform = process.platform;
  const devices: UsbDevice[] = [];
  try {
    if (platform === 'darwin') {
      const volumesPath = '/Volumes';
      if (fs.existsSync(volumesPath)) {
        const volumes = fs.readdirSync(volumesPath);
        const SYSTEM_VOLUMES = new Set([
          'Macintosh HD',
          'Macintosh HD - Data',
          'System',
          'Preboot',
          'Recovery',
          'VM',
          'Update',
        ]);
        for (const vol of volumes) {
          if (SYSTEM_VOLUMES.has(vol) || vol.startsWith('.')) continue;
          const volPath = join(volumesPath, vol);
          try {
            const stats = fs.statSync(volPath);
            if (stats.isDirectory()) {
              devices.push({
                device: volPath,
                displayName: vol,
                size: 0,
                mountpoints: [{ path: volPath }],
                isRemovable: true,
                vendorName: 'External',
              });
            }
          } catch (_e) {
            /* ignore */
          }
        }
      }
    } else if (platform === 'linux') {
      devices.push(...listLinuxRemovableMounts());
    } else if (platform === 'win32') {
      // ORAIN-0725 / GitHub issue #23: the Windows volume-detection binary
      // used pre-24H2 is gone in Windows 11 24H2+.
      // `fsutil fsinfo drives` ships in C:\Windows\System32 on every supported
      // Windows install and has no PowerShell startup cost. Errors are logged
      // once per session — the device-watcher polls every 15 s and would
      // otherwise log-bomb the file.
      try {
        const driveLetters = listWindowsDriveLetters(realFsutil);
        for (const letter of driveLetters) {
          const mountPath = `${letter}\\`;
          devices.push({
            device: mountPath,
            displayName: letter,
            size: 0,
            mountpoints: [{ path: mountPath }],
            isRemovable: true,
            vendorName: 'Local',
          });
        }
      } catch (err) {
        oncePerSession(windowsDriveDetectionState, () => {
          logSyncError(log, 'Windows drive detection error', err);
        });
      }
    }
  } catch (err2) {
    // ORAIN-0740 AC4: once-per-session so a steady-state poll error does
    // not flood main.log at ~4 lines/minute.
    oncePerSession(fallbackVolumeDetectionState, () => {
      logSyncError(log, 'Fallback volume detection error', err2);
    });
  }
  return devices;
}

async function getDeviceInfo(devicePath: string): Promise<DeviceInfo> {
  try {
    const platform = process.platform;
    if (platform === 'darwin' || platform === 'linux') {
      // fs.statfsSync is a syscall, not a subprocess exec — unlike `df`, it
      // isn't blocked by strict Snap confinement's AppArmor exec policy.
      const stats = fs.statfsSync(devicePath);
      const total = stats.blocks * stats.bsize;
      const free = stats.bavail * stats.bsize;
      const used = total - stats.bfree * stats.bsize;
      return { total, free, used };
    }
    if (platform === 'win32') {
      // ORAIN-0725 / GitHub issue #23: the pre-24H2 Windows volume binary is
      // gone in Windows 11 24H2+.
      // Use `fs.statfsSync` (no subprocess) — Node fills these fields from
      // `GetDiskFreeSpaceExW`. Returns the values in fragments (clusters ×
      // sectors-per-cluster), so multiply by `bsize` to get bytes.
      const stats = fs.statfsSync(devicePath);
      const total = stats.blocks * stats.bsize;
      const free = stats.bavail * stats.bsize;
      const used = total - stats.bfree * stats.bsize;
      return { total, free, used };
    }
  } catch (error) {
    logSyncError(log, 'Error getting device info', error);
  }
  return { total: 0, free: 0, used: 0 };
}

async function detectFilesystem(devicePath: string): Promise<string> {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      // ORAIN-0746: `diskutil info <path>` only accepts a mount point or a
      // disk identifier — any subdirectory returns "Could not find disk"
      // and the label falls back to `unknown`, which leaves
      // `sanitizePathComponent` a no-op on darwin. Resolve the mount
      // point via `df -P` first, then ask `diskutil` about the mount.
      return detectDarwinFilesystem(realDarwinFs, devicePath);
    }
    if (platform === 'linux') {
      // statfs the path directly instead of exec'ing `df -T` or matching the
      // longest mountpoint prefix in /proc/mounts — the syscall is in snapd's
      // default seccomp template, so it needs no interface at all, where
      // reading /proc/mounts needed `mount-observe` (ORAIN-0592).
      const label = detectLinuxFilesystem(fs, devicePath);
      if (label !== 'unknown') return label;
    } else if (platform === 'win32') {
      // ORAIN-0725 / GitHub issue #23: the pre-24H2 Windows volume binary is
      // gone in Windows 11 24H2+.
      // Use `fsutil fsinfo volumeinfo <drive>:` which ships in every Windows
      // install. Returns 'unknown' on any failure, which the sanitizer
      // handles by gating on platform=win32 (ORAIN-0725).
      return detectWindowsFilesystem(realFsutil, devicePath);
    }
  } catch (err) {
    logSyncError(log, 'Filesystem detection error', err);
  }
  return 'unknown';
}

function getTrackSize(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch (_error) {
    return 0;
  }
}

function detectAudioFormat(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp3':
      return 'mp3';
    case '.flac':
      return 'flac';
    case '.m4a':
      return 'm4a';
    case '.aac':
      return 'aac';
    case '.ogg':
      return 'ogg';
    case '.wav':
      return 'wav';
    default:
      return 'unknown';
  }
}

import * as path from 'path';

let isSyncCancelled = false;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let activeSyncCore: import('../sync').SyncCore | null = null;

// ORAIN-0725 / GitHub issue #23: when Windows drive detection fails (e.g.
// because the `fsutil` binary is unavailable in some restricted environment),
// the device-watcher polls every 15 s. Without a dedup, the error log fills
// with one entry per poll — a log-bomb that hides real problems. The flag
// is the mutable state for the `oncePerSession` helper in `windows-fsutil.ts`.
const windowsDriveDetectionState: { logged: boolean } = { logged: false };

// ORAIN-0740 AC4: same once-per-session pattern for the cross-platform
// fallback volume detection (darwin /Volumes, linux mount table, win32 fsutil).
const fallbackVolumeDetectionState: { logged: boolean } = { logged: false };

// Helper to extract server root from a file path
// Example: /mediamusic/lib/lib/4 Strings/Album/track.flac -> /mediamusic/lib/lib/
function extractServerRoot(filePath: string): string {
  // Common server root patterns
  const patterns = ['/mediamusic/', '/music/', '/data/', '/media/'];

  // Find the first occurrence of a known root pattern
  for (const pattern of patterns) {
    const idx = filePath.toLowerCase().indexOf(pattern);
    if (idx !== -1) {
      return filePath.substring(0, idx + pattern.length);
    }
  }

  // Fallback: find the first 2 path segments
  const parts = filePath.split('/');
  if (parts.length >= 3) {
    return '/' + parts[1] + '/' + parts[2] + '/';
  }

  // Last resort: return just the root
  return '/';
}

// Helper to download file from Jellyfin server with retry logic
async function downloadFromJellyfin(
  trackId: string,
  outputPath: string,
  serverUrl: string,
  apiKey: string,
  maxRetries: number = 3,
): Promise<{ success: boolean; error?: string }> {
  const RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff
  // ORAIN-0562: build the auth header once per call (the deviceId is
  // persisted, so the cost is just a file read on first invocation per run).
  const authHeader = buildAuthHeader({
    token: apiKey,
    client: CLIENT_NAME_DEFAULT,
    device: os.hostname() || DEFAULT_DEVICE_NAME,
    deviceId: getOrCreateDeviceId(),
    version: app.getVersion(),
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 min timeout

      const response = await fetch(`${serverUrl}/Items/${trackId}/Download`, {
        headers: {
          Authorization: authHeader,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const statusText = response.statusText || 'Unknown error';
        if (attempt < maxRetries) {
          log.warn(
            `Download attempt ${attempt} failed for track ${trackId}: ${response.status} ${statusText}. Retrying...`,
          );
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt - 1]));
          continue;
        }
        return { success: false, error: `HTTP ${response.status}: ${statusText}` };
      }

      const buffer = await response.arrayBuffer();
      fs.writeFileSync(outputPath, Buffer.from(buffer));
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (attempt < maxRetries) {
        log.warn(
          `Download attempt ${attempt} failed for track ${trackId}: ${errorMsg}. Retrying...`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt - 1]));
      } else {
        log.error(`Download failed after ${maxRetries} attempts for track ${trackId}: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }
    }
  }

  return { success: false, error: 'Max retries exceeded' };
}

async function syncTracks(options: {
  tracks: Array<{ id: string; name: string; path: string; size: number; format: string }>;
  targetPath: string;
  convertToMp3: boolean;
  mp3Bitrate: string;
  serverUrl?: string;
  apiKey?: string;
  onProgress: (progress: {
    current: number;
    total: number;
    currentFile: string;
    status: string;
  }) => void;
}): Promise<{ success: boolean; errors: string[]; syncedFiles: number }> {
  const {
    tracks,
    targetPath,
    convertToMp3: _convertToMp3,
    mp3Bitrate: _mp3Bitrate,
    serverUrl: _serverUrl,
    apiKey: _apiKey,
    onProgress,
  } = options;
  const errors: string[] = [];
  let syncedFiles = 0;
  isSyncCancelled = false;
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
  const total = tracks.length;

  for (let i = 0; i < tracks.length; i++) {
    if (isSyncCancelled) break;
    const track = tracks[i];
    onProgress({ current: i + 1, total, currentFile: track.name, status: 'syncing' });
    try {
      let outputPathFull: string;

      // Use Jellyfin download endpoint if serverUrl is provided
      if (_serverUrl && _apiKey) {
        // Preserve server folder structure - replace server root with target path
        // Example: /mediamusic/lib/lib/4 Strings/Album/track.flac -> /target/lib/lib/4 Strings/Album/track.flac
        const serverRoot = extractServerRoot(track.path);
        const relativePath = track.path.replace(serverRoot, '');
        outputPathFull = join(targetPath, relativePath);

        // Ensure directory exists
        const dir = path.dirname(outputPathFull);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Check if already exists with same size
        if (fs.existsSync(outputPathFull)) {
          const existingStats = fs.statSync(outputPathFull);
          if (existingStats.size === track.size) {
            syncedFiles++;
            log.info(`Skipped (exists): ${track.name}`);
            continue;
          }
        }

        // Download from Jellyfin server
        const downloaded = await downloadFromJellyfin(
          track.id,
          outputPathFull,
          _serverUrl,
          _apiKey,
        );
        if (!downloaded) {
          errors.push(`Failed to download: ${track.name}`);
          continue;
        }
      } else {
        // Fallback to local copy (for testing)
        const outputFileName = path.basename(track.path);
        outputPathFull = join(targetPath, outputFileName);
        if (fs.existsSync(outputPathFull)) {
          const existingStats = fs.statSync(outputPathFull);
          const sourceStats = fs.statSync(track.path);
          if (existingStats.size === sourceStats.size) {
            syncedFiles++;
            continue;
          }
        }
        fs.copyFileSync(track.path, outputPathFull);
      }

      syncedFiles++;
      // ORAIN-0740 cycle 2 (MEDIUM): scrub the destination path. The
      // previous `log.info('Synced: ... -> ${outputPathFull}')` form leaked
      // the user's home directory whenever the destination sat under
      // it (which is the default). Pass through scrubPath so the line
      // becomes `Synced: track.flac -> ~/Music/...` rather than the
      // absolute path.
      log.info(`Synced: ${track.name} -> ${scrubPath(outputPathFull)}`);
    } catch (error) {
      const errorMsg = `Failed to sync "${track.name}": ${error instanceof Error ? error.message : String(error)}`;
      log.error(errorMsg);
      errors.push(errorMsg);
    }
  }
  onProgress({
    current: total,
    total,
    currentFile: '',
    status: isSyncCancelled ? 'cancelled' : 'completed',
  });
  return { success: errors.length === 0 && !isSyncCancelled, errors, syncedFiles };
}

function cancelSync(): void {
  isSyncCancelled = true;
  activeSyncCore?.cancel();
  log.info('Sync cancellation requested');
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // ORAIN-0708: hide the menu bar on Linux too. The native GTK menu bar in
    // the snap build does not follow the system theme, leaving a light menu
    // under a dark titlebar. Parity with the Windows build. DevTools
    // accelerator stays wired via getAppMenuTemplate() below.
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The OS sandbox contains a compromised renderer even if the attacker
      // achieves native code execution (Chromium memory corruption).
      // contextIsolation and nodeIntegration operate inside V8 and do NOT
      // replace this: they only slow down JavaScript-level escapes.
      // Native modules (better-sqlite3, @ffmpeg-installer/ffmpeg) live in
      // the main process, which is never sandboxed — they are not affected.
      // Requires the preload to be bundled: see electron.vite.config.ts.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Platform-specific menu configuration. The template lives in
  // src/main/app-menu.ts (unit-tested); here we just register it.
  // ORAIN-0708: on Linux the menu bar is hidden (autoHideMenuBar above) and
  // the Edit submenu is dropped so the host's GTK stops rendering a visible
  // light menu under a dark titlebar in the snap build.
  const menuTemplate = getAppMenuTemplate(process.platform, app.name, {
    isDev: is.dev,
    onToggleDevTools: () => mainWindow?.webContents.toggleDevTools(),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
    log.info('Window ready');
  });
  mainWindow.webContents.on('did-finish-load', async () => {
    // ORAIN-0591: pass IS_SNAP so the watcher can skip the `usb-detection`
    // native addon (which needs the `hardware-observe` plug) under snap and
    // fall back to polling only.
    if (mainWindow) await startDeviceWatcher(mainWindow, listUsbDevices, IS_SNAP);
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: 'deny' };
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (is.dev && rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// ---------------------------------------------------------------------------
// Encrypted session storage (replaces plaintext localStorage)
//
// ORAIN-0590: the active provider is decided once at startup by the
// selector in `./secure-storage.ts`. On Linux the preferred provider is
// `secret-tool` (libsecret routed through the Secret portal inside the
// snap sandbox); `safeStorage` is the fallback. On macOS/Windows we use
// `safeStorage` directly. When neither works we return
// `encryption_unavailable` — the renderer surfaces a no-persistence
// banner instead of pretending the save succeeded.
// ---------------------------------------------------------------------------
const SESSION_FILE = () => join(app.getPath('userData'), 'session.enc');

/** Active provider — set by `initSecureStorageProvider()` at app boot. */
let sessionStorageProvider: StorageProvider | null = null;

/**
 * Probe secret-tool once and pick the right provider. Safe to call from
 * `app.whenReady()` — it never blocks longer than the runner's own
 * timeout (2s by default), and the result is reused for every IPC call.
 *
 * Exported for the test suite — production code never imports it.
 */
export async function initSecureStorageProvider(): Promise<StorageProvider | null> {
  // ORAIN-0601 AC1: wire the structured logger so every secret-tool
  // failure is recorded (status, stderr classification, parent env)
  // without ever logging the plaintext session from a lookup stdout.
  // ORAIN-0615 AC3: the store gets the logger too, so the `isAvailable()`
  // catch can no longer swallow a failure without leaving a trace.
  const storageLogger = createElectronLogger();
  const secretRunner = createSecretToolRunner({ logger: storageLogger });
  const secretStore = createSecretStore({ runner: secretRunner, logger: storageLogger });
  // Resolve the probe exactly once at startup. The selector is sync, so we
  // wait here and feed the boolean in as `secretToolAvailable` — no
  // mutation of the wrapper, no Object.assign duck-typed patch.
  const secretToolAvailable = await secretStore.isAvailable();
  sessionStorageProvider = createSecureStorageProvider({
    secretStore,
    safeStorage,
    secretToolAvailable,
  });
  if (sessionStorageProvider) {
    log.info(`Session storage: using ${sessionStorageProvider.kind} provider`);
  } else {
    log.warn('Session storage: no provider available — sessions will not persist');
  }
  return sessionStorageProvider;
}

ipcMain.handle('session:save', async (_event, plaintext: string) => {
  // ORAIN-0564 SO-2: extracted to `./session-handlers.ts` for testability.
  // The contract is shape-agnostic — the renderer is responsible for never
  // including the password in `plaintext` (SO-1 strips it). The main
  // process does not log the plaintext.
  return saveSessionHandler({
    provider: sessionStorageProvider,
    filePath: SESSION_FILE(),
    plaintext,
    fs,
    log,
  });
});

ipcMain.handle('session:load', async () => {
  return loadSessionHandler({
    provider: sessionStorageProvider,
    filePath: SESSION_FILE(),
    fs,
    log,
  });
});

ipcMain.handle('session:clear', () => {
  return clearSessionHandler({
    provider: sessionStorageProvider,
    filePath: SESSION_FILE(),
    fs,
    log,
  });
});

// ORAIN-0590: tell the renderer whether an OS-backed encryption provider
// is available, so the login screen can show the no-persistence banner
// before the user has even tried to log in. The probe is cached at boot
// (see initSecureStorageProvider).
ipcMain.handle('app:sessionStorageAvailable', () => sessionStorageProvider !== null);

// ---------------------------------------------------------------------------
// IPC path validation helper — see ./path-validation.ts (extracted ORAIN-0757
// AC6 so the same predicate guards sync:start2 BEFORE mkdirSync runs).
// ---------------------------------------------------------------------------

// Renderer logging — forward renderer-side errors/warnings to the main log file
// Only level and a sanitized message are accepted (no raw objects to avoid leaking PII)
ipcMain.on('log:write', (_event, level: string, message: string) => {
  if (typeof message !== 'string') return;
  const safe = message.slice(0, 500); // hard cap to prevent log flooding
  switch (level) {
    case 'error':
      log.error('[renderer]', safe);
      break;
    case 'warn':
      log.warn('[renderer]', safe);
      break;
    default:
      log.info('[renderer]', safe);
  }
});

// Expose log file path so the user can open/inspect it (transparency)
ipcMain.handle('log:getPath', () => log.transports.file.getFile().path);

// ORAIN-0727: open the system file manager on the current log file. The
// renderer is not allowed to choose the path — main resolves it from
// `electron-log` itself, so a malicious renderer cannot point us at an
// arbitrary file via `shell.showItemInFolder`. Tested in log-folder.test.ts.
ipcMain.handle('log:openFolder', () => {
  try {
    showLogFileInFolder(undefined, () => log.transports.file.getFile().path, shell);
    return { success: true };
  } catch (err) {
    // ORAIN-0740 cycle 2 (MEDIUM): scrub the error so stack/secret paths don't leak.
    logSyncError(log, 'log:openFolder error', err);
    return { success: false, error: String(err) };
  }
});

// Open pre-filled GitHub bug report in the system browser
ipcMain.handle('bug:report', async () => {
  try {
    const logPath = log.transports.file.getFile().path;
    let logContent = '';
    let logMissing = false;
    if (fs.existsSync(logPath)) {
      logContent = fs.readFileSync(logPath, 'utf-8');
    } else {
      logMissing = true;
    }

    // ORAIN-0747 cycle 2 (HIGH): always go through buildBugReportBody so
    // the boilerplate ("Describe the bug", "To Reproduce", OS/version
    // lines, etc.) is present even when the log file has not been
    // written yet (first run, early crash, electron-log not yet
    // initialised). The builder embeds the log-missing notice INSIDE
    // the excerpt so the URL budget is enforced consistently.
    const rawBody = buildBugReportBody(logContent, { logMissing });

    // The builder's boilerplate leaves OS/version as placeholders.
    // Substitute the live values here — the budget reserves 200 chars
    // for them, so the URL ceiling is still respected.
    const body = rawBody
      .replace('<filled by handler>', `${process.platform} ${os.release()}`)
      .replace('<filled by handler>', app.getVersion());

    const url =
      `https://github.com/orainlabs/jellytunes/issues/new?` +
      `labels=${encodeURIComponent('bug')}&` +
      `title=${encodeURIComponent('Bug report')}&` +
      `body=${encodeURIComponent(body)}`;

    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    // ORAIN-0740 cycle 2 (MEDIUM): scrub the error so stack/secret paths don't leak.
    logSyncError(log, 'bug:report error', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('usb:list', async () => {
  try {
    return await listUsbDevices();
  } catch (error) {
    logSyncError(log, 'Error in usb:list handler', error);
    return [];
  }
});
ipcMain.handle('usb:getDeviceInfo', async (_event, devicePath: string) => {
  if (!isValidPath(devicePath)) {
    log.warn(`usb:getDeviceInfo: invalid path ${scrubPath(devicePath)}`);
    return { total: 0, free: 0, used: 0 };
  }
  try {
    return await getDeviceInfo(devicePath);
  } catch (error) {
    logSyncError(log, 'Error getting device info', error);
    return { total: 0, free: 0, used: 0 };
  }
});
ipcMain.handle('usb:getTrackSize', async (_event, trackPath: string) => getTrackSize(trackPath));
ipcMain.handle('usb:getTrackFormat', async (_event, trackPath: string) =>
  detectAudioFormat(trackPath),
);
ipcMain.handle('device:getFilesystem', async (_event, devicePath: string) => {
  if (!isValidPath(devicePath)) {
    log.warn(`device:getFilesystem: invalid path ${scrubPath(devicePath)}`);
    return 'unknown';
  }
  try {
    return await detectFilesystem(devicePath);
  } catch (_e) {
    return 'unknown';
  }
});
ipcMain.handle('sync:start', async (_event, options) => {
  try {
    // ORAIN-0740 cycle 2 (HIGH): scrub the renderer's destination path before
    // it reaches the log. The v2 handler (`sync:start2`) emits only the
    // filesystem type without a path; this v1 handler was missed in cycle 1
    // and still wrote the user's absolute destination verbatim to main.log.
    log.info(
      `Starting sync to ${scrubPath(options.targetPath)} with ${options.tracks.length} tracks`,
    );
    const result = await syncTracks({
      tracks: options.tracks,
      targetPath: options.targetPath,
      convertToMp3: options.convertToMp3,
      mp3Bitrate: options.mp3Bitrate,
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
      onProgress: (progress) => {
        mainWindow?.webContents.send('sync:progress', progress);
      },
    });
    return result;
  } catch (error) {
    // ORAIN-0740 AC5: scrub error before logging.
    logSyncError(log, 'Sync error', error);
    return {
      success: false,
      errors: [error instanceof Error ? error.message : String(error)],
      syncedFiles: 0,
    };
  }
});

// New sync:start2 handler - uses SyncCore for proper path resolution
ipcMain.handle('sync:start2', async (_event, options) => {
  try {
    const {
      serverUrl,
      apiKey,
      userId,
      itemIds,
      itemTypes,
      itemNames = {},
      destinationPath,
      options: syncOptions = {},
    } = options;
    // ORAIN-0740 AC1: [sync-start] is now emitted inside SyncCore AFTER the
    // fetch phase, so the line carries the real `tracks=<post-fetch total>`
    // rather than the placeholder `tracks=itemIds.length`. index.ts still
    // mints the correlation id so the renderer-progress and main.log share
    // the same id (passed via SyncInput.syncId).
    //
    // ORAIN-0740 cycle 2 (LOW): entropy choice — 8 hex chars (32 bits)
    // gives ~4.29B unique ids, while 16 hex chars would give the full
    // 122 bits of a UUIDv4. Why 8? The id is only used to correlate log
    // lines within ONE main.log file for support: at 1 sync/minute the
    // birthday collision probability is negligible (<1e-7/year) and the
    // shorter form is easier to spot visually in main.log. If two syncs
    // somehow coincide within one session, support can disambiguate via
    // the timestamp on `[sync-start]`. The id is NOT a security token.
    const v2SyncId = randomUUID().slice(0, 8);

    // Validate inputs
    if (!serverUrl || !apiKey || !userId) {
      return { success: false, errors: ['Missing serverUrl, apiKey, or userId'], tracksCopied: 0 };
    }

    // Create destination folder if needed — but only after validating
    // the path. ORAIN-0757 AC6: a malformed renderer-supplied path
    // (relative, null byte, or bare drive letter like 'G\' that slipped
    // past the previous regression) used to reach mkdirSync directly,
    // which threw or created a directory at a surprising location.
    if (!isValidPath(destinationPath)) {
      return {
        success: false,
        errors: [`Invalid destinationPath: ${String(destinationPath)}`],
        tracksCopied: 0,
      };
    }
    if (!fs.existsSync(destinationPath)) {
      fs.mkdirSync(destinationPath, { recursive: true });
    }

    // Create SyncCore instance with proper configuration
    const syncCore = createSyncCore(
      {
        serverUrl: serverUrl.replace(/\/$/, ''),
        apiKey,
        userId,
        // serverRootPath will be auto-detected from tracks during sync
      },
      {
        logger: {
          info: (msg) => log.info('[sync]', msg),
          warn: (msg) => log.warn('[sync]', msg),
          error: (msg) => log.error('[sync]', msg),
          debug: (msg) => log.debug('[sync]', msg),
          // ORAIN-0740 AC3 (cycle 2): trackFailed is REQUIRED on SyncLogger.
          // Required so any future block that forgets to wire it fails at
          // type-check (compile error), not at runtime silent-drop.
          trackFailed: (msg) => log.warn(msg),
        },
      },
    );
    activeSyncCore = syncCore;

    // Convert itemTypes to Map if needed
    const itemTypesMap = itemTypes instanceof Map ? itemTypes : new Map(Object.entries(itemTypes));

    // Detect destination filesystem for path sanitization
    const filesystemType = await detectFilesystem(destinationPath);
    log.info(`Destination filesystem: ${filesystemType}`);

    // ORAIN-0740 cycle 2 (HIGH): [sync-start] AND [sync-end] both live
    // inside `syncCore.sync()` now ([start] at line ~576 post-fetch,
    // [end] inside the finally block of sync()). index.ts no longer
    // emits either line — the lifecycle is owned by sync-core, so any
    // unhandled error from a phase still produces a paired [sync-end]
    // line on disk. Without this fix, an unhandled error left
    // [sync-start] as an orphan on disk — support could not tell
    // whether a sync was still running, cancelled, or aborted.

    // Run sync with progress callback that maps to renderer format
    const result = await syncCore.sync(
      {
        itemIds,
        itemTypes: itemTypesMap,
        destinationPath,
        // ORAIN-0740: thread correlation id, app version, and detected
        // filesystem into SyncCore so [sync-start] can be emitted there.
        syncId: v2SyncId,
        appVersion: app.getVersion(),
        destinationFilesystem: filesystemType,
        options: {
          preserveStructure: true,
          skipExisting: true,
          filesystemType,
          ...syncOptions,
          embedMetadata: true, // always embed metadata - never skip tagging
        },
      },
      // Progress callback - map SyncCore format to renderer format
      (progress) => {
        // Map phase to status
        let status: 'syncing' | 'completed' | 'cancelled' = 'syncing';
        if (progress.phase === 'complete') status = 'completed';
        else if (progress.phase === 'cancelled') status = 'cancelled';

        mainWindow?.webContents.send('sync:progress', {
          current: progress.current,
          total: progress.total,
          currentFile: progress.currentTrack ?? '',
          status,
          phase: progress.phase,
          bytesProcessed: progress.bytesProcessed,
          totalBytes: progress.totalBytes,
          warning: progress.warning,
        });
      },
    );

    activeSyncCore = null;

    // Record to SQLite
    const status = result.cancelled ? 'cancelled' : result.success ? 'success' : 'error';
    const syncedIds = itemIds.filter((id: string) => !result.tracksFailed.includes(id));
    const syncedItems = syncedIds.map((id: string) => ({
      id,
      name: (itemNames as Record<string, string>)[id] ?? id,
      type:
        (itemTypes as Record<string, 'artist' | 'album' | 'playlist' | 'albumArtist'>)[id] ??
        'artist',
    }));
    try {
      recordSyncCompleted(
        destinationPath,
        result.tracksCopied,
        result.totalSizeBytes ?? 0,
        status,
        syncedItems,
      );
    } catch (dbErr) {
      log.warn('Failed to record sync history:', dbErr);
    }

    // AC-5: Invalidate cache entries for synced itemIds after successful sync.
    // Ensures next analyzeDiff sees fresh data from Jellyfin.
    if (result.success && itemIds.length > 0) {
      _invalidateTrackCache(serverUrl.replace(/\/$/, ''), userId, itemIds);
    }

    return {
      success: result.success,
      tracksCopied: result.tracksCopied,
      tracksSkipped: result.tracksSkipped,
      tracksRetagged: result.tracksRetagged,
      lyricsAdded: result.lyricsAdded,
      tracksFailed: result.tracksFailed,
      errors: result.errors,
      totalSizeBytes: result.totalSizeBytes,
    };
  } catch (error) {
    // ORAIN-0740 AC5: never pass the error object — only its message.
    logSyncError(log, 'Sync v2 error', error);
    return {
      success: false,
      errors: [
        {
          trackName: '',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      tracksCopied: 0,
    };
  }
});

// AC-4: analyzeDiff uses same cache instance — pre-load tracks before calling analyzeDiff
ipcMain.handle(
  'sync:analyzeDiff',
  async (
    _event,
    options: {
      serverUrl: string;
      apiKey: string;
      userId: string;
      itemIds: string[];
      itemTypes: Record<string, 'artist' | 'album' | 'playlist' | 'albumArtist' | 'genre'>;
      destinationPath: string;
      options: {
        coverArtMode: CoverArtMode;
        bitrate: '128k' | '192k' | '320k';
        convertToMp3: boolean;
      };
    },
  ) => {
    try {
      const {
        serverUrl,
        apiKey,
        userId,
        itemIds,
        itemTypes,
        destinationPath,
        options: diffOptions,
      } = options;
      const normalizedUrl = serverUrl.replace(/\/$/, '');

      // AC-4: Pre-load tracks from cache for all itemIds
      const preloadedTracks = new Map<string, TrackInfo[]>();
      const cacheMisses: string[] = [];

      for (const itemId of itemIds) {
        const cacheKey = _buildTrackCacheKey(
          normalizedUrl,
          userId,
          itemTypes[itemId] ?? 'album',
          itemId,
        );
        const cached = _getFromTrackCache(cacheKey);
        if (cached) {
          preloadedTracks.set(itemId, cached);
        } else {
          cacheMisses.push(itemId);
        }
      }

      // Fetch cache misses from Jellyfin and store in cache
      if (cacheMisses.length > 0) {
        const api = createMainApiClient({
          baseUrl: normalizedUrl,
          apiKey,
          userId,
          logger: {
            info: (msg) => log.info('[batch]', msg),
            warn: (msg) => log.warn('[batch]', msg),
            error: (msg) => log.error('[batch]', msg),
            debug: (msg) => log.debug('[batch]', msg),
            // ORAIN-0740 AC3 (cycle 2): trackFailed is REQUIRED on SyncLogger.
            trackFailed: (msg) => log.warn(msg),
          },
        });
        const cacheMissTypesMap = new Map(
          cacheMisses.map((id) => [id, itemTypes[id] ?? 'album']),
        ) as Map<string, 'artist' | 'album' | 'playlist' | 'albumArtist' | 'genre'>;
        const { tracks: fetchedTracks } = await api.getTracksForItems(
          cacheMisses,
          cacheMissTypesMap,
        );

        // Store in cache and add to preloadedTracks
        const tracksByItem = new Map<string, TrackInfo[]>();
        for (const track of fetchedTracks) {
          const parentId = track.parentItemId ?? '';
          if (!tracksByItem.has(parentId)) tracksByItem.set(parentId, []);
          tracksByItem.get(parentId)!.push(track);
        }
        for (const [itemId, tracks] of tracksByItem) {
          const cacheKey = _buildTrackCacheKey(
            normalizedUrl,
            userId,
            itemTypes[itemId] ?? 'album',
            itemId,
          );
          _setInTrackCache(cacheKey, tracks);
          preloadedTracks.set(itemId, tracks);
        }
      }

      const syncCore = createSyncCore(
        { serverUrl: normalizedUrl, apiKey, userId },
        {
          logger: {
            info: (msg) => log.info('[batch]', msg),
            warn: (msg) => log.warn('[batch]', msg),
            error: (msg) => log.error('[batch]', msg),
            debug: (msg) => log.debug('[batch]', msg),
            // ORAIN-0740 AC3 (cycle 2): trackFailed is REQUIRED on SyncLogger.
            trackFailed: (msg) => log.warn(msg),
          },
        },
      );
      const itemTypesMap = new Map(Object.entries(itemTypes));
      // ORAIN-0705 AC3: pass the real fs so the Sync Preview gates on actual
      // on-disk presence. Without this, a formatted / wiped / swapped device
      // would report 0 new tracks even though the sync itself would correctly
      // re-download them.
      const fsForPreview = createNodeFileSystem();
      const result = await syncCore.analyzeDiff(
        itemIds,
        itemTypesMap,
        destinationPath,
        diffOptions,
        preloadedTracks,
        fsForPreview,
      );
      return { success: true, ...result };
    } catch (error) {
      logSyncError(log, 'sync:analyzeDiff error', error);
      return {
        success: false,
        items: [],
        totals: { newTracks: 0, metadataChanged: 0, removed: 0, pathChanged: 0, unchanged: 0 },
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  },
);
ipcMain.handle('sync:cancel', () => {
  cancelSync();
  return { cancelled: true };
});
ipcMain.handle('app:version', () => app.getVersion());
// ORAIN-0562: persistent per-installation DeviceId for the Jellyfin
// Authorization header. Stable across launches so the server doesn't see a new
// "device" on every boot of the app.
ipcMain.handle('app:getDeviceId', () => getOrCreateDeviceId());
ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select sync destination folder',
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('fs:getFolderStats', async (_event, folderPath: string) => {
  if (!isValidPath(folderPath)) return { exists: false, error: 'Invalid path' };
  try {
    const stats = fs.statSync(folderPath);
    return {
      exists: true,
      isDirectory: stats.isDirectory(),
      size: stats.size,
      modified: stats.mtime.toISOString(),
    };
  } catch (error) {
    return { exists: false, error: String(error) };
  }
});
ipcMain.handle('ffmpeg:isAvailable', async () => {
  try {
    const { spawnSync } = require('child_process');
    const check = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
    if (check.error || check.status !== 0) throw new Error('ffmpeg not found');
    return true;
  } catch {
    try {
      require('@ffmpeg-installer/ffmpeg');
      return true;
    } catch {
      return false;
    }
  }
});

// ─── TrackRegistry IPCs ───────────────────────────────────────────────────────
// Get synced tracks for a device from DB (used by useTrackRegistry)
ipcMain.handle('sync:getSyncedTracks', (_event, mountPoint: string) => {
  try {
    return getSyncedTracksForDevice(mountPoint);
  } catch (error) {
    logSyncError(log, 'sync:getSyncedTracks error', error);
    return [];
  }
});

// Get tracks for an item from Jellyfin (lazy loading for useTrackRegistry)
ipcMain.handle(
  'sync:getTracksForItem',
  async (
    _event,
    options: {
      serverUrl: string;
      apiKey: string;
      userId: string;
      itemId: string;
      itemType: 'artist' | 'album' | 'playlist' | 'albumArtist';
    },
  ) => {
    try {
      const { serverUrl, apiKey, userId, itemId, itemType } = options;
      const api = createMainApiClient({
        baseUrl: serverUrl.replace(/\/$/, ''),
        apiKey,
        userId,
        logger: {
          info: (msg) => log.info('[batch]', msg),
          warn: (msg) => log.warn('[batch]', msg),
          error: (msg) => log.error('[batch]', msg),
          debug: (msg) => log.debug('[batch]', msg),
          // ORAIN-0740 AC3 (cycle 2): trackFailed is REQUIRED on SyncLogger.
          trackFailed: (msg) => log.warn(msg),
        },
      });
      const itemTypesMap = new Map([[itemId, itemType]]);
      const { tracks, errors } = await api.getTracksForItems([itemId], itemTypesMap);
      return { tracks, errors };
    } catch (error) {
      logSyncError(log, 'sync:getTracksForItem error', error);
      return { tracks: [], errors: [error instanceof Error ? error.message : String(error)] };
    }
  },
);

// Get tracks for multiple items from Jellyfin (batch fetch for background refresh)
// AC-3: Uses shared _trackCache — cache hit returns immediately, cache miss fetches and stores
ipcMain.handle(
  'sync:getTracksForItems',
  async (
    _event,
    options: {
      serverUrl: string;
      apiKey: string;
      userId: string;
      itemIds: string[];
      itemTypes: Record<string, 'artist' | 'album' | 'playlist' | 'albumArtist' | 'genre'>;
    },
  ) => {
    try {
      const { serverUrl, apiKey, userId, itemIds, itemTypes } = options;
      const normalizedUrl = serverUrl.replace(/\/$/, '');
      const itemTypesMap = new Map(Object.entries(itemTypes)) as Map<
        string,
        'artist' | 'album' | 'playlist' | 'albumArtist' | 'genre'
      >;

      // Check cache for each itemId; collect cache misses
      const cachedResults: TrackInfo[] = [];
      const cacheMisses: string[] = [];

      for (const itemId of itemIds) {
        const cacheKey = _buildTrackCacheKey(
          normalizedUrl,
          userId,
          itemTypesMap.get(itemId) ?? 'album',
          itemId,
        );
        const cached = _getFromTrackCache(cacheKey);
        if (cached) {
          // Mark parentItemId so tracks are correctly grouped in results
          cachedResults.push(...cached.map((t) => ({ ...t, parentItemId: itemId })));
        } else {
          cacheMisses.push(itemId);
        }
      }

      // Fetch cache misses from Jellyfin and store in cache
      if (cacheMisses.length > 0) {
        const api = createMainApiClient({
          baseUrl: normalizedUrl,
          apiKey,
          userId,
          logger: {
            info: (msg) => log.info('[batch]', msg),
            warn: (msg) => log.warn('[batch]', msg),
            error: (msg) => log.error('[batch]', msg),
            debug: (msg) => log.debug('[batch]', msg),
            // ORAIN-0740 AC3 (cycle 2): trackFailed is REQUIRED on SyncLogger.
            trackFailed: (msg) => log.warn(msg),
          },
        });

        const cacheMissTypesMap = new Map(
          cacheMisses.map((id) => [id, itemTypesMap.get(id) ?? 'album']),
        ) as Map<string, 'artist' | 'album' | 'playlist' | 'albumArtist' | 'genre'>;
        const { tracks: fetchedTracks, errors } = await api.getTracksForItems(
          cacheMisses,
          cacheMissTypesMap,
        );

        // Store fetched tracks in cache (grouped by itemId)
        const tracksByItem = new Map<string, TrackInfo[]>();
        for (const track of fetchedTracks) {
          const parentId = track.parentItemId ?? '';
          if (!tracksByItem.has(parentId)) tracksByItem.set(parentId, []);
          tracksByItem.get(parentId)!.push(track);
        }
        for (const [itemId, tracks] of tracksByItem) {
          const cacheKey = _buildTrackCacheKey(
            normalizedUrl,
            userId,
            itemTypesMap.get(itemId) ?? 'album',
            itemId,
          );
          _setInTrackCache(cacheKey, tracks);
        }
        // Cache empty result for items with 0 tracks to prevent repeated fetches
        for (const itemId of cacheMisses) {
          if (!tracksByItem.has(itemId)) {
            _setInTrackCache(
              _buildTrackCacheKey(
                normalizedUrl,
                userId,
                itemTypesMap.get(itemId) ?? 'album',
                itemId,
              ),
              [],
            );
          }
        }

        // Merge cached + fetched results
        cachedResults.push(...fetchedTracks);
        return { tracks: cachedResults, errors };
      }

      return { tracks: cachedResults, errors: [] };
    } catch (error) {
      logSyncError(log, 'sync:getTracksForItems error', error);
      return { tracks: [], errors: [error instanceof Error ? error.message : String(error)] };
    }
  },
);

// ─── Sync history (SQLite) ─────────────────────────────────────────────────
ipcMain.handle('sync:getDeviceInfo', (_event, mountPoint: string) => {
  try {
    return getDeviceSyncInfo(mountPoint);
  } catch (error) {
    logSyncError(log, 'getDeviceInfo error', error);
    return null;
  }
});
ipcMain.handle('sync:getHistory', () => {
  try {
    return getRecentSyncHistory(20);
  } catch (error) {
    logSyncError(log, 'getHistory error', error);
    return [];
  }
});
ipcMain.handle('sync:getSyncedItems', (_event, mountPoint: string) => {
  try {
    return getSyncedItems(mountPoint);
  } catch (error) {
    logSyncError(log, 'getSyncedItems error', error);
    return [];
  }
});

// ─── Remove items from destination ──────────────────────────────────────────
ipcMain.handle(
  'sync:removeItems',
  async (
    _event,
    options: {
      serverUrl: string;
      apiKey: string;
      userId: string;
      itemIds: string[];
      itemTypes: Record<string, 'artist' | 'album' | 'playlist' | 'albumArtist'>;
      destinationPath: string;
    },
  ) => {
    try {
      const { serverUrl, apiKey, userId, itemIds, itemTypes, destinationPath } = options;
      log.info(`Removing ${itemIds.length} items from ${destinationPath}`);
      const core = createSyncCore(
        { serverUrl: serverUrl.replace(/\/$/, ''), apiKey, userId },
        {
          logger: {
            info: (m) => log.info('[sync]', m),
            warn: (m) => log.warn('[sync]', m),
            error: (m) => log.error('[sync]', m),
            debug: (m) => log.debug('[sync]', m),
            // ORAIN-0740 AC3 (cycle 2): trackFailed is REQUIRED on SyncLogger.
            trackFailed: (m) => log.warn(m),
          },
        },
      );
      const itemTypesMap = new Map(Object.entries(itemTypes)) as Map<
        string,
        'artist' | 'album' | 'playlist' | 'albumArtist'
      >;
      const result = await core.removeItems(itemIds, itemTypesMap, destinationPath);
      log.info(`Removed ${result.removed} tracks, ${result.errors.length} errors`);
      // Remove from SQLite tracking
      try {
        removeSyncedItems(destinationPath, itemIds);
      } catch (dbErr) {
        log.warn('Failed to remove synced items from db:', dbErr);
      }
      return result;
    } catch (error) {
      logSyncError(log, 'removeItems error', error);
      return { removed: 0, errors: [error instanceof Error ? error.message : String(error)] };
    }
  },
);

// Clear all synced items and optionally delete files for a destination
ipcMain.handle(
  'sync:clearDestination',
  async (
    _event,
    options: {
      serverUrl: string;
      apiKey: string;
      userId: string;
      destinationPath: string;
    },
  ) => {
    const { serverUrl, apiKey, userId, destinationPath } = options;
    try {
      const core = createSyncCore(
        { serverUrl: serverUrl.replace(/\/$/, ''), apiKey, userId },
        {
          logger: {
            info: (m) => log.info('[sync]', m),
            warn: (m) => log.warn('[sync]', m),
            error: (m) => log.error('[sync]', m),
            debug: (m) => log.debug('[sync]', m),
            // ORAIN-0740 AC3 (cycle 2): trackFailed is REQUIRED on SyncLogger.
            trackFailed: (m) => log.warn(m),
          },
        },
      );
      const syncedItems = getSyncedItems(destinationPath);
      if (syncedItems.length === 0) {
        clearDestinationRecords(destinationPath);
        return { deleted: 0, errors: [] };
      }
      const allIds = syncedItems.map((i) => i.id);
      const itemTypesMap = new Map(syncedItems.map((i) => [i.id, i.type])) as Map<
        string,
        'artist' | 'album' | 'playlist' | 'albumArtist'
      >;
      const result = await core.removeItems(allIds, itemTypesMap, destinationPath);
      log.info(`clearDestination: removed ${result.removed} files, ${result.errors.length} errors`);
      clearDestinationRecords(destinationPath);
      return { deleted: result.removed, errors: result.errors };
    } catch (error) {
      logSyncError(log, 'clearDestination error', error);
      return { deleted: 0, errors: [error instanceof Error ? error.message : String(error)] };
    }
  },
);

// Update checker — queries analytics worker at most once per 24h
// ORAIN-0573: under snap, we still ping the worker (for anonymous stats)
// but force `updateAvailable` to false so the renderer hides the banner.
const UPDATE_CHECKER_URL = 'https://api.orainlabs.dev/jellytunes/updates/latest';
let lastUpdateCheck = 0;
let cachedUpdateInfo: UpdateCheckResult | null = null;

async function performUpdateCheck(force = false): Promise<UpdateCheckResult> {
  // Skip update checks in development builds (VITE_DEV_BUILD or unpackaged) to avoid contaminating stats
  const isDevBuild = !app.isPackaged || process.env.VITE_DEV_BUILD === 'true';
  if (isDevBuild) {
    log.info('Update check skipped in development mode');
    return {
      updateAvailable: false,
      latestVersion: app.getVersion(),
      releaseUrl: '',
      managedBySnap: IS_SNAP,
    };
  }
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  if (!force && cachedUpdateInfo && now - lastUpdateCheck < ONE_DAY_MS) return cachedUpdateInfo;
  try {
    const { net } = await import('electron');
    const { analyticsEnabled } = getPreferences();
    const request = net.fetch(UPDATE_CHECKER_URL, {
      headers: {
        'User-Agent': `JellyTunes/${app.getVersion()} (${process.platform}; ${process.arch})${IS_SNAP ? ' (snap)' : ''}`,
        'Accept': 'application/vnd.github+json',
        ...(analyticsEnabled ? {} : { 'X-JT-Analytics-Opt-Out': '1' }),
      },
    });
    const data = (await (await request).json()) as { tag_name?: string; html_url?: string };
    const latestVersion = (data.tag_name ?? '').replace(/^v/, '');
    const currentVersion = app.getVersion();
    const result = buildUpdateCheckResult(
      { latestVersion, releaseUrl: data.html_url ?? '', currentVersion },
      IS_SNAP,
    );
    cachedUpdateInfo = result;
    lastUpdateCheck = now;
    return result;
  } catch {
    return { updateAvailable: false, latestVersion: '', releaseUrl: '', managedBySnap: IS_SNAP };
  }
}

// Preferences IPC handlers
ipcMain.handle('prefs:get', () => getPreferences());
ipcMain.handle('prefs:set', (_event, partial: { analyticsEnabled?: boolean }) => {
  setPreferences(partial);
});

ipcMain.handle('app:checkForUpdates', (_event, force = false) => performUpdateCheck(force));

// ORAIN-0573: expose snap detection so the renderer can swap UI surfaces
// (e.g. show "Managed via Snap Store" instead of a manual update button).
ipcMain.handle('app:isSnap', () => IS_SNAP);

// ORAIN-0578: run the three permission probes and return the user-facing
// report. Outside snap, the gate inside `buildSnapPermissionsReport`
// returns an empty report — no snap-specific UI should ever surface.
ipcMain.handle('snap:checkPermissions', (): SnapPermissionsReport => {
  if (!IS_SNAP) {
    return { isSnap: false, snapName: null, interfaces: [] };
  }
  const probes = runSnapPermissionProbes();
  return buildSnapPermissionsReport({
    isSnap: true,
    snapName: snapEnv.snapName,
    probes,
  });
});

void app.whenReady().then(() => {
  log.info('App ready');
  if (IS_SNAP) {
    log.info(
      `Running under snap: ${snapEnv.snapName} (${snapEnv.snapPath}) — update banner suppressed`,
    );
  }
  void initDatabase();
  electronApp.setAppUserModelId('com.jellytunes.app');
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });
  // Probe secret-tool once at boot and pick the active session-storage
  // provider. Non-blocking — the IPC handlers fall back gracefully if the
  // probe is still in flight when the user logs in.
  void initSecureStorageProvider();
  createWindow();
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Fire update check every 24h even if app stays open for days
  setInterval(
    () => {
      void performUpdateCheck(true);
    },
    24 * 60 * 60 * 1000,
  );
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
app.on('before-quit', () => {
  stopDeviceWatcher();
});
log.info('Main process initialized');
