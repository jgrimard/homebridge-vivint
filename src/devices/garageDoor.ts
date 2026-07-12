import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { sanitizeDeviceName } from '../utils/sanitizeName.js';
import { VivintDict } from '../vivint/dictionary.js';
import { HapCategories, VivintDevice } from './device.js';

export class GarageDoor extends VivintDevice {
  static override readonly className = 'GarageDoor';

  private readonly service: Service;

  constructor(platform: VivintPlatform, accessory: PlatformAccessory<VivintAccessoryContext>, data: DeviceData | undefined) {
    super(platform, accessory, data);

    this.service = this.ensureService(this.Service.GarageDoorOpener, sanitizeDeviceName(this.name, this.id));

    this.service.getCharacteristic(this.Characteristic.CurrentDoorState)
      .onGet(() => this.getGarageDoorCurrentState());
    this.service.getCharacteristic(this.Characteristic.TargetDoorState)
      .onGet(() => this.getGarageDoorTargetState())
      .onSet(value => this.setTargetState(value));

    this.notify();
  }

  private async setTargetState(targetState: CharacteristicValue): Promise<void> {
    const closing = targetState === this.Characteristic.TargetDoorState.CLOSED;
    const targetVivintState = closing ? VivintDict.GarageDoorStates.Closing : VivintDict.GarageDoorStates.Opening;
    await this.runSetAction(`${closing ? 'close' : 'open'} the garage door`, () =>
      this.vivintApi.setGarageDoorState(this.id, targetVivintState));
  }

  getGarageDoorCurrentState(): number {
    switch (this.data.Status) {
    case VivintDict.GarageDoorStates.Unknown: // treat unknown as closed to avoid double notifications
    case VivintDict.GarageDoorStates.Closed:
      return this.Characteristic.CurrentDoorState.CLOSED;
    case VivintDict.GarageDoorStates.Closing:
      return this.Characteristic.CurrentDoorState.CLOSING;
    case VivintDict.GarageDoorStates.Opening:
      return this.Characteristic.CurrentDoorState.OPENING;
    case VivintDict.GarageDoorStates.Opened:
      return this.Characteristic.CurrentDoorState.OPEN;
    default:
      return this.Characteristic.CurrentDoorState.STOPPED;
    }
  }

  getGarageDoorTargetState(): number {
    switch (this.data.Status) {
    case VivintDict.GarageDoorStates.Opening:
    case VivintDict.GarageDoorStates.Opened:
      return this.Characteristic.TargetDoorState.OPEN;
    default:
      return this.Characteristic.TargetDoorState.CLOSED;
    }
  }

  override notify(): void {
    super.notify();
    this.service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.getGarageDoorCurrentState());
    this.service.updateCharacteristic(this.Characteristic.TargetDoorState, this.getGarageDoorTargetState());
  }

  static override appliesTo(data: DeviceData): boolean {
    return data.Type === VivintDict.PanelDeviceType.GarageDoor;
  }

  static override inferCategory(data: DeviceData, categories: HapCategories): number {
    return categories.GARAGE_DOOR_OPENER;
  }
}
