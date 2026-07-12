import type { PlatformAccessory, Service } from 'homebridge';

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { sanitizeDeviceName } from '../utils/sanitizeName.js';
import { VivintDict } from '../vivint/dictionary.js';
import { HapCategories, VivintDevice } from './device.js';

const EQUIPMENT_CODES = [
  'PIR1_MOTION',
  'PIR2_MOTION',
  'EXISTING_MOTION_DETECTOR',
].map(name => VivintDict.EquipmentCode[name]);

export class MotionSensor extends VivintDevice {
  static override readonly className = 'MotionSensor';
  static override readonly hasBattery = true;

  private readonly service: Service;
  private readonly occupancyService?: Service;
  private readonly occupancyTimeoutMs: number;
  private lastSensedMotion?: number;
  private occupancyTimer?: NodeJS.Timeout;

  constructor(platform: VivintPlatform, accessory: PlatformAccessory<VivintAccessoryContext>, data: DeviceData | undefined) {
    super(platform, accessory, data);

    const sanitizedName = sanitizeDeviceName(this.name, this.id);
    this.occupancyTimeoutMs = (this.config.motionDetectedOccupancySensorMins ?? 0) * 60 * 1000;

    this.service = this.ensureService(this.Service.MotionSensor, sanitizedName);
    this.batteryService?.updateCharacteristic(this.Characteristic.ChargingState, this.Characteristic.ChargingState.NOT_CHARGEABLE);

    this.service.getCharacteristic(this.Characteristic.MotionDetected)
      .onGet(() => this.getMotionDetectedState());
    this.service.getCharacteristic(this.Characteristic.StatusTampered)
      .onGet(() => this.getTamperedState());

    if (this.occupancyTimeoutMs > 0) {
      this.occupancyService = this.ensureService(this.Service.OccupancySensor, `${sanitizedName} Occupancy`);
      this.occupancyService.getCharacteristic(this.Characteristic.OccupancyDetected)
        .onGet(() => this.getOccupancyState());
      this.occupancyTimer = setInterval(() => this.notifyOccupancy(), 60 * 1000);
      this.occupancyTimer.unref();
    } else {
      // The occupancy sensor was disabled in the config; drop a stale service
      // left over on the cached accessory.
      const stale = accessory.getService(this.Service.OccupancySensor);
      if (stale) {
        accessory.removeService(stale);
      }
    }

    this.notify();
  }

  getOccupancyState(): number {
    if (this.lastSensedMotion !== undefined && Date.now() - this.lastSensedMotion < this.occupancyTimeoutMs) {
      return this.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
    }
    return this.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  getMotionDetectedState(): boolean {
    return Boolean(this.data.Status);
  }

  private notifyOccupancy(): void {
    this.occupancyService?.updateCharacteristic(this.Characteristic.OccupancyDetected, this.getOccupancyState());
  }

  override notify(): void {
    super.notify();
    if (this.getMotionDetectedState()) {
      this.lastSensedMotion = Date.now();
    }
    this.service.updateCharacteristic(this.Characteristic.MotionDetected, this.getMotionDetectedState());
    this.service.updateCharacteristic(this.Characteristic.StatusTampered, this.getTamperedState());
    this.notifyOccupancy();
  }

  static override appliesTo(data: DeviceData): boolean {
    return data.Type === VivintDict.PanelDeviceType.WirelessSensor
      && EQUIPMENT_CODES.includes(data.EquipmentCode as number);
  }

  static override inferCategory(data: DeviceData, categories: HapCategories): number {
    return categories.SENSOR;
  }
}
