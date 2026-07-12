
import type { DeviceData } from '../types.js';
import { VivintDict } from '../vivint/dictionary.js';
import type { HapCategories } from './device.js';
import { MultiLevelSwitchBase } from './multiLevelSwitchBase.js';

export class DimmerSwitch extends MultiLevelSwitchBase {
  static override readonly className = 'DimmerSwitch';

  static override appliesTo(data: DeviceData): boolean {
    return data.Type === VivintDict.PanelDeviceType.MultiLevelSwitch;
  }

  static override inferCategory(data: DeviceData, categories: HapCategories): number {
    return categories.SWITCH;
  }
}
