import { log } from './logger';

interface UsbDevice {
  device: string;
  displayName: string;
  size: number;
  mountpoints: Array<{ path: string }>;
  isRemovable: boolean;
  vendorName?: string;
  serialNumber?: string;
}

interface BrowserWindowLike {
  webContents: {
    send: (channel: string) => void;
  };
}

// State
let monitoringActive = false;
let fallbackIntervalId: ReturnType<typeof setInterval> | null = null;
let backupPollIntervalId: ReturnType<typeof setInterval> | null = null;
let addDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let addRetryIntervalId: ReturnType<typeof setInterval> | null = null;
let addRetryCount = 0;
let initialMountpointPaths = new Set<string>();

// ORAIN-0761 AC6: generation counter for the race between the asynchronous
// start path (`startDeviceWatcher`) and a concurrent `stopDeviceWatcher` or
// a second `startDeviceWatcher`. The entry path awaits before reaching the
// `usbDetection.startMonitoring()` / `usbDetection.on('add', ...)` calls;
// during that await, another call can either stop monitoring or replace it.
// Without a generation check, the original caller resumes and calls
// `startMonitoring()` on a stale `usbDetection` reference, or registers a
// second pair of listeners on top of the ones the new start installed.
//
// Each `startDeviceWatcher` captures its generation at entry and checks
// after every await that the counter still equals what it captured.
// `stopDeviceWatcher` also bumps it so a stop during the gap cancels the
// in-flight start without affecting the new generation.
let watcherGeneration = 0;

// Polling backup state (runs alongside usb-detection to detect mount/unmount without disconnect)
const POLL_INTERVAL_MS = 15000;
// ORAIN-0591: longer polling interval under snap — the `usb-detection` native
// addon is skipped there (it would just fail without `hardware-observe`), so
// this loop becomes the primary and only detection method. 4s trades a few
// hundred ms of attach latency for noticeably less CPU/battery on a
// confined runtime that is otherwise starved of resources.
const SNAP_POLL_INTERVAL_MS = 4000;
let pollPreviousPaths = new Set<string>();
let lastUsbDetectionEventMs = 0;
const USB_DETECTION_COOLDOWN_MS = 5000; // polling waits 5s after usb-detection event before emitting

const MAX_ATTACH_RETRIES = 60;
const ATTACH_RETRY_INTERVAL_MS = 500;

// Lazy-loaded usb-detection — may fail to load if Electron ABI doesn't match prebuilt
interface UsbDetection {
  startMonitoring: () => void;
  stopMonitoring: () => void;
  on: (event: string, callback: (device: { device: string; deviceName: string }) => void) => void;
  findAll: () => Promise<Array<{ device: string }>>;
}
let usbDetection: UsbDetection | null = null;

async function tryLoadUsbDetection(): Promise<boolean> {
  try {
    const mod = await import('usb-detection');
    // usb-detection is a CJS module (module.exports = detector).
    // In Electron's main process, dynamic import() wraps it as { default: detector },
    // so startMonitoring lives on .default. In test mocks it lives directly on mod.
    const hasDirectApi = typeof mod.startMonitoring === 'function';
    const detection: UsbDetection = hasDirectApi
      ? (mod as unknown as UsbDetection)
      : (mod as unknown as { default: UsbDetection }).default;
    if (typeof detection.startMonitoring !== 'function' || typeof detection.on !== 'function') {
      log.warn(
        'usb-detection loaded but API is invalid (possible ABI mismatch with Electron), falling back to polling',
      );
      return false;
    }
    usbDetection = detection;
    return true;
  } catch (err) {
    log.warn('usb-detection native addon failed to load, falling back to polling:', err);
    return false;
  }
}

export async function startDeviceWatcher(
  win: BrowserWindowLike,
  listUsbDevices: () => Promise<UsbDevice[]>,
  isSnap: boolean,
): Promise<void> {
  // Guard against double-start
  if (monitoringActive) stopDeviceWatcher();

  // ORAIN-0761 AC6: bump the generation at entry. Capture the value we
  // own so the post-await check below can detect a stop / restart that
  // happened while we were suspended.
  const myGeneration = ++watcherGeneration;

  monitoringActive = true;

  // ORAIN-0591: under snap, the `usb-detection` native addon is skipped
  // entirely. It would only work through the `hardware-observe` plug (which
  // we no longer declare), and the addon itself has a history of ABI
  // mismatches with Electron (`device-watcher.ts:tryLoadUsbDetection`). The
  // fallback polling watcher already covers attach/detach and mount/unmount
  // via complete-path comparison, so we promote it to the only mode.
  if (isSnap) {
    log.info(
      'USB device watcher: snap runtime — using polling only (hardware-observe not requested)',
    );
    startFallbackPollingWatcher(win, listUsbDevices, SNAP_POLL_INTERVAL_MS);
    return;
  }

  const loaded = await tryLoadUsbDetection();

  // AC6: a stop / second start during the await above invalidates this
  // call. Bail out before touching `usbDetection` again so we don't call
  // startMonitoring on a stale reference or register listeners twice.
  if (myGeneration !== watcherGeneration) {
    return;
  }

  if (loaded && usbDetection) {
    // Start event-based watcher (primary) + polling backup (secondary)
    await startEventBasedWatcher(win, listUsbDevices, myGeneration);
    // Same generation check after the second await — `startEventBasedWatcher`
    // is responsible for its own internal check; if it bailed out, this one
    // catches a stop that came *between* it and the polling backup start.
    if (myGeneration !== watcherGeneration) {
      return;
    }
    startPollingBackupWatcher(win, listUsbDevices);
  } else {
    // Fallback: polling as primary method
    startFallbackPollingWatcher(win, listUsbDevices, 2000);
  }
}

async function startEventBasedWatcher(
  win: BrowserWindowLike,
  listUsbDevices: () => Promise<UsbDevice[]>,
  myGeneration: number,
): Promise<void> {
  if (!usbDetection) return;

  log.info('USB device watcher: starting event-based mode');

  // Seed: capture current mountpoints so devices already present at startup
  // don't generate spurious usb:attach events
  const seed = await listUsbDevices();

  // ORAIN-0761 AC6: a stop / second start during the seed await cancels
  // this generation. Refuse to call `startMonitoring` on the stale
  // `usbDetection` reference — the new generation owns it now.
  if (myGeneration !== watcherGeneration) {
    return;
  }

  initialMountpointPaths = new Set(seed.flatMap((d) => d.mountpoints.map((mp) => mp.path)));

  usbDetection.startMonitoring();

  async function checkAndEmitAttach(
    win: BrowserWindowLike,
    listUsb: () => Promise<UsbDevice[]>,
  ): Promise<boolean> {
    try {
      const current = await listUsb();
      const currentPaths = new Set(current.flatMap((d) => d.mountpoints.map((mp) => mp.path)));
      const newPaths = [...currentPaths].filter((p) => !initialMountpointPaths.has(p));
      if (newPaths.length > 0) {
        win.webContents.send('usb:attach');
        newPaths.forEach((p) => initialMountpointPaths.add(p));
        return true;
      }
    } catch {
      // silent
    }
    return false;
  }

  function clearAttachRetry(): void {
    if (addRetryIntervalId !== null) {
      clearInterval(addRetryIntervalId);
      addRetryIntervalId = null;
    }
    addRetryCount = 0;
  }

  // debounce 300ms: IOKit fires 'add' before the volume is fully mounted.
  // Waiting lets the filesystem settle so listUsbDevices returns the new path.
  // If volume isn't mounted after the debounce, retry every 500ms × 5 (2.5s window).
  usbDetection.on('add', () => {
    lastUsbDetectionEventMs = Date.now();
    if (addDebounceTimer !== null) clearTimeout(addDebounceTimer);
    clearAttachRetry();
    addDebounceTimer = setTimeout(async () => {
      addDebounceTimer = null;
      const found = await checkAndEmitAttach(win, listUsbDevices);
      if (!found) {
        // Volume not mounted yet — start retry loop
        addRetryCount = 0;
        addRetryIntervalId = setInterval(async () => {
          addRetryCount++;
          const retryFound = await checkAndEmitAttach(win, listUsbDevices);
          if (retryFound || addRetryCount >= MAX_ATTACH_RETRIES) {
            clearAttachRetry();
          }
        }, ATTACH_RETRY_INTERVAL_MS);
      }
    }, 300);
  });

  // remove: emit detach immediately, then sync initialMountpointPaths so the same
  // device is detected again if re-inserted (without this, the stale path stays in
  // initialMountpointPaths and checkAndEmitAttach never fires usb:attach again).
  usbDetection.on('remove', async () => {
    lastUsbDetectionEventMs = Date.now();
    win.webContents.send('usb:detach');
    try {
      const current = await listUsbDevices();
      const currentPaths = new Set(current.flatMap((d) => d.mountpoints.map((mp) => mp.path)));
      for (const p of [...initialMountpointPaths]) {
        if (!currentPaths.has(p)) initialMountpointPaths.delete(p);
      }
    } catch {
      /* silent */
    }
  });

  log.info(
    'USB device watcher: event-based mode active (debounce=300ms, retry=500ms×60, total=30s)',
  );
}

/**
 * Polling backup watcher - runs alongside usb-detection to detect mount/unmount
 * without physical disconnect. This catches cases where user unmounts volume from
 * Finder (macOS) or eject dialog (Windows) without unplugging the device.
 * Uses 15s interval with 5s cooldown after usb-detection events to avoid duplicates.
 */
function startPollingBackupWatcher(
  win: BrowserWindowLike,
  listUsbDevices: () => Promise<UsbDevice[]>,
): void {
  log.info('USB device watcher: starting polling backup mode (15s interval, 5s cooldown)');

  // Initialize with empty set - first poll will seed the state without emitting
  pollPreviousPaths = new Set();

  backupPollIntervalId = setInterval(async () => {
    try {
      const now = Date.now();

      // Skip if usb-detection event was recent (deduplication)
      if (now - lastUsbDetectionEventMs < USB_DETECTION_COOLDOWN_MS) {
        return;
      }

      const current = await listUsbDevices();
      const currentPaths = new Set(current.flatMap((d) => d.mountpoints.map((mp) => mp.path)));

      // Skip if this is the first poll (seeding)
      if (pollPreviousPaths.size === 0) {
        pollPreviousPaths = currentPaths;
        return;
      }

      const newPaths = [...currentPaths].filter((p) => !pollPreviousPaths.has(p));
      const removedPaths = [...pollPreviousPaths].filter((p) => !currentPaths.has(p));

      // Only emit if actual change detected (not just device reconnect)
      if (newPaths.length > 0) {
        log.info(`Polling backup: detected new mountpoints: ${newPaths.join(', ')}`);
        win.webContents.send('usb:attach');
      }

      if (removedPaths.length > 0) {
        log.info(`Polling backup: detected removed mountpoints: ${removedPaths.join(', ')}`);
        win.webContents.send('usb:detach');
      }

      pollPreviousPaths = currentPaths;
    } catch {
      // silent
    }
  }, POLL_INTERVAL_MS);
}

function startFallbackPollingWatcher(
  win: BrowserWindowLike,
  listUsbDevices: () => Promise<UsbDevice[]>,
  intervalMs: number,
): void {
  log.warn(`USB device watcher: starting in polling fallback mode (${intervalMs}ms interval)`);
  monitoringActive = true;

  let previousPaths = new Set<string>();

  // JELLY-0009 Issue #2 fix: start interval INSIDE .then() of seed
  // so the first tick has previousPaths already set (no spurious attach).
  void listUsbDevices().then((devices) => {
    previousPaths = new Set(devices.flatMap((d) => d.mountpoints.map((mp) => mp.path)));
    fallbackIntervalId = setInterval(async () => {
      try {
        const current = await listUsbDevices();
        const currentPaths = new Set(current.flatMap((d) => d.mountpoints.map((mp) => mp.path)));
        const attached = [...currentPaths].some((p) => !previousPaths.has(p));
        const detached = [...previousPaths].some((p) => !currentPaths.has(p));
        if (attached) win.webContents.send('usb:attach');
        if (detached) win.webContents.send('usb:detach');
        previousPaths = currentPaths;
      } catch {
        // silent
      }
    }, intervalMs);
  });
}

export function stopDeviceWatcher(): void {
  // ORAIN-0761 AC6: bump the generation so any in-flight `startDeviceWatcher`
  // that is suspended on an await (loadUsbDetection, listUsbDevices) bails
  // out before calling startMonitoring / registering listeners on the
  // watcher we are tearing down.
  watcherGeneration += 1;

  if (addDebounceTimer !== null) {
    clearTimeout(addDebounceTimer);
    addDebounceTimer = null;
  }

  if (addRetryIntervalId !== null) {
    clearInterval(addRetryIntervalId);
    addRetryIntervalId = null;
  }
  addRetryCount = 0;

  if (usbDetection && monitoringActive) {
    try {
      usbDetection.stopMonitoring();
    } catch (err) {
      log.warn('usb-detection.stopMonitoring() threw:', err);
    }
    usbDetection = null;
  }

  if (fallbackIntervalId !== null) {
    clearInterval(fallbackIntervalId);
    fallbackIntervalId = null;
  }

  if (backupPollIntervalId !== null) {
    clearInterval(backupPollIntervalId);
    backupPollIntervalId = null;
  }

  initialMountpointPaths.clear();
  pollPreviousPaths.clear();
  lastUsbDetectionEventMs = 0;
  monitoringActive = false;
  log.info('USB device watcher stopped');
}
