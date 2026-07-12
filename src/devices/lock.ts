import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { sanitizeDeviceName } from '../utils/sanitizeName.js';
import { VivintDict } from '../vivint/dictionary.js';
import { HapCategories, VivintDevice } from './device.js';

export class Lock extends VivintDevice {
  static override readonly className = 'Lock';
  static override readonly hasBattery = true;

  private readonly service: Service;

  constructor(platform: VivintPlatform, accessory: PlatformAccessory<VivintAccessoryContext>, data: DeviceData | undefined) {
    super(platform, accessory, data);

    this.service = this.ensureService(this.Service.LockMechanism, sanitizeDeviceName(this.name, this.id));
    this.batteryService?.updateCharacteristic(this.Characteristic.ChargingState, this.Characteristic.ChargingState.NOT_CHARGEABLE);

    this.service.getCharacteristic(this.Characteristic.LockCurrentState)
      .onGet(() => this.getLockState());
    this.service.getCharacteristic(this.Characteristic.LockTargetState)
      .onSet(value => this.setTargetState(value));

    this.notify();
  }

  private async setTargetState(targetState: CharacteristicValue): Promise<void> {
    const locked = targetState === this.Characteristic.LockTargetState.SECURED;
    await this.runSetAction(`set lock state to ${locked ? 'locked' : 'unlocked'}`, () =>
      this.vivintApi.setLockState(this.id, locked));
  }

  getLockState(): number {
    switch (this.data.Status) {
    case false:
      return this.Characteristic.LockCurrentState.UNSECURED;
    case true:
      return this.Characteristic.LockCurrentState.SECURED;
    case this.Characteristic.LockCurrentState.JAMMED:
      return this.Characteristic.LockCurrentState.JAMMED;
    default:
      return this.Characteristic.LockCurrentState.UNKNOWN;
    }
  }

  override notify(): void {
    super.notify();
    const state = this.getLockState();
    this.service.updateCharacteristic(this.Characteristic.LockCurrentState, state);
    this.service.updateCharacteristic(
      this.Characteristic.LockTargetState,
      state === this.Characteristic.LockCurrentState.SECURED
        ? this.Characteristic.LockTargetState.SECURED
        : this.Characteristic.LockTargetState.UNSECURED,
    );
  }

  static override appliesTo(data: DeviceData): boolean {
    return data.Type === VivintDict.PanelDeviceType.DoorLock;
  }

  static override inferCategory(data: DeviceData, categories: HapCategories): number {
    return categories.DOOR_LOCK;
  }
}
