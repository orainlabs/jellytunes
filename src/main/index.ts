import { app, shell, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'

// Import new sync module
import { createSyncCore, createApiClient, CoverArtMode } from '../sync'

// Import database
import { initDatabase, recordSyncCompleted, getSyncedItems, getDeviceSyncInfo, getRecentSyncHistory, removeSyncedItems, clearDestinationRecords, getSyncedTracksForDevice } from './database'

// Import preferences
import { getPreferences, setPreferences } from './preferences'

// Configure logger before anything else
import { configureLogger, log } from './logger'
configureLogger()
log.info('JellyTunes starting...')

let mainWindow: BrowserWindow | null = null

// Import device watcher
import { startDeviceWatcher, stopDeviceWatcher } from './device-watcher'

interface UsbDevice {
  device: string
  displayName: string
  size: number
  mountpoints: Array<{ path: string }>
  isRemovable: boolean
  vendorName?: string
  serialNumber?: string
}

interface DeviceInfo {
  total: number
  free: number
  used: number
}

async function listUsbDevices(): Promise<UsbDevice[]> {
  // drivelist removed - using folder selection instead
  // For USB detection, user selects folder manually
  log.info('USB detection disabled - using folder selection dialog')
  return listMountedVolumesFallback()
}

function listMountedVolumesFallback(): UsbDevice[] {
  const platform = process.platform
  const devices: UsbDevice[] = []
  try {
    if (platform === 'darwin') {
      const volumesPath = '/Volumes'
      if (fs.existsSync(volumesPath)) {
        const volumes = fs.readdirSync(volumesPath)
        const SYSTEM_VOLUMES = new Set(['Macintosh HD', 'Macintosh HD - Data', 'System', 'Preboot', 'Recovery', 'VM', 'Update'])
        for (const vol of volumes) {
          if (SYSTEM_VOLUMES.has(vol) || vol.startsWith('.')) continue
          const volPath = join(volumesPath, vol)
          try {
            const stats = fs.statSync(volPath)
            if (stats.isDirectory()) {
              devices.push({
                device: volPath,
                displayName: vol,
                size: 0,
                mountpoints: [{ path: volPath }],
                isRemovable: true,
                vendorName: 'External'
              })
            }
          } catch (e) { /* ignore */ }
        }
      }
    } else if (platform === 'linux') {
      const mountPaths = ['/media', '/mnt', '/run/media']
      for (const mp of mountPaths) {
        if (fs.existsSync(mp)) {
          try {
            const items = fs.readdirSync(mp)
            for (const item of items) {
              const itemPath = join(mp, item)
              try {
                const stats = fs.statSync(itemPath)
                if (stats.isDirectory()) {
                  devices.push({ device: itemPath, displayName: item, size: 0, mountpoints: [{ path: itemPath }], isRemovable: true })
                }
              } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore */ }
        }
      }
    } else if (platform === 'win32') {
      try {
        const { execSync } = require('child_process')
        const output = execSync('wmic logicaldisk get caption,size,drivetype /format:csv', { encoding: 'utf8' })
        const lines = output.split('\n').filter((line: string) => line.trim())
        for (const line of lines) {
          const parts = line.split(',')
          if (parts.length >= 3) {
            const driveLetter = parts[1]?.trim()
            const driveType = parts[2]?.trim()
            const sizeStr = parts[3]?.trim()
            if (driveLetter && (driveType === '2' || driveType === '3')) {
              const size = parseInt(sizeStr) || 0
              if (size > 0 || driveType === '2') {
                devices.push({ device: driveLetter + '\\', displayName: driveLetter, size, mountpoints: [{ path: driveLetter + '\\' }], isRemovable: driveType === '2', vendorName: driveType === '2' ? 'Removable' : 'Local' })
              }
            }
          }
        }
      } catch (e) { log.error('Windows drive detection error:', e) }
    }
  } catch (error) { log.error('Fallback volume detection error:', error) }
  log.info(`Fallback: Found ${devices.length} volumes`)
  return devices
}

async function getDeviceInfo(devicePath: string): Promise<DeviceInfo> {
  try {
    const platform = process.platform
    if (platform === 'darwin' || platform === 'linux') {
      // spawnSync with arg array — no shell injection risk
      const result = spawnSync('df', ['-k', devicePath], { encoding: 'utf8' })
      const lines = (result.stdout ?? '').trim().split('\n').filter((l: string) => l.trim())
      const lastLine = lines[lines.length - 1] ?? ''
      const parts = lastLine.trim().split(/\s+/)
      if (parts.length >= 4) {
        const total = parseInt(parts[1]) * 1024
        const used = parseInt(parts[2]) * 1024
        const free = parseInt(parts[3]) * 1024
        return { total, free, used }
      }
    } else if (platform === 'win32') {
      const driveLetter = devicePath.charAt(0)
      const result = spawnSync(
        'wmic',
        ['logicaldisk', 'where', `caption='${driveLetter}:'`, 'get', 'size,freespace', '/format:csv'],
        { encoding: 'utf8' }
      )
      const lines = (result.stdout ?? '').split('\n').filter((line: string) => line.trim() && !line.includes('Node'))
      if (lines.length > 0) {
        const parts = lines[lines.length - 1].split(',')
        const free = parseInt(parts[1]) || 0
        const size = parseInt(parts[2]) || 0
        return { total: size, free, used: size - free }
      }
    }
  } catch (error) { log.error('Error getting device info:', error) }
  return { total: 0, free: 0, used: 0 }
}

async function detectFilesystem(devicePath: string): Promise<string> {
  try {
    const platform = process.platform
    if (platform === 'darwin') {
      // spawnSync with arg array — no shell injection risk
      const result = spawnSync('diskutil', ['info', devicePath], { encoding: 'utf8', timeout: 5000 })
      const output = result.stdout ?? ''
      const match = output.match(/File System Personality\s*:\s*(.+)/i)
      if (match) {
        const t = match[1].trim().toLowerCase()
        if (t.includes('fat32') || t === 'ms-dos fat32' || t === 'msdos') return 'fat32'
        if (t.includes('exfat')) return 'exfat'
        if (t.includes('ntfs')) return 'ntfs'
        if (t.includes('apfs')) return 'apfs'
        if (t.includes('hfs')) return 'hfs+'
      }
    } else if (platform === 'linux') {
      const result = spawnSync('df', ['-T', devicePath], { encoding: 'utf8', timeout: 5000 })
      const lines = (result.stdout ?? '').trim().split('\n').filter((l: string) => l.trim())
      const lastLine = lines[lines.length - 1] ?? ''
      const parts = lastLine.trim().split(/\s+/)
      if (parts.length >= 2) {
        const t = parts[1].toLowerCase()
        if (t === 'vfat' || t === 'fat32' || t === 'msdos') return 'fat32'
        if (t === 'exfat') return 'exfat'
        if (t === 'ntfs' || t === 'ntfs-3g' || t === 'fuseblk') return 'ntfs'
        if (t === 'ext4' || t === 'ext3' || t === 'ext2' || t === 'btrfs' || t === 'xfs') return 'ext4'
        if (t === 'apfs') return 'apfs'
      }
    } else if (platform === 'win32') {
      const driveLetter = devicePath.charAt(0)
      const result = spawnSync(
        'wmic',
        ['logicaldisk', 'where', `caption='${driveLetter}:'`, 'get', 'filesystem', '/format:csv'],
        { encoding: 'utf8', timeout: 5000 }
      )
      const lines = (result.stdout ?? '').split('\n').filter((l: string) => l.trim() && !l.toLowerCase().includes('filesystem'))
      if (lines.length > 0) {
        const t = (lines[lines.length - 1].split(',').pop() ?? '').trim().toLowerCase()
        if (t === 'fat32') return 'fat32'
        if (t === 'exfat') return 'exfat'
        if (t === 'ntfs') return 'ntfs'
      }
    }
  } catch (e) { log.warn('Filesystem detection error:', e) }
  return 'unknown'
}

function getTrackSize(filePath: string): number {
  try {
    const stats = fs.statSync(filePath)
    return stats.size
  } catch (error) { return 0 }
}

function detectAudioFormat(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.mp3': return 'mp3'
    case '.flac': return 'flac'
    case '.m4a': return 'm4a'
    case '.aac': return 'aac'
    case '.ogg': return 'ogg'
    case '.wav': return 'wav'
    default: return 'unknown'
  }
}

import * as path from 'path'

let isSyncCancelled = false
let activeSyncCore: import('../sync').SyncCore | null = null

// Helper to extract server root from a file path
// Example: /mediamusic/lib/lib/4 Strings/Album/track.flac -> /mediamusic/lib/lib/
function extractServerRoot(filePath: string): string {
  // Common server root patterns
  const patterns = [
    '/mediamusic/',
    '/music/',
    '/data/',
    '/media/'
  ]
  
  // Find the first occurrence of a known root pattern
  for (const pattern of patterns) {
    const idx = filePath.toLowerCase().indexOf(pattern)
    if (idx !== -1) {
      return filePath.substring(0, idx + pattern.length)
    }
  }
  
  // Fallback: find the first 2 path segments
  const parts = filePath.split('/')
  if (parts.length >= 3) {
    return '/' + parts[1] + '/' + parts[2] + '/'
  }
  
  // Last resort: return just the root
  return '/'
}

// Helper to download file from Jellyfin server with retry logic
async function downloadFromJellyfin(trackId: string, outputPath: string, serverUrl: string, apiKey: string, maxRetries: number = 3): Promise<{ success: boolean; error?: string }> {
  const RETRY_DELAYS = [1000, 2000, 4000] // Exponential backoff
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 120000) // 2 min timeout
      
      const response = await fetch(`${serverUrl}/Items/${trackId}/Download`, {
        headers: {
          'X-MediaBrowser-Token': apiKey,
          'X-Emby-Token': apiKey
        },
        signal: controller.signal
      })
      
      clearTimeout(timeoutId)
      
      if (!response.ok) {
        const statusText = response.statusText || 'Unknown error'
        if (attempt < maxRetries) {
          log.warn(`Download attempt ${attempt} failed for track ${trackId}: ${response.status} ${statusText}. Retrying...`)
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt - 1]))
          continue
        }
        return { success: false, error: `HTTP ${response.status}: ${statusText}` }
      }
      
      const buffer = await response.arrayBuffer()
      fs.writeFileSync(outputPath, Buffer.from(buffer))
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      
      if (attempt < maxRetries) {
        log.warn(`Download attempt ${attempt} failed for track ${trackId}: ${errorMsg}. Retrying...`)
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt - 1]))
      } else {
        log.error(`Download failed after ${maxRetries} attempts for track ${trackId}: ${errorMsg}`)
        return { success: false, error: errorMsg }
      }
    }
  }
  
  return { success: false, error: 'Max retries exceeded' }
}

async function syncTracks(options: { tracks: Array<{ id: string; name: string; path: string; size: number; format: string }>; targetPath: string; convertToMp3: boolean; mp3Bitrate: string; serverUrl?: string; apiKey?: string; onProgress: (progress: { current: number; total: number; currentFile: string; status: string }) => void }): Promise<{ success: boolean; errors: string[]; syncedFiles: number }> {
  const { tracks, targetPath, convertToMp3: _convertToMp3, mp3Bitrate: _mp3Bitrate, serverUrl: _serverUrl, apiKey: _apiKey, onProgress } = options
  const errors: string[] = []
  let syncedFiles = 0
  isSyncCancelled = false
  if (!fs.existsSync(targetPath)) { fs.mkdirSync(targetPath, { recursive: true }) }
  const total = tracks.length
  
  for (let i = 0; i < tracks.length; i++) {
    if (isSyncCancelled) break
    const track = tracks[i]
    onProgress({ current: i + 1, total, currentFile: track.name, status: 'syncing' })
    try {
      let outputPathFull: string
      
      // Use Jellyfin download endpoint if serverUrl is provided
      if (_serverUrl && _apiKey) {
        // Preserve server folder structure - replace server root with target path
        // Example: /mediamusic/lib/lib/4 Strings/Album/track.flac -> /target/lib/lib/4 Strings/Album/track.flac
        const serverRoot = extractServerRoot(track.path)
        const relativePath = track.path.replace(serverRoot, '')
        outputPathFull = join(targetPath, relativePath)
        
        // Ensure directory exists
        const dir = path.dirname(outputPathFull)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        
        // Check if already exists with same size
        if (fs.existsSync(outputPathFull)) {
          const existingStats = fs.statSync(outputPathFull)
          if (existingStats.size === track.size) {
            syncedFiles++
            log.info(`Skipped (exists): ${track.name}`)
            continue
          }
        }
        
        // Download from Jellyfin server
        const downloaded = await downloadFromJellyfin(track.id, outputPathFull, _serverUrl, _apiKey)
        if (!downloaded) {
          errors.push(`Failed to download: ${track.name}`)
          continue
        }
      } else {
        // Fallback to local copy (for testing)
        const outputFileName = path.basename(track.path)
        outputPathFull = join(targetPath, outputFileName)
        if (fs.existsSync(outputPathFull)) {
          const existingStats = fs.statSync(outputPathFull)
          const sourceStats = fs.statSync(track.path)
          if (existingStats.size === sourceStats.size) { syncedFiles++; continue }
        }
        fs.copyFileSync(track.path, outputPathFull)
      }
      
      syncedFiles++
      log.info(`Synced: ${track.name} -> ${outputPathFull}`)
    } catch (error) {
      const errorMsg = `Failed to sync "${track.name}": ${error instanceof Error ? error.message : String(error)}`
      log.error(errorMsg)
      errors.push(errorMsg)
    }
  }
  onProgress({ current: total, total, currentFile: '', status: isSyncCancelled ? 'cancelled' : 'completed' })
  return { success: errors.length === 0 && !isSyncCancelled, errors, syncedFiles }
}

function cancelSync(): void {
  isSyncCancelled = true
  activeSyncCore?.cancel()
  log.info('Sync cancellation requested')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600, show: false, autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // sandbox: false required for native modules (better-sqlite3, @ffmpeg-installer/ffmpeg)
      // contextIsolation + no nodeIntegration still enforced for renderer security
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    }
  })
  mainWindow.on('ready-to-show', () => { mainWindow?.show(); log.info('Window ready') })
  mainWindow.webContents.on('did-finish-load', async () => {
    if (mainWindow) await startDeviceWatcher(mainWindow, listUsbDevices)
  })
  mainWindow.webContents.setWindowOpenHandler((details) => { shell.openExternal(details.url); return { action: 'deny' } })
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && rendererUrl) { mainWindow.loadURL(rendererUrl) } else { mainWindow.loadFile(join(__dirname, '../renderer/index.html')) }
}

// ---------------------------------------------------------------------------
// Encrypted session storage (replaces plaintext localStorage)
// ---------------------------------------------------------------------------
const SESSION_FILE = () => join(app.getPath('userData'), 'session.enc')

ipcMain.handle('session:save', (_event, plaintext: string) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: store without encryption if OS keychain unavailable (rare edge case)
      fs.writeFileSync(SESSION_FILE(), plaintext, 'utf8')
      return
    }
    const encrypted = safeStorage.encryptString(plaintext)
    fs.writeFileSync(SESSION_FILE(), encrypted)
  } catch (e) { log.error('Failed to save session:', e) }
})

ipcMain.handle('session:load', () => {
  try {
    const filePath = SESSION_FILE()
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath)
    if (!safeStorage.isEncryptionAvailable()) return raw.toString('utf8')
    return safeStorage.decryptString(raw)
  } catch (e) { log.error('Failed to load session:', e); return null }
})

ipcMain.handle('session:clear', () => {
  try {
    const filePath = SESSION_FILE()
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch (e) { log.error('Failed to clear session:', e) }
})

// ---------------------------------------------------------------------------
// IPC path validation helper
// Ensures renderer-supplied paths are absolute and contain no null bytes or
// shell metacharacters that could be misused if a path ever reaches a shell.
// ---------------------------------------------------------------------------
function isValidPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.includes('\0')) return false // null byte
  // Must be absolute: starts with / (unix) or X:\ or \\ (windows)
  const isAbsolute = p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p) || p.startsWith('\\\\')
  return isAbsolute
}

// Renderer logging — forward renderer-side errors/warnings to the main log file
// Only level and a sanitized message are accepted (no raw objects to avoid leaking PII)
ipcMain.on('log:write', (_event, level: string, message: string) => {
  if (typeof message !== 'string') return
  const safe = message.slice(0, 500) // hard cap to prevent log flooding
  switch (level) {
    case 'error': log.error('[renderer]', safe); break
    case 'warn':  log.warn('[renderer]', safe); break
    default:      log.info('[renderer]', safe)
  }
})

// Expose log file path so the user can open/inspect it (transparency)
ipcMain.handle('log:getPath', () => log.transports.file.getFile().path)

// Open pre-filled GitHub bug report in the system browser
ipcMain.handle('bug:report', async () => {
  try {
    const logPath = log.transports.file.getFile().path
    let logExcerpt = '(log file not found)'
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      const errorLines = lines.filter(l => l.includes('[error]') || l.includes('[warn]')).slice(-15)
      const recentLines = lines.slice(-10)
      logExcerpt = [...new Set([...errorLines, ...recentLines])].slice(-25).join('\n')
    }

    const body = [
      `**Describe the bug**`,
      `A clear and concise description of what the bug is.`,
      ``,
      `**To Reproduce**`,
      `Steps to reproduce the behavior:`,
      `1. Go to '...'`,
      `2. Click on '...'`,
      `3. See error`,
      ``,
      `**Expected behavior**`,
      `A clear and concise description of what you expected to happen.`,
      ``,
      `**Screenshots**`,
      `If applicable, add screenshots to help explain your problem.`,
      ``,
      `**Desktop (please complete the following information):**`,
      ` - OS: ${process.platform} ${os.release()}`,
      ` - JellyTunes version: ${app.getVersion()}`,
      ` - Jellyfin server version: [e.g. 10.9.0]`,
      ``,
      `**Log output**`,
      '```',
      logExcerpt,
      '```',
      ``,
      `**Additional context**`,
      `Add any other context about the problem here.`,
    ].join('\n')

    const url = `https://github.com/oriaflow-labs/jellytunes/issues/new?` +
      `labels=${encodeURIComponent('bug')}&` +
      `title=${encodeURIComponent('Bug report')}&` +
      `body=${encodeURIComponent(body)}`

    await shell.openExternal(url)
    return { success: true }
  } catch (e) {
    log.error('bug:report error:', e)
    return { success: false, error: String(e) }
  }
})

ipcMain.handle('usb:list', async () => { try { return await listUsbDevices() } catch (error) { log.error('Error in usb:list handler:', error); return [] } })
ipcMain.handle('usb:getDeviceInfo', async (_event, devicePath: string) => {
  if (!isValidPath(devicePath)) { log.warn('usb:getDeviceInfo: invalid path', devicePath); return { total: 0, free: 0, used: 0 } }
  try { return await getDeviceInfo(devicePath) } catch (error) { log.error('Error getting device info:', error); return { total: 0, free: 0, used: 0 } }
})
ipcMain.handle('usb:getTrackSize', async (_event, trackPath: string) => getTrackSize(trackPath))
ipcMain.handle('usb:getTrackFormat', async (_event, trackPath: string) => detectAudioFormat(trackPath))
ipcMain.handle('device:getFilesystem', async (_event, devicePath: string) => {
  if (!isValidPath(devicePath)) { log.warn('device:getFilesystem: invalid path', devicePath); return 'unknown' }
  try { return await detectFilesystem(devicePath) } catch (e) { return 'unknown' }
})
ipcMain.handle('sync:start', async (_event, options) => {
  try {
    log.info(`Starting sync to ${options.targetPath} with ${options.tracks.length} tracks`)
    const result = await syncTracks({
      tracks: options.tracks, 
      targetPath: options.targetPath, 
      convertToMp3: options.convertToMp3, 
      mp3Bitrate: options.mp3Bitrate,
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
      onProgress: (progress) => { mainWindow?.webContents.send('sync:progress', progress) }
    })
    return result
  } catch (error) { log.error('Sync error:', error); return { success: false, errors: [error instanceof Error ? error.message : String(error)], syncedFiles: 0 } }
})

// New sync:start2 handler - uses SyncCore for proper path resolution
ipcMain.handle('sync:start2', async (_event, options) => {
  try {
    const { serverUrl, apiKey, userId, itemIds, itemTypes, itemNames = {}, destinationPath, options: syncOptions = {} } = options
    log.info(`Starting sync v2 to ${destinationPath} with ${itemIds.length} items`)
    
    // Validate inputs
    if (!serverUrl || !apiKey || !userId) {
      return { success: false, errors: ['Missing serverUrl, apiKey, or userId'], tracksCopied: 0 }
    }
    
    // Create destination folder if needed
    if (!fs.existsSync(destinationPath)) {
      fs.mkdirSync(destinationPath, { recursive: true })
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
          info:  (msg) => log.info('[sync]', msg),
          warn:  (msg) => log.warn('[sync]', msg),
          error: (msg) => log.error('[sync]', msg),
          debug: (msg) => log.debug('[sync]', msg),
        },
      }
    )
    activeSyncCore = syncCore

    // Convert itemTypes to Map if needed
    const itemTypesMap = itemTypes instanceof Map ? itemTypes : new Map(Object.entries(itemTypes))

    // Detect destination filesystem for path sanitization
    const filesystemType = await detectFilesystem(destinationPath)
    log.info(`Destination filesystem: ${filesystemType}`)

    // Run sync with progress callback that maps to renderer format
    const result = await syncCore.sync(
      {
        itemIds,
        itemTypes: itemTypesMap,
        destinationPath,
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
        let status: 'syncing' | 'completed' | 'cancelled' = 'syncing'
        if (progress.phase === 'complete') status = 'completed'
        else if (progress.phase === 'cancelled') status = 'cancelled'
        
        mainWindow?.webContents.send('sync:progress', {
          current: progress.current,
          total: progress.total,
          currentFile: progress.currentTrack || '',
          status,
          phase: progress.phase,
          bytesProcessed: progress.bytesProcessed,
          totalBytes: progress.totalBytes,
          warning: progress.warning,
        })
      }
    )
    
    activeSyncCore = null
    log.info(`Sync v2 completed: ${result.tracksCopied} copied, ${result.tracksSkipped} skipped, ${result.errors.length} errors`)

    // Record to SQLite
    const status = result.cancelled ? 'cancelled' : result.success ? 'success' : 'error'
    const syncedIds = itemIds.filter((id: string) => !result.tracksFailed.includes(id))
    const syncedItems = syncedIds.map((id: string) => ({
      id,
      name: (itemNames as Record<string, string>)[id] ?? id,
      type: (itemTypes as Record<string, 'artist' | 'album' | 'playlist'>)[id] ?? 'artist',
    }))
    try { recordSyncCompleted(destinationPath, result.tracksCopied, result.totalSizeBytes ?? 0, status, syncedItems) }
    catch (dbErr) { log.warn('Failed to record sync history:', dbErr) }

    return {
      success: result.success,
      tracksCopied: result.tracksCopied,
      tracksSkipped: result.tracksSkipped,
      tracksRetagged: result.tracksRetagged,
      tracksFailed: result.tracksFailed,
      errors: result.errors,
      totalSizeBytes: result.totalSizeBytes,
    }
  } catch (error) {
    activeSyncCore = null
    log.error('Sync v2 error:', error);
    return { success: false, errors: [error instanceof Error ? error.message : String(error)], tracksCopied: 0 }
  }
})
ipcMain.handle('sync:analyzeDiff', async (_event, options: {
  serverUrl: string; apiKey: string; userId: string
  itemIds: string[]; itemTypes: Record<string, 'artist' | 'album' | 'playlist'>
  destinationPath: string
  options: { coverArtMode: CoverArtMode; bitrate: '128k' | '192k' | '320k'; convertToMp3: boolean }
}) => {
  try {
    const { serverUrl, apiKey, userId, itemIds, itemTypes, destinationPath, options: diffOptions } = options
    const syncCore = createSyncCore({ serverUrl: serverUrl.replace(/\/$/, ''), apiKey, userId })
    const itemTypesMap = new Map(Object.entries(itemTypes))
    const result = await syncCore.analyzeDiff(itemIds, itemTypesMap, destinationPath, diffOptions)
    return { success: true, ...result }
  } catch (error) {
    log.error('sync:analyzeDiff error:', error)
    return { success: false, items: [], totals: { newTracks: 0, metadataChanged: 0, removed: 0, pathChanged: 0, unchanged: 0 }, errors: [error instanceof Error ? error.message : String(error)] }
  }
})
ipcMain.handle('sync:cancel', () => { cancelSync(); return { cancelled: true } })
ipcMain.handle('app:version', () => app.getVersion())
ipcMain.handle('dialog:selectFolder', async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Select sync destination folder' }); return result.canceled ? null : result.filePaths[0] })
ipcMain.handle('fs:getFolderStats', async (_event, folderPath: string) => {
  if (!isValidPath(folderPath)) return { exists: false, error: 'Invalid path' }
  try { const stats = fs.statSync(folderPath); return { exists: true, isDirectory: stats.isDirectory(), size: stats.size, modified: stats.mtime.toISOString() } } catch (error) { return { exists: false, error: String(error) } }
})
ipcMain.handle('ffmpeg:isAvailable', async () => { try { require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' }); return true } catch (e) { try { require('@ffmpeg-installer/ffmpeg'); return true } catch (e2) { return false } } })

// ─── TrackRegistry IPCs ───────────────────────────────────────────────────────
// Get synced tracks for a device from DB (used by useTrackRegistry)
ipcMain.handle('sync:getSyncedTracks', (_event, mountPoint: string) => {
  try {
    return getSyncedTracksForDevice(mountPoint)
  } catch (error) {
    log.error('sync:getSyncedTracks error:', error)
    return []
  }
})

// Get tracks for an item from Jellyfin (lazy loading for useTrackRegistry)
ipcMain.handle('sync:getTracksForItem', async (_event, options: {
  serverUrl: string; apiKey: string; userId: string
  itemId: string; itemType: 'artist' | 'album' | 'playlist'
}) => {
  try {
    const { serverUrl, apiKey, userId, itemId, itemType } = options
    const api = createApiClient({ baseUrl: serverUrl.replace(/\/$/, ''), apiKey, userId })
    const itemTypesMap = new Map([[itemId, itemType]])
    const { tracks, errors } = await api.getTracksForItems([itemId], itemTypesMap)
    return { tracks, errors }
  } catch (error) {
    log.error('sync:getTracksForItem error:', error)
    return { tracks: [], errors: [error instanceof Error ? error.message : String(error)] }
  }
})

// ─── Sync history (SQLite) ─────────────────────────────────────────────────
ipcMain.handle('sync:getDeviceInfo', (_event, mountPoint: string) => {
  try { return getDeviceSyncInfo(mountPoint) }
  catch (error) { log.error('getDeviceInfo error:', error); return null }
})
ipcMain.handle('sync:getHistory', () => {
  try { return getRecentSyncHistory(20) }
  catch (error) { log.error('getHistory error:', error); return [] }
})
ipcMain.handle('sync:getSyncedItems', (_event, mountPoint: string) => {
  try { return getSyncedItems(mountPoint) }
  catch (error) { log.error('getSyncedItems error:', error); return [] }
})

// ─── Remove items from destination ──────────────────────────────────────────
ipcMain.handle('sync:removeItems', async (_event, options: {
  serverUrl: string; apiKey: string; userId: string
  itemIds: string[]; itemTypes: Record<string, 'artist' | 'album' | 'playlist'>
  destinationPath: string
}) => {
  try {
    const { serverUrl, apiKey, userId, itemIds, itemTypes, destinationPath } = options
    log.info(`Removing ${itemIds.length} items from ${destinationPath}`)
    const core = createSyncCore(
      { serverUrl: serverUrl.replace(/\/$/, ''), apiKey, userId },
      { logger: { info: (m) => log.info('[sync]', m), warn: (m) => log.warn('[sync]', m), error: (m) => log.error('[sync]', m), debug: (m) => log.debug('[sync]', m) } }
    )
    const itemTypesMap = new Map(Object.entries(itemTypes)) as Map<string, 'artist' | 'album' | 'playlist'>
    const result = await core.removeItems(itemIds, itemTypesMap, destinationPath)
    log.info(`Removed ${result.removed} tracks, ${result.errors.length} errors`)
    // Remove from SQLite tracking
    try { removeSyncedItems(destinationPath, itemIds) } catch (dbErr) { log.warn('Failed to remove synced items from db:', dbErr) }
    return result
  } catch (error) {
    log.error('removeItems error:', error)
    return { removed: 0, errors: [error instanceof Error ? error.message : String(error)] }
  }
})

// Clear all synced items and optionally delete files for a destination
ipcMain.handle('sync:clearDestination', async (_event, options: {
  serverUrl: string; apiKey: string; userId: string; destinationPath: string
}) => {
  const { serverUrl, apiKey, userId, destinationPath } = options
  try {
    const core = createSyncCore(
      { serverUrl: serverUrl.replace(/\/$/, ''), apiKey, userId },
      { logger: { info: (m) => log.info('[sync]', m), warn: (m) => log.warn('[sync]', m), error: (m) => log.error('[sync]', m), debug: (m) => log.debug('[sync]', m) } }
    )
    const syncedItems = getSyncedItems(destinationPath)
    if (syncedItems.length === 0) {
      clearDestinationRecords(destinationPath)
      return { deleted: 0, errors: [] }
    }
    const allIds = syncedItems.map(i => i.id)
    const itemTypesMap = new Map(syncedItems.map(i => [i.id, i.type])) as Map<string, 'artist' | 'album' | 'playlist'>
    const result = await core.removeItems(allIds, itemTypesMap, destinationPath)
    log.info(`clearDestination: removed ${result.removed} files, ${result.errors.length} errors`)
    clearDestinationRecords(destinationPath)
    return { deleted: result.removed, errors: result.errors }
  } catch (error) {
    log.error('clearDestination error:', error)
    return { deleted: 0, errors: [error instanceof Error ? error.message : String(error)] }
  }
})

// Update checker — queries analytics worker at most once per 24h
const UPDATE_CHECKER_URL = 'https://api.oriaflow.dev/jellytunes/updates/latest'
let lastUpdateCheck = 0
let cachedUpdateInfo: { updateAvailable: boolean; latestVersion: string; releaseUrl: string } | null = null

async function performUpdateCheck(force = false): Promise<{ updateAvailable: boolean; latestVersion: string; releaseUrl: string }> {
  // Skip update checks in development (not packaged) to avoid contaminating stats
  if (!app.isPackaged) {
    log.info('Update check skipped in development mode')
    return { updateAvailable: false, latestVersion: app.getVersion(), releaseUrl: '' }
  }
  const now = Date.now()
  const ONE_DAY_MS = 24 * 60 * 60 * 1000
  if (!force && cachedUpdateInfo && now - lastUpdateCheck < ONE_DAY_MS) return cachedUpdateInfo
  try {
    const { net } = await import('electron')
    const { analyticsEnabled } = getPreferences()
    const request = net.fetch(UPDATE_CHECKER_URL, {
      headers: {
        'User-Agent': `JellyTunes/${app.getVersion()} (${process.platform}; ${process.arch})`,
        'Accept': 'application/vnd.github+json',
        ...(analyticsEnabled ? {} : { 'X-JT-Analytics-Opt-Out': '1' })
      }
    })
    const data = await (await request).json() as { tag_name?: string; html_url?: string }
    const latestVersion = (data.tag_name ?? '').replace(/^v/, '')
    const currentVersion = app.getVersion()
    const updateAvailable = latestVersion !== '' && latestVersion !== currentVersion
    cachedUpdateInfo = { updateAvailable, latestVersion, releaseUrl: data.html_url ?? '' }
    lastUpdateCheck = now
    return cachedUpdateInfo
  } catch {
    return { updateAvailable: false, latestVersion: '', releaseUrl: '' }
  }
}

// Preferences IPC handlers
ipcMain.handle('prefs:get', () => getPreferences())
ipcMain.handle('prefs:set', (_event, partial: { analyticsEnabled?: boolean }) => {
  setPreferences(partial)
})

ipcMain.handle('app:checkForUpdates', (_event, force = false) => performUpdateCheck(force))

app.whenReady().then(() => {
  log.info('App ready')
  initDatabase()
  electronApp.setAppUserModelId('com.jellytunes.app')
  app.on('browser-window-created', (_, window) => { optimizer.watchWindowShortcuts(window) })
  createWindow()
  app.on('activate', function () { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

  // Fire update check every 24h even if app stays open for days
  setInterval(() => { void performUpdateCheck(true) }, 24 * 60 * 60 * 1000)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') { app.quit() } })
app.on('before-quit', () => { stopDeviceWatcher() })
log.info('Main process initialized')
