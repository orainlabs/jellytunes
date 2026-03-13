import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Tipo de dispositivo USB
interface UsbDeviceInfo {
  deviceAddress: number
  vendorId: number
  productId: number
  productName?: string
  manufacturerName?: string
}

// APIs personalizadas para el renderer
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

// Exponer APIs al renderer
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
