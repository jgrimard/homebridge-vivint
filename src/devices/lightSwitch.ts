import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { sanitizeDeviceName } from '../utils/sanitizeName.js';
import { VivintDict } from '../vivint/dictionary.js';
import { HapCategories, VivintDevice } from './device.js';

/**
 * Binary Z-Wave switch. Exposed as a lightbulb, fan or plain switch depending
 * on the device name.
 */
export class LightSwitch extends VivintDevice {
  static override readonly className = 'LightSwitch';

  private readonly service: Service;

  constructor(platform: VivintPlatform, accessory: PlatformAccessory<VivintAccessoryContext>, data: DeviceData | undefined) {
    super(platform, accessory, data);

    const sanitizedName = sanitizeDeviceName(this.name, this.id);
    if (this.name.match(/\blight\b/i)) {
      this.service = this.ensureService(this.Service.Lightbulb, sanitizedName);
    } else if (this.name.match(/\bfan\b/i)) {
      this.service = this.ensureService(this.Service.Fan, sanitizedName);
    } else {
      this.service = this.ensureService(this.Service.Switch, sanitizedName);
    }

    this.service.getCharacteristic(this.Characteristic.On)
      .onGet(() => Boolean(this.data.Status))
      .onSet(value => this.setSwitchState(value));
  }

  private async setSwitchState(targetState: CharacteristicValue): Promise<void> {
    const on = Boolean(targetState);
    await this.runSetAction(`turn the switch ${on ? 'on' : 'off'}`, () =>
      this.vivintApi.putDevice('switches', this.id, { s: on, _id: this.id }));
  }

  override notify(): void {
    super.notify();
    this.service.updateCharacteristic(this.Characteristic.On, Boolean(this.data.Status));
  }

  static override appliesTo(data: DeviceData): boolean {
    return data.Type === VivintDict.PanelDeviceType.BinarySwitch;
  }

  static override inferCategory(data: DeviceData, categories: HapCategories): number {
    return categories.SWITCH;
  }
}
