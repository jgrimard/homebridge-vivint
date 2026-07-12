import type { PlatformAccessory, Service } from 'homebridge';

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { sanitizeDeviceName } from '../utils/sanitizeName.js';
import { VivintDict } from '../vivint/dictionary.js';
import { HapCategories, VivintDevice } from './device.js';

const EQUIPMENT_CODES = [
  'FIREFIGHTER_AUDIO_DETECTOR',
  'HW_SMOKE_5808W3',
  'EXISTING_SMOKE',
  'SMKE1_SMOKE_CANADA',
  'SMKE1_SMOKE',
  'VS_SMKT_SMOKE_DETECTOR',
  'SMKT2_GE_SMOKE_HEAT',
  'SMKT3_2GIG',
  'SMKT6_2GIG',
].map(name => VivintDict.EquipmentCode[name]);

export class SmokeSensor extends VivintDevice {
  static override readonly className = 'SmokeSensor';
  static override readonly hasBattery = true;

  private readonly service: Service;

  constructor(platform: VivintPlatform, accessory: PlatformAccessory<VivintAccessoryContext>, data: DeviceData | undefined) {
    super(platform, accessory, data);

    this.service = this.ensureService(this.Service.SmokeSensor, sanitizeDeviceName(this.name, this.id));
    this.batteryService?.updateCharacteristic(this.Characteristic.ChargingState, this.Characteristic.ChargingState.NOT_CHARGEABLE);

    this.service.getCharacteristic(this.Characteristic.SmokeDetected)
      .onGet(() => this.getSensorState());
    this.service.getCharacteristic(this.Characteristic.StatusTampered)
      .onGet(() => this.getTamperedState());

    this.notify();
  }

  getSensorState(): number {
    return this.data.Status
      ? this.Characteristic.SmokeDetected.SMOKE_DETECTED
      : this.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
  }

  override notify(): void {
    super.notify();
    this.service.updateCharacteristic(this.Characteristic.SmokeDetected, this.getSensorState());
    this.service.updateCharacteristic(this.Characteristic.StatusTampered, this.getTamperedState());
  }

  static override appliesTo(data: DeviceData): boolean {
    return data.Type === VivintDict.PanelDeviceType.WirelessSensor
      && EQUIPMENT_CODES.includes(data.EquipmentCode as number);
  }

  static override inferCategory(data: DeviceData, categories: HapCategories): number {
    return categories.SENSOR;
  }
}
