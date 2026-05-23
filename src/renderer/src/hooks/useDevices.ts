import { useState, useEffect, useCallback } from 'react';
import type { UsbDevice } from '../appTypes';

export function useDevices(): { devices: UsbDevice[]; refresh: () => void } {
  const [devices, setDevices] = useState<UsbDevice[]>([]);

  const refresh = useCallback(() => {
    void window.api?.listUsbDevices().then(setDevices);
  }, []);

  useEffect(() => {
    refresh();
    const unsubAttach = window.api?.onUsbAttach(() => refresh());
    const unsubDetach = window.api?.onUsbDetach(() => refresh());
    return () => {
      unsubAttach?.();
      unsubDetach?.();
    };
  }, [refresh]);

  return { devices, refresh };
}
