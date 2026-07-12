import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { debounceLeading } from '../utils/debounce.js';
import { sanitizeDeviceName } from '../utils/sanitizeName.js';
import { VivintDevice } from './device.js';

const BRIGHTNESS_DEBOUNCE_MS = 500;

/**
 * Shared behavior for dimmable devices (dimmer switches and Philips Hue light
 * groups). Exposed as a fan with rotation speed when the device name contains
 * "fan", otherwise as a dimmable lightbulb.
 */
export abstract class MultiLevelSwitchBase extends VivintDevice {
  protected readonly service: Service;
  private readonly isFan: boolean;
  private lastOnState?: unknown;
  private lastLevel?: number;
  private readonly setLevelDebounced: (level: number) => Promise<void>;

  constructor(platform: VivintPlatform, accessory: PlatformAccessory<VivintAccessoryContext>, data: DeviceData | undefined) {
    super(platform, accessory, data);

    const sanitizedName = sanitizeDeviceName(this.name, this.id);
    this.isFan = Boolean(this.name.match(/\bfan\b/i));
    this.service = this.isFan
      ? this.ensureService(this.Service.Fan, sanitizedName)
      : this.ensureService(this.Service.Lightbulb, sanitizedName);

    this.service.getCharacteristic(this.Characteristic.On)
      .onGet(() => Boolean(this.data.Status))
      .onSet(value => this.setSwitchState(value));

    // Dragging the brightness/speed slider produces a burst of set requests;
    // debounce them so only the first and final values reach the Vivint API.
    this.setLevelDebounced = debounceLeading(
      (level: number) => this.vivintApi.putDevice('switches', this.id, { val: level, _id: this.id }),
      BRIGHTNESS_DEBOUNCE_MS,
    );

    const levelCharacteristic = this.isFan ? this.Characteristic.RotationSpeed : this.Characteristic.Brightness;
    this.service.getCharacteristic(levelCharacteristic)
      .onGet(() => this.data.Value ?? 0)
      .onSet(value => this.setLevel(value));
  }

  private async setSwitchState(targetState: CharacteristicValue): Promise<void> {
    const on = Boolean(targetState);
    await this.runSetAction(`turn ${on ? 'on' : 'off'}`, () =>
      this.vivintApi.putDevice('switches', this.id, { s: on, _id: this.id }));
  }

  private async setLevel(value: CharacteristicValue): Promise<void> {
    await this.runSetAction(`set the level to ${value}`, () => this.setLevelDebounced(value as number));
  }

  override notify(): void {
    super.notify();

    // Vivint typically sends each change twice; only push actual changes.
    if (this.data.Value !== this.lastLevel) {
      this.lastLevel = this.data.Value;
      const levelCharacteristic = this.isFan ? this.Characteristic.RotationSpeed : this.Characteristic.Brightness;
      this.service.updateCharacteristic(levelCharacteristic, this.data.Value ?? 0);
    }

    if (this.data.Status !== this.lastOnState) {
      this.lastOnState = this.data.Status;
      this.service.updateCharacteristic(this.Characteristic.On, Boolean(this.data.Status));
    }
  }
}
