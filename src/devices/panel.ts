import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { sanitizeDeviceName } from '../utils/sanitizeName.js';
import { VivintDict } from '../vivint/dictionary.js';
import { HapCategories, VivintDevice } from './device.js';

export class Panel extends VivintDevice {
  static override readonly className = 'Panel';
  static override readonly hasBattery = true;

  private readonly service: Service;
  private readonly vivintToHomekit: Record<number, number>;
  private readonly homekitToVivint: Record<number, number>;

  constructor(platform: VivintPlatform, accessory: PlatformAccessory<VivintAccessoryContext>, data: DeviceData | undefined) {
    super(platform, accessory, data);

    this.service = this.ensureService(this.Service.SecuritySystem, sanitizeDeviceName(this.name, this.id));

    const CurrentState = this.Characteristic.SecuritySystemCurrentState;
    const TargetState = this.Characteristic.SecuritySystemTargetState;

    this.vivintToHomekit = {
      [VivintDict.SecurityState.DISARMED]: CurrentState.DISARMED,
      [VivintDict.SecurityState.ARMING_AWAY_IN_EXIT_DELAY]: CurrentState.AWAY_ARM,
      [VivintDict.SecurityState.ARMING_STAY_IN_EXIT_DELAY]: CurrentState.STAY_ARM,
      [VivintDict.SecurityState.ARMED_STAY]: CurrentState.STAY_ARM,
      [VivintDict.SecurityState.ARMED_AWAY]: CurrentState.AWAY_ARM,
      [VivintDict.SecurityState.ARMED_STAY_IN_ENTRY_DELAY]: CurrentState.STAY_ARM,
      [VivintDict.SecurityState.ARMED_AWAY_IN_ENTRY_DELAY]: CurrentState.AWAY_ARM,
      [VivintDict.SecurityState.ALARM]: CurrentState.ALARM_TRIGGERED,
      [VivintDict.SecurityState.ALARM_FIRE]: CurrentState.ALARM_TRIGGERED,
      [VivintDict.SecurityState.DISABLED]: CurrentState.DISARMED,
      [VivintDict.SecurityState.WALK_TEST]: CurrentState.DISARMED,
    };

    this.homekitToVivint = {
      [TargetState.DISARM]: VivintDict.SecurityState.DISARMED,
      [TargetState.STAY_ARM]: VivintDict.SecurityState.ARMED_STAY,
      [TargetState.AWAY_ARM]: VivintDict.SecurityState.ARMED_AWAY,
    };

    this.service.getCharacteristic(CurrentState)
      .setProps({
        validValues: [CurrentState.STAY_ARM, CurrentState.AWAY_ARM, CurrentState.DISARMED, CurrentState.ALARM_TRIGGERED],
      })
      .onGet(() => this.getPanelState());

    this.service.getCharacteristic(TargetState)
      .setProps({
        validValues: [TargetState.STAY_ARM, TargetState.AWAY_ARM, TargetState.DISARM],
      })
      .onSet(value => this.setTargetState(value));
  }

  getPanelState(): number {
    const mapped = this.vivintToHomekit[this.data.Status as number];
    return mapped ?? this.Characteristic.SecuritySystemCurrentState.DISARMED;
  }

  private async setTargetState(targetState: CharacteristicValue): Promise<void> {
    const TargetState = this.Characteristic.SecuritySystemTargetState;
    const vivintState = this.homekitToVivint[targetState as number];

    await this.runSetAction('set the alarm panel state', async () => {
      // Vivint does not support switching directly between Stay and Away,
      // so disarm first when changing between armed modes.
      if (targetState !== TargetState.DISARM
        && this.getPanelState() !== this.Characteristic.SecuritySystemCurrentState.DISARMED) {
        await this.vivintApi.setPanelState(this.homekitToVivint[TargetState.DISARM]);
      }
      await this.vivintApi.setPanelState(vivintState);
    });
  }

  override notify(): void {
    super.notify();
    if (this.data.Status === undefined) {
      return;
    }
    const state = this.getPanelState();
    this.service.updateCharacteristic(this.Characteristic.SecuritySystemCurrentState, state);
    if (state !== this.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED) {
      this.service.updateCharacteristic(this.Characteristic.SecuritySystemTargetState, state);
    }
  }

  static override appliesTo(data: DeviceData): boolean {
    return data.Type === VivintDict.PanelDeviceType.Panel;
  }

  static override inferCategory(data: DeviceData, categories: HapCategories): number {
    return categories.SECURITY_SYSTEM;
  }
}
