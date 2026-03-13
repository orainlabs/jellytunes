import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  // USB
  listUsbDevices: (): Promise<Array<{ deviceAddress: number; vendorId: number; productId: number }>> =>
    ipcRenderer.invoke('usb:list'),
  onUsbAttach: (callback: (device: unknown) => void) =>
    ipcRenderer.on('usb:attach', (_, device) => callback(device)),
  onUsbDetach: (callback: (device: unknown) => void) =>
    ipcRenderer.on('usb:detach', (_, device) => callback(device)),

  // App
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version')
}

// Expose APIs to renderer
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
