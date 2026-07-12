import type { PlatformAccessory } from 'homebridge';

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { Camera } from './camera.js';
import { CarbonMonoxideSensor } from './carbonMonoxideSensor.js';
import { ContactSensor } from './contactSensor.js';
import { HapCategories, VivintDevice } from './device.js';
import { DimmerSwitch } from './dimmerSwitch.js';
import { GarageDoor } from './garageDoor.js';
import { LightGroup } from './lightGroup.js';
import { LightSwitch } from './lightSwitch.js';
import { Lock } from './lock.js';
import { MotionSensor } from './motionSensor.js';
import { Panel } from './panel.js';
import { SmokeSensor } from './smokeSensor.js';
import { Thermostat } from './thermostat.js';

export { VivintDevice };

export interface DeviceHandlerClass {
  new (
    platform: VivintPlatform,
    accessory: PlatformAccessory<VivintAccessoryContext>,
    data: DeviceData | undefined,
  ): VivintDevice;
  readonly className: string;
  appliesTo(data: DeviceData): boolean;
  inferCategory(data: DeviceData, categories: HapCategories): number;
}

/**
 * All supported device handlers, in matching priority order.
 */
export const DEVICE_HANDLERS: DeviceHandlerClass[] = [
  ContactSensor,
  SmokeSensor,
  CarbonMonoxideSensor,
  MotionSensor,
  Lock,
  Thermostat,
  GarageDoor,
  Panel,
  Camera,
  LightSwitch,
  DimmerSwitch,
  LightGroup,
];

export function findHandlerForData(data: DeviceData): DeviceHandlerClass | undefined {
  return DEVICE_HANDLERS.find(handler => handler.appliesTo(data));
}

export function findHandlerByClassName(className: string): DeviceHandlerClass | undefined {
  return DEVICE_HANDLERS.find(handler => handler.className === className);
}

/**
 * Device types that exist in the Vivint snapshot but have no HomeKit purpose.
 * They are silently skipped instead of being reported as unsupported.
 */
export const IRRELEVANT_DEVICE_TYPES = [
  'sensor_group',
  'network_hosts_service',
  'panel_diagnostics_service',
  'iot_service',
  'scheduler_service',
  'yofi_device',
  'keyfob_device',
  'control4_device',
  'lgit_poe_wifi_bridge_device',
  'mqtt_audio_sync_service',
  'holiday_theme_service',
];
