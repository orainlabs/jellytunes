import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log'

// Configure logging
log.transports.file.level = 'info'
log.info('Jellysync starting...')

let mainWindow: BrowserWindow | null = null

// USB detection will be added later with native module
// Currently using mock/placeholder

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    log.info('Window ready')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the app
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && rendererUrl) {
    log.info('Loading dev URL:', rendererUrl)
    mainWindow.loadURL(rendererUrl)
  } else {
    const filePath = join(__dirname, '../renderer/index.html')
    log.info('Loading file:', filePath)
    mainWindow.loadFile(filePath)
  }
}

// IPC Handlers
ipcMain.handle('usb:list', async () => {
  // USB detection disabled - will re-enable with native module build
  return []
})

ipcMain.handle('app:version', () => app.getVersion())

app.whenReady().then(() => {
  log.info('App ready')

  electronApp.setAppUserModelId('com.jellysync.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

log.info('Main process initialized')
