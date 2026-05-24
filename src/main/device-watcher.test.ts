import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron-log
vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    transports: { file: { level: 'info', getFile: () => ({ path: '/test/log' }) } },
  },
}));

// Mock the logger import path used by device-watcher
vi.mock('./logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  configureLogger: vi.fn(),
}));

interface MockWindow {
  webContents: {
    send: ReturnType<typeof vi.fn>;
  };
}

// Mock usb-detection module
const mockUsbDetection = {
  startMonitoring: vi.fn(),
  stopMonitoring: vi.fn(),
  on: vi.fn(),
};

vi.mock('usb-detection', () => mockUsbDetection);

describe('Device Watcher (event-based)', () => {
  const mockSend = vi.fn();

  const mockWindow: MockWindow = {
    webContents: { send: mockSend },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockClear();
    mockUsbDetection.startMonitoring.mockClear();
    mockUsbDetection.stopMonitoring.mockClear();
    mockUsbDetection.on.mockClear();
    mockUsbDetection.on.mockReturnValue(undefined);
  });

  describe('startDeviceWatcher', () => {
    it('seeds initialMountpointPaths on start without firing events', async () => {
      const mockListUsbDevices = vi.fn().mockResolvedValue([
        {
          device: '/dev/disk2',
          displayName: 'USB',
          size: 0,
          mountpoints: [{ path: '/Volumes/USB' }],
          isRemovable: true,
        },
      ]);

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      expect(mockListUsbDevices).toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockUsbDetection.startMonitoring).toHaveBeenCalled();
      expect(mockUsbDetection.on).toHaveBeenCalledWith('add', expect.any(Function));
      expect(mockUsbDetection.on).toHaveBeenCalledWith('remove', expect.any(Function));

      stopDeviceWatcher();
    });

    it('emits usb:attach after debounce when a device is added', async () => {
      const mockListUsbDevices = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            device: '/dev/disk2',
            displayName: 'USB',
            size: 0,
            mountpoints: [{ path: '/Volumes/USB' }],
            isRemovable: true,
          },
        ]);

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      const addHandler = getAddHandler();
      addHandler!();
      await new Promise((resolve) => setTimeout(resolve, 400));
      stopDeviceWatcher();

      expect(mockSend).toHaveBeenCalledWith('usb:attach');
    });

    it('emits usb:detach immediately when a device is removed', async () => {
      const mockListUsbDevices = vi.fn().mockResolvedValue([]);

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      const removeHandler = getRemoveHandler();
      removeHandler!();
      stopDeviceWatcher();

      expect(mockSend).toHaveBeenCalledWith('usb:detach');
    });

    it('debounce coalesces rapid add events', async () => {
      const mockListUsbDevices = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            device: '/dev/disk2',
            displayName: 'USB',
            size: 0,
            mountpoints: [{ path: '/Volumes/USB' }],
            isRemovable: true,
          },
        ]);

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      const addHandler = getAddHandler();
      addHandler!();
      addHandler!();
      await new Promise((resolve) => setTimeout(resolve, 400));
      stopDeviceWatcher();

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith('usb:attach');
    });

    it('does not fire spurious attach for device already present at seed', async () => {
      const mockListUsbDevices = vi
        .fn()
        .mockResolvedValueOnce([
          {
            device: '/dev/disk2',
            displayName: 'USB',
            size: 0,
            mountpoints: [{ path: '/Volumes/USB' }],
            isRemovable: true,
          },
        ])
        .mockResolvedValueOnce([
          {
            device: '/dev/disk2',
            displayName: 'USB',
            size: 0,
            mountpoints: [{ path: '/Volumes/USB' }],
            isRemovable: true,
          },
        ]);

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      const addHandler = getAddHandler();
      addHandler!();
      await new Promise((resolve) => setTimeout(resolve, 400));
      stopDeviceWatcher();

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('emits usb:attach via retry when volume mounts slowly (not on first check)', async () => {
      const mockListUsbDevices = vi
        .fn()
        .mockResolvedValueOnce([]) // seed
        .mockResolvedValueOnce([]) // first check after debounce — not mounted yet
        .mockResolvedValueOnce([
          {
            device: '/dev/disk2',
            displayName: 'USB',
            size: 0,
            mountpoints: [{ path: '/Volumes/USB' }],
            isRemovable: true,
          },
        ]);

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      const addHandler = getAddHandler();
      addHandler!();
      // debounce 300ms + first retry 500ms + buffer
      await new Promise((resolve) => setTimeout(resolve, 900));
      stopDeviceWatcher();

      expect(mockSend).toHaveBeenCalledWith('usb:attach');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('retry loop stops after max retries without firing if volume never appears', async () => {
      const mockListUsbDevices = vi.fn().mockResolvedValue([]); // always empty

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      const addHandler = getAddHandler();
      addHandler!();
      // debounce 300ms + 5 retries × 500ms + buffer
      await new Promise((resolve) => setTimeout(resolve, 2900));
      stopDeviceWatcher();

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('detects re-inserted device after eject (initialMountpointPaths must be cleaned up)', async () => {
      const mockListUsbDevices = vi
        .fn()
        .mockResolvedValueOnce([]) // seed
        .mockResolvedValueOnce([
          // first add: device present
          {
            device: '/dev/disk2',
            displayName: 'USB',
            size: 0,
            mountpoints: [{ path: '/Volumes/USB' }],
            isRemovable: true,
          },
        ])
        .mockResolvedValueOnce([]) // remove cleanup: device gone
        .mockResolvedValueOnce([
          // second add: device back
          {
            device: '/dev/disk2',
            displayName: 'USB',
            size: 0,
            mountpoints: [{ path: '/Volumes/USB' }],
            isRemovable: true,
          },
        ]);

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      const addHandler = getAddHandler();
      const removeHandler = getRemoveHandler();

      // First insert
      addHandler!();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(mockSend).toHaveBeenCalledWith('usb:attach');
      mockSend.mockClear();

      // Eject — wait for async initialMountpointPaths cleanup to complete
      await (removeHandler!() as unknown as Promise<void>);
      expect(mockSend).toHaveBeenCalledWith('usb:detach');
      mockSend.mockClear();

      // Re-insert — must be detected again
      addHandler!();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(mockSend).toHaveBeenCalledWith('usb:attach');

      stopDeviceWatcher();
    });

    it('guards against double-start (stops previous before starting)', async () => {
      const mockListUsbDevices = vi.fn().mockResolvedValue([]);

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      expect(mockUsbDetection.stopMonitoring).toHaveBeenCalledTimes(1);
      expect(mockUsbDetection.startMonitoring).toHaveBeenCalledTimes(2);

      stopDeviceWatcher();
    });

    it('starts polling backup alongside event-based watcher', async () => {
      const mockListUsbDevices = vi.fn().mockResolvedValue([]);

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      // Polling backup should be registered (the interval runs with 15s)
      // We can't easily verify the interval exists, but we verify no spurious events
      // The first poll seeds without emitting (pollPreviousPaths starts empty)
      expect(mockSend).not.toHaveBeenCalled();

      stopDeviceWatcher();
    });
  });

  describe('stopDeviceWatcher', () => {
    it('clears debounce timer and stops monitoring', async () => {
      const mockListUsbDevices = vi.fn().mockResolvedValue([]);

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      const addHandler = getAddHandler();
      addHandler!();
      stopDeviceWatcher();

      expect(mockUsbDetection.stopMonitoring).toHaveBeenCalled();
    });

    it('is safe to call twice', async () => {
      const mockListUsbDevices = vi.fn().mockResolvedValue([]);

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      stopDeviceWatcher();
      expect(() => stopDeviceWatcher()).not.toThrow();
    });

    it('stops emitting after being stopped', async () => {
      const mockListUsbDevices = vi.fn().mockResolvedValue([]);

      const { startDeviceWatcher, stopDeviceWatcher } = await import('./device-watcher');
      await startDeviceWatcher(mockWindow as any, mockListUsbDevices);

      stopDeviceWatcher();
      const addHandler = getAddHandler();
      addHandler!();
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});

function getAddHandler(): (() => void) | undefined {
  const call = mockUsbDetection.on.mock.calls.find(([evt]) => evt === 'add');
  return call?.[1] as (() => void) | undefined;
}

function getRemoveHandler(): (() => void) | undefined {
  const call = mockUsbDetection.on.mock.calls.find(([evt]) => evt === 'remove');
  return call?.[1] as (() => void) | undefined;
}
