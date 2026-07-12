import type { PlatformAccessory, Service } from 'homebridge';

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { sanitizeDeviceName } from '../utils/sanitizeName.js';
import { VivintDict } from '../vivint/dictionary.js';
import { HapCategories, VivintDevice } from './device.js';

const EQUIPMENT_CODES = [
  'VS_CO3_DETECTOR',
  'EXISTING_CO',
  'CO1_CO_CANADA',
  'CO1_CO',
  'CO3_2GIG_CO',
  'CARBON_MONOXIDE_DETECTOR_345_MHZ',
].map(name => VivintDict.EquipmentCode[name]);

export class CarbonMonoxideSensor extends VivintDevice {
  static override readonly className = 'CarbonMonoxideSensor';
  static override readonly hasBattery = true;

  private readonly service: Service;

  constructor(platform: VivintPlatform, accessory: PlatformAccessory<VivintAccessoryContext>, data: DeviceData | undefined) {
    super(platform, accessory, data);

    this.service = this.ensureService(this.Service.CarbonMonoxideSensor, sanitizeDeviceName(this.name, this.id));
    this.batteryService?.updateCharacteristic(this.Characteristic.ChargingState, this.Characteristic.ChargingState.NOT_CHARGEABLE);

    this.service.getCharacteristic(this.Characteristic.CarbonMonoxideDetected)
      .onGet(() => this.getSensorState());
    this.service.getCharacteristic(this.Characteristic.StatusTampered)
      .onGet(() => this.getTamperedState());

    this.notify();
  }

  getSensorState(): number {
    return this.data.Status
      ? this.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
      : this.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
  }

  override notify(): void {
    super.notify();
    this.service.updateCharacteristic(this.Characteristic.CarbonMonoxideDetected, this.getSensorState());
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
