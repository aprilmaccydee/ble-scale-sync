import type { BleDeviceInfo } from '../interfaces/scale-adapter.js';
import type { BleChar, BleDevice } from './shared.js';

export interface MaintenanceSession {
  charMap: Map<string, BleChar>;
  device: BleDevice;
  close(): Promise<void>;
}

/** Provision through the watcher's existing BLE subscriber, never a second API client. */
export interface GattMaintenance {
  /** True suppresses export of this advertisement while maintenance is pending. */
  observe(
    info: BleDeviceInfo,
    address: string,
    adapterName: string,
    connect: () => Promise<MaintenanceSession>,
  ): boolean;
}
