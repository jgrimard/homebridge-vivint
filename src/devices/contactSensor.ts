import type { PlatformAccessory, Service } from 'homebridge';

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { sanitizeDeviceName } from '../utils/sanitizeName.js';
import { VivintDict } from '../vivint/dictionary.js';
import { HapCategories, VivintDevice } from './device.js';

const EQUIPMENT_CODES = [
  'DW21R_RECESSED_DOOR',
  'DW10_THIN_DOOR_WINDOW',
  'DW11_THIN_DOOR_WINDOW',
  'DW20_RECESSED_DOOR',
  'EXISTING_DOOR_WINDOW_CONTACT',
  'TAKE_TAKEOVER',
  'GB1_GLASS_BREAK',
  'GB2_GLASS_BREAK',
  'EXISTING_GLASS_BREAK',
  'HW_GLASS_BREAK_5853',
  'TILT_SENSOR_2GIG_345',
  'EXISTING_HEAT',
  'EXISTING_FLOOD_TEMP',
  'SWS1_SMART_WATER_SENSOR',
  'DW12_THIN_DOOR_WINDOW',
  'GB3_GLASS_BREAK',
  'PIR3_MOTION',
  'APOLLO_COMBO_SMOKE',
  'APOLLO_COMBO_CO',
  'GARAGE01_RESOLUTION_TILT',
].map(name => VivintDict.EquipmentCode[name]);

export class ContactSensor extends VivintDevice {
  static override readonly className = 'ContactSensor';
  static override readonly hasBattery = true;

  private readonly service: Service;

  constructor(platform: VivintPlatform, accessory: PlatformAccessory<VivintAccessoryContext>, data: DeviceData | undefined) {
    super(platform, accessory, data);

    this.service = this.ensureService(this.Service.ContactSensor, sanitizeDeviceName(this.name, this.id));
    this.batteryService?.updateCharacteristic(this.Characteristic.ChargingState, this.Characteristic.ChargingState.NOT_CHARGEABLE);

    this.service.getCharacteristic(this.Characteristic.ContactSensorState)
      .onGet(() => this.getSensorState());
    this.service.getCharacteristic(this.Characteristic.StatusTampered)
      .onGet(() => this.getTamperedState());

    this.notify();
  }

  getSensorState(): number {
    return this.data.Status
      ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  override notify(): void {
    super.notify();
    this.service.updateCharacteristic(this.Characteristic.ContactSensorState, this.getSensorState());
    this.service.updateCharacteristic(this.Characteristic.StatusTampered, this.getTamperedState());
  }

  static override appliesTo(data: DeviceData): boolean {
    return data.Type === VivintDict.PanelDeviceType.WirelessSensor
      && EQUIPMENT_CODES.includes(data.EquipmentCode as number);
  }

  static override inferCategory(data: DeviceData, categories: HapCategories): number {
    const name = data.Name ?? '';
    if (name.match(/\bwindow\b/i)) {
      return categories.WINDOW;
    } else if (name.match(/\bdoor(way)?\b/i)) {
      return categories.DOOR;
    }
    return categories.SENSOR;
  }
}
