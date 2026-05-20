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

// Polling backup state (runs alongside usb-detection to detect mount/unmount without disconnect)
const POLL_INTERVAL_MS = 15000;
let pollPreviousPaths = new Set<string>();
let lastUsbDetectionEventMs = 0;
const USB_DETECTION_COOLDOWN_MS = 5000; // polling waits 5s after usb-detection event before emitting

const MAX_ATTACH_RETRIES = 60;
const ATTACH_RETRY_INTERVAL_MS = 500;

// Lazy-loaded usb-detection — may fail to load if Electron ABI doesn't match prebuilt
type UsbDetection = typeof import('usb-detection');
let usbDetection: UsbDetection | null = null;

async function tryLoadUsbDetection(): Promise<boolean> {
  try {
    const mod = await import('usb-detection');
    // usb-detection is a CJS module (module.exports = detector).
    // In Electron's main process, dynamic import() wraps it as { default: detector },
    // so startMonitoring lives on .default. In test mocks it lives directly on mod.
    const detection: UsbDetection = (
      typeof mod.startMonitoring === 'function' ? mod : (mod as any).default
    ) as UsbDetection;
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
): Promise<void> {
  // Guard against double-start
  if (monitoringActive) stopDeviceWatcher();

  monitoringActive = true;

  const loaded = await tryLoadUsbDetection();

  if (loaded && usbDetection) {
    // Start event-based watcher (primary) + polling backup (secondary)
    await startEventBasedWatcher(win, listUsbDevices);
    startPollingBackupWatcher(win, listUsbDevices);
  } else {
    // Fallback: polling as primary method
    startFallbackPollingWatcher(win, listUsbDevices);
  }
}

async function startEventBasedWatcher(
  win: BrowserWindowLike,
  listUsbDevices: () => Promise<UsbDevice[]>,
): Promise<void> {
  if (!usbDetection) return;

  log.info('USB device watcher: starting event-based mode');

  // Seed: capture current mountpoints so devices already present at startup
  // don't generate spurious usb:attach events
  const seed = await listUsbDevices();
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
): void {
  log.warn('USB device watcher: starting in polling fallback mode (2s interval)');
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
    }, 2000);
  });
}

export function stopDeviceWatcher(): void {
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
