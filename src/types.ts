import type { PlatformConfig } from 'homebridge';

/**
 * Plugin configuration as stored in the Homebridge config.json.
 */
export interface VivintPlatformConfig extends PlatformConfig {
  refreshToken?: string;
  apiLoginRefreshSecs?: number;
  ignoreDeviceTypes?: string[];
  logDeviceList?: boolean;
  disableCameras?: boolean;
  useExternalVideoStreams?: boolean;
  showCameraConfig?: boolean;
  lowBatteryLevel?: number;
  motionDetectedOccupancySensorMins?: number;
}

/**
 * A device object from the Vivint API after its wire field names have been
 * mapped to friendly names via the Vivint dictionary. The full shape varies
 * greatly between device types, so only commonly used fields are declared.
 */
export interface DeviceData {
  Id: number;
  Type?: string;
  Name?: string;
  Status?: unknown;
  Value?: number;
  EquipmentCode?: number;
  ActualType?: string;
  SerialNumber?: number;
  SerialNumber32Bit?: number;
  CurrentSoftwareVersion?: string;
  SoftwareVersion?: string;
  BatteryLevel?: number;
  LowBattery?: boolean;
  Tamper?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * A partition snapshot from the Vivint API (mapped field names).
 */
export interface PartitionSnapshot {
  Devices: DeviceData[];
  Status?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * A parsed PubNub message (mapped field names).
 */
export interface PubNubMessage {
  Id?: number;
  Type?: string;
  Data?: {
    Devices?: DeviceData[];
    Status?: number;
    Subject?: string;
    PlatformContext?: { Timestamp?: number };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Values stored on each accessory's context object.
 */
export interface VivintAccessoryContext {
  id: number;
  name: string;
  deviceClassName: string;
  serial: string;
}
