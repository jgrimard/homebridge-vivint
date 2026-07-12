import type { Categories, PlatformAccessory, Service, WithUUID } from 'homebridge';

/**
 * Structural stand-in for hap-nodejs's Categories, which is a const enum and
 * therefore cannot be passed around as a value in consuming code.
 */
export type HapCategories = { readonly [K in keyof typeof Categories]: number };

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { dataPatch } from '../vivint/datapatch.js';

/**
 * Base class for all Vivint device handlers. A handler wraps one Homebridge
 * accessory, keeps the latest device data from the Vivint API, and pushes
 * state changes into HomeKit.
 */
export abstract class VivintDevice {
  /**
   * Stable class name stored in accessory.context.deviceClassName. Must not
   * change between releases, or cached accessories would be recreated.
   */
  static readonly className: string = 'VivintDevice';

  /** Whether this device type exposes a Battery service. */
  static readonly hasBattery: boolean = false;

  public readonly id: number;
  public readonly name: string;
  public data: DeviceData;

  protected batteryService?: Service;

  constructor(
    protected readonly platform: VivintPlatform,
    protected readonly accessory: PlatformAccessory<VivintAccessoryContext>,
    data: DeviceData | undefined,
  ) {
    this.id = accessory.context.id;
    this.name = accessory.context.name;
    this.data = data ?? { Id: this.id };

    const ctor = this.constructor as typeof VivintDevice;
    if (ctor.hasBattery) {
      this.batteryService = this.ensureService(this.platform.Service.Battery, `${this.name} Battery`);
      this.batteryService.getCharacteristic(this.platform.Characteristic.StatusLowBattery)
        .onGet(() => this.getLowBatteryState());
      this.batteryService.getCharacteristic(this.platform.Characteristic.BatteryLevel)
        .onGet(() => this.getBatteryLevelValue());
    }
  }

  /**
   * Returns the existing service of the given type, adding it first if the
   * cached accessory does not have it yet.
   */
  protected ensureService(type: WithUUID<typeof Service>, name: string): Service {
    const existing = this.accessory.getService(type);
    if (existing) {
      return existing;
    }
    // Concrete service classes take (displayName?, subtype?) — the abstract
    // base type does not reflect that, hence the cast.
    const ServiceCtor = type as unknown as new (displayName?: string) => Service;
    return this.accessory.addService(new ServiceCtor(name));
  }

  protected get Characteristic() {
    return this.platform.Characteristic;
  }

  protected get Service() {
    return this.platform.Service;
  }

  protected get log() {
    return this.platform.log;
  }

  protected get vivintApi() {
    return this.platform.vivintApi;
  }

  protected get config() {
    return this.platform.config;
  }

  getBatteryLevelValue(): number {
    return typeof this.data.BatteryLevel === 'number' ? this.data.BatteryLevel : 100;
  }

  getLowBatteryState(): number {
    const threshold = this.config.lowBatteryLevel;
    const low = threshold
      ? this.getBatteryLevelValue() <= threshold
      : Boolean(this.data.LowBattery);
    return low
      ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  getTamperedState(): number {
    return this.data.Tamper
      ? this.Characteristic.StatusTampered.TAMPERED
      : this.Characteristic.StatusTampered.NOT_TAMPERED;
  }

  /**
   * Replaces the cached data with a full snapshot from the API.
   */
  handleSnapshot(data: DeviceData): void {
    if (data.Id !== this.id) {
      this.log.warn(`Ignoring snapshot for device ${data.Id} delivered to device ${this.id}`);
      return;
    }
    this.data = data;
    this.notifySafely();
  }

  /**
   * Applies an incremental realtime patch to the cached data.
   */
  handlePatch(patch: DeviceData): void {
    if (patch.Id !== this.id) {
      this.log.warn(`Ignoring patch for device ${patch.Id} delivered to device ${this.id}`);
      return;
    }
    dataPatch(this.data, patch);
    this.notifySafely();
  }

  private notifySafely(): void {
    try {
      this.notify();
    } catch (error) {
      // One misbehaving device must never break updates for the others.
      this.log.error(`Error while updating HomeKit state for '${this.name}':`, error);
    }
  }

  /**
   * Pushes the current cached state into HomeKit.
   */
  notify(): void {
    if (this.batteryService) {
      this.batteryService.updateCharacteristic(this.Characteristic.StatusLowBattery, this.getLowBatteryState());
      this.batteryService.updateCharacteristic(this.Characteristic.BatteryLevel, this.getBatteryLevelValue());
    }
  }

  /**
   * Wraps a HomeKit "set" action with uniform error handling: failures are
   * logged with a helpful message and surfaced to HomeKit as a communication
   * failure rather than crashing the plugin.
   */
  protected async runSetAction(description: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.log.error(`Failed to ${description} for '${this.name}':`, error instanceof Error ? error.message : error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** Whether this handler manages the given Vivint device. */
  static appliesTo(data: DeviceData): boolean {
    void data;
    return false;
  }

  /** The HomeKit accessory category to use when first publishing the accessory. */
  static inferCategory(data: DeviceData, categories: HapCategories): number {
    void data;
    return categories.OTHER;
  }
}
