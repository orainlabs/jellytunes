import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log'

// Configure logging
log.transports.file.level = 'info'
log.info('Jellysync starting...')

let mainWindow: BrowserWindow | null = null

// USB detection - simplified for now
interface UsbDeviceInfo {
  deviceAddress: number
  vendorId: number
  productId: number
  productName?: string
  manufacturerName?: string
}

function listUsbDevices(): UsbDeviceInfo[] {
  // USB detection disabled due to native module issues
  // Return empty array for now
  log.info('USB detection: disabled')
  return []
}

// USB event handlers - disabled
function setupUsbEvents(): void {
  log.info('USB events: disabled')
}

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

// IPC handlers
ipcMain.handle('usb:list', async () => {
  try {
    return listUsbDevices()
  } catch (error) {
    log.error('Error in usb:list handler:', error)
    return []
  }
})

ipcMain.handle('app:version', () => app.getVersion())

app.whenReady().then(() => {
  log.info('App ready')

  electronApp.setAppUserModelId('com.jellysync.app')

  // Configurar listeners de eventos USB
  setupUsbEvents()

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
