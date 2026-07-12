
import type { DeviceData } from '../types.js';
import { VivintDict } from '../vivint/dictionary.js';
import type { HapCategories } from './device.js';
import { MultiLevelSwitchBase } from './multiLevelSwitchBase.js';

export class LightGroup extends MultiLevelSwitchBase {
  static override readonly className = 'LightGroup';

  static override appliesTo(data: DeviceData): boolean {
    return data.Type === VivintDict.PanelDeviceType.GroupDevices
      && Array.isArray(data.panel_capability_types)
      && data.panel_capability_types.includes(VivintDict.PanelCapabilityType.Dimmable)
      && data.panel_capability_types.includes(VivintDict.PanelCapabilityType.GroupDevices);
  }

  static override inferCategory(data: DeviceData, categories: HapCategories): number {
    return categories.SWITCH;
  }
}
