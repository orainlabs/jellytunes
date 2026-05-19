/**
 * Mock electron module to prevent Electron initialization errors in tests.
 * Electron is not available in test environment (no display, no main process).
 */

const noop = () => undefined;

module.exports = {
  app: {
    getPath: noop,
    getName: () => 'JellyTunes',
    getVersion: () => '1.0.0',
    quit: noop,
    on: noop,
    once: noop,
    removeListener: noop,
    isPackaged: false,
  },
  shell: {
    openExternal: noop,
  },
  BrowserWindow: class MockBrowserWindow {
    constructor() {}
    loadURL = noop;
    webContents = {
      send: noop,
      on: noop,
    };
    show = noop;
    close = noop;
    isDestroyed = () => true;
    on = noop;
    once = noop;
    removeListener = noop;
  },
  ipcMain: {
    handle: noop,
    on: noop,
    once: noop,
    removeListener: noop,
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    showMessageBox: async () => ({ response: 0 }),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (str: string) => Buffer.from(str),
    decryptString: (buf: Buffer) => buf.toString(),
  },
};