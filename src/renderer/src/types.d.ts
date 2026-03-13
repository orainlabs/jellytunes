import { ElectronAPI } from '@electron-toolkit/preload'

interface UsbDevice {
  deviceAddress: number
  vendorId: number
  productId: number
}

interface Api {
  listUsbDevices: () => Promise<UsbDevice[]>
  onUsbAttach: (callback: (device: unknown) => void) => void
  onUsbDetach: (callback: (device: unknown) => void) => void
  getVersion: () => Promise<string>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
