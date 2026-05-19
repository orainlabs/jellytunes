// Mock electron modules before any imports happen

// Mock electron-log (used by database.ts)
vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock electron module
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/mock',
    isPackaged: false,
    getName: () => 'JellyTunes',
    getVersion: () => '0.3.2',
  },
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

// Mock better-sqlite3
vi.mock('better-sqlite3', () => {
  const mockDb = {
    prepare: () => ({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
    exec: vi.fn(),
    close: vi.fn(),
  };
  return { default: vi.fn(() => mockDb) };
});
