import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// USB device type
interface UsbDeviceInfo {
  deviceAddress: number
  vendorId: number
  productId: number
  productName?: string
  manufacturerName?: string
}

// Custom APIs for renderer
const api = {
  // USB
  listUsbDevices: (): Promise<UsbDeviceInfo[]> =>
    ipcRenderer.invoke('usb:list'),
  onUsbAttach: (callback: (device: UsbDeviceInfo) => void) =>
    ipcRenderer.on('usb:attach', (_, device) => callback(device as UsbDeviceInfo)),
  onUsbDetach: (callback: (device: UsbDeviceInfo) => void) =>
    ipcRenderer.on('usb:detach', (_, device) => callback(device as UsbDeviceInfo)),

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
