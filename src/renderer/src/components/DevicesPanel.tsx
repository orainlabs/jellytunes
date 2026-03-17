import { HardDrive } from 'lucide-react'
import type { UsbDevice } from '../appTypes'

interface DevicesPanelProps {
  devices: UsbDevice[]
}

export function DevicesPanel({ devices }: DevicesPanelProps): JSX.Element {
  return (
    <div className="text-center text-zinc-500 py-20">
      {devices.length === 0 ? (
        <>
          <HardDrive className="w-16 h-16 mx-auto mb-4 opacity-50" />
          <p>Connect a USB device to sync</p>
        </>
      ) : (
        <div className="grid gap-4 text-left max-w-md mx-auto">
          {devices.map((device) => (
            <div key={`${device.vendorId}-${device.productId}-${device.deviceAddress}`} className="p-4 bg-zinc-900 rounded-lg">
              <div className="flex items-center gap-3 mb-3">
                <HardDrive className="w-8 h-8 text-blue-500" />
                <div>
                  <h3 className="font-medium text-zinc-100">
                    {device.productName || 'USB Device'}
                  </h3>
                  {device.manufacturerName && (
                    <p className="text-xs text-zinc-500">{device.manufacturerName}</p>
                  )}
                </div>
              </div>
              <div className="text-xs text-zinc-500 space-y-1">
                <p>Address: {device.deviceAddress}</p>
                <p>VID: 0x{device.vendorId?.toString(16).padStart(4, '0').toUpperCase()}</p>
                <p>PID: 0x{device.productId?.toString(16).padStart(4, '0').toUpperCase()}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
