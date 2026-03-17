import { useState, useEffect } from 'react'
import type { UsbDevice } from '../appTypes'

export function useDevices(): UsbDevice[] {
  const [devices, setDevices] = useState<UsbDevice[]>([])

  useEffect(() => {
    window.api?.listUsbDevices().then(setDevices)
    window.api?.onUsbAttach(() => window.api?.listUsbDevices().then(setDevices))
    window.api?.onUsbDetach(() => window.api?.listUsbDevices().then(setDevices))
  }, [])

  return devices
}
