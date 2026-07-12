import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { debounceLeading } from '../utils/debounce.js';
import { sanitizeDeviceName } from '../utils/sanitizeName.js';
import { VivintDict } from '../vivint/dictionary.js';
import { HapCategories, VivintDevice } from './device.js';

const SET_POINT_DEBOUNCE_MS = 2000;

export class Thermostat extends VivintDevice {
  static override readonly className = 'Thermostat';

  private readonly service: Service;
  private readonly fanService: Service;
  private readonly setHeatSetPointDebounced: (temperature: number) => Promise<void>;
  private readonly setCoolSetPointDebounced: (temperature: number) => Promise<void>;

  constructor(platform: VivintPlatform, accessory: PlatformAccessory<VivintAccessoryContext>, data: DeviceData | undefined) {
    super(platform, accessory, data);

    const sanitizedName = sanitizeDeviceName(this.name, this.id);
    this.service = this.ensureService(this.Service.Thermostat, sanitizedName);
    this.fanService = this.ensureService(this.Service.Fan, `${sanitizedName} fan`);

    this.setHeatSetPointDebounced = debounceLeading(
      (temperature: number) => this.vivintApi.setThermostatHeatSetPoint(this.id, temperature),
      SET_POINT_DEBOUNCE_MS,
    );
    this.setCoolSetPointDebounced = debounceLeading(
      (temperature: number) => this.vivintApi.setThermostatCoolSetPoint(this.id, temperature),
      SET_POINT_DEBOUNCE_MS,
    );

    /*
     * Only allow small increments for Celsius temperatures. HomeKit is already
     * limited to 1-degree increments in Fahrenheit, and a coarser step for
     * Fahrenheit causes HomeKit to round incorrectly when converting °F <-> °C.
     */
    let minSetTemp: number, maxSetTemp: number, minGetTemp: number, maxGetTemp: number;
    const tempStep = 0.1;
    if (this.isCelsius()) {
      minSetTemp = 10;
      maxSetTemp = 32;
      minGetTemp = -20;
      maxGetTemp = 60;
    } else {
      minSetTemp = this.fahrenheitToCelsius(50);
      maxSetTemp = this.fahrenheitToCelsius(90);
      minGetTemp = this.fahrenheitToCelsius(0);
      maxGetTemp = this.fahrenheitToCelsius(160);
    }

    this.service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.getOperatingState());

    this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .onGet(() => this.getOperatingMode())
      .onSet(value => this.setTargetHeatingCoolingState(value));

    this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minStep: tempStep, minValue: minGetTemp, maxValue: maxGetTemp })
      .onGet(() => this.getTemperatureValue());

    this.service.getCharacteristic(this.Characteristic.TargetTemperature)
      .setProps({ minStep: tempStep, minValue: minSetTemp, maxValue: maxSetTemp })
      .onGet(() => this.getTargetTemperatureValue())
      .onSet(value => this.setTargetTemperature(value));

    this.service.getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.getHumidityValue());

    this.service.getCharacteristic(this.Characteristic.CoolingThresholdTemperature)
      .setProps({ minStep: tempStep, minValue: minSetTemp, maxValue: maxSetTemp })
      .onGet(() => this.getCoolingThresholdTemperatureValue())
      .onSet(value => this.setCoolingThresholdTemperature(value));

    this.service.getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
      .setProps({ minStep: tempStep, minValue: minSetTemp, maxValue: maxSetTemp })
      .onGet(() => this.getHeatingThresholdTemperatureValue())
      .onSet(value => this.setHeatingThresholdTemperature(value));

    this.service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.getTemperatureDisplayUnits());

    this.fanService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.getFanState())
      .onSet(value => this.setFanOn(value));
  }

  getOperatingState(): number {
    switch (this.data.OperatingState) {
    case VivintDict.OperatingStates.HEATING:
      return this.Characteristic.CurrentHeatingCoolingState.HEAT;
    case VivintDict.OperatingStates.COOLING:
      return this.Characteristic.CurrentHeatingCoolingState.COOL;
    case VivintDict.OperatingStates.IDLE:
    default:
      return this.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  getOperatingMode(): number {
    switch (this.data.OperatingMode) {
    case VivintDict.OperatingModes.HEAT:
      return this.Characteristic.TargetHeatingCoolingState.HEAT;
    case VivintDict.OperatingModes.COOL:
      return this.Characteristic.TargetHeatingCoolingState.COOL;
    case VivintDict.OperatingModes.AUTO:
    case VivintDict.OperatingModes.ECO:
      return this.Characteristic.TargetHeatingCoolingState.AUTO;
    case VivintDict.OperatingModes.OFF:
    default:
      return this.Characteristic.TargetHeatingCoolingState.OFF;
    }
  }

  private async setTargetHeatingCoolingState(state: CharacteristicValue): Promise<void> {
    let setValue = VivintDict.OperatingModes.OFF;
    switch (state) {
    case this.Characteristic.TargetHeatingCoolingState.HEAT:
      setValue = VivintDict.OperatingModes.HEAT;
      break;
    case this.Characteristic.TargetHeatingCoolingState.COOL:
      setValue = VivintDict.OperatingModes.COOL;
      break;
    case this.Characteristic.TargetHeatingCoolingState.AUTO:
      setValue = VivintDict.OperatingModes.AUTO;
      break;
    }
    await this.runSetAction('set the thermostat mode', () => this.vivintApi.setThermostatState(this.id, setValue));
  }

  getTemperatureValue(): number {
    return this.unroundTemperature(this.data.Value ?? 0);
  }

  getTargetTemperatureValue(): number {
    switch (this.getOperatingMode()) {
    case this.Characteristic.TargetHeatingCoolingState.HEAT:
      return this.getHeatSetPoint();
    case this.Characteristic.TargetHeatingCoolingState.COOL:
      return this.getCoolSetPoint();
    default:
      return this.getTemperatureValue();
    }
  }

  private async setTargetTemperature(temperature: CharacteristicValue): Promise<void> {
    switch (this.getOperatingMode()) {
    case this.Characteristic.TargetHeatingCoolingState.HEAT:
      await this.runSetAction(`set the target temperature to ${temperature}`, () =>
        this.setHeatSetPointDebounced(temperature as number));
      break;
    case this.Characteristic.TargetHeatingCoolingState.COOL:
      await this.runSetAction(`set the target temperature to ${temperature}`, () =>
        this.setCoolSetPointDebounced(temperature as number));
      break;
    default:
      // Target temperature cannot be set while off or in auto mode.
      break;
    }
  }

  getCoolingThresholdTemperatureValue(): number {
    switch (this.getOperatingMode()) {
    case this.Characteristic.TargetHeatingCoolingState.OFF:
      return this.getTemperatureValue();
    case this.Characteristic.TargetHeatingCoolingState.HEAT:
      return this.getHeatSetPoint();
    default:
      return this.getCoolSetPoint();
    }
  }

  getCoolSetPoint(): number {
    return this.unroundTemperature(this.data.CoolSetPoint ?? 0);
  }

  private async setCoolingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    await this.runSetAction(`set the cooling threshold to ${value}`, () =>
      this.setCoolSetPointDebounced(value as number));
  }

  getHeatingThresholdTemperatureValue(): number {
    switch (this.getOperatingMode()) {
    case this.Characteristic.TargetHeatingCoolingState.OFF:
      return this.getTemperatureValue();
    case this.Characteristic.TargetHeatingCoolingState.COOL:
      return this.getCoolSetPoint();
    default:
      return this.getHeatSetPoint();
    }
  }

  getHeatSetPoint(): number {
    return this.unroundTemperature(this.data.HeatSetPoint ?? 0);
  }

  private async setHeatingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    await this.runSetAction(`set the heating threshold to ${value}`, () =>
      this.setHeatSetPointDebounced(value as number));
  }

  getHumidityValue(): number {
    return typeof this.data.Humidity === 'number' ? this.data.Humidity : 0;
  }

  getFanState(): boolean {
    return this.data.FanState === 1;
  }

  private async setFanOn(fanOn: CharacteristicValue): Promise<void> {
    const fanState = fanOn ? 100 : 0;
    await this.runSetAction(`turn the fan ${fanOn ? 'on' : 'off'}`, () =>
      this.vivintApi.setThermostatFanState(this.id, fanState));
  }

  getTemperatureDisplayUnits(): number {
    return this.isCelsius()
      ? this.Characteristic.TemperatureDisplayUnits.CELSIUS
      : this.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
  }

  isCelsius(): boolean {
    return Boolean(this.data.TemperatureCelsius);
  }

  /**
   * Vivint reports temperatures in Celsius. For Fahrenheit thermostats, round
   * to the nearest whole °F and convert back so HomeKit shows clean values.
   */
  private unroundTemperature(temperature: number): number {
    if (this.isCelsius()) {
      return 0.5 * Math.round(2 * temperature);
    }
    return this.fahrenheitToCelsius(Math.round(this.celsiusToFahrenheit(temperature)));
  }

  private fahrenheitToCelsius(temperature: number): number {
    return (temperature - 32) / 1.8;
  }

  private celsiusToFahrenheit(temperature: number): number {
    return temperature * 1.8 + 32;
  }

  override notify(): void {
    this.service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.getOperatingState());
    this.service.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.getOperatingMode());
    this.service.updateCharacteristic(this.Characteristic.CurrentTemperature, this.getTemperatureValue());
    this.service.updateCharacteristic(this.Characteristic.TargetTemperature, this.getTargetTemperatureValue());
    this.service.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, this.getHumidityValue());
    this.service.updateCharacteristic(this.Characteristic.CoolingThresholdTemperature, this.getCoolingThresholdTemperatureValue());
    this.service.updateCharacteristic(this.Characteristic.HeatingThresholdTemperature, this.getHeatingThresholdTemperatureValue());
    this.service.updateCharacteristic(this.Characteristic.TemperatureDisplayUnits, this.getTemperatureDisplayUnits());
    this.fanService.updateCharacteristic(this.Characteristic.On, this.getFanState());
  }

  static override appliesTo(data: DeviceData): boolean {
    return data.Type === VivintDict.PanelDeviceType.Thermostat;
  }

  static override inferCategory(data: DeviceData, categories: HapCategories): number {
    return categories.THERMOSTAT;
  }
}
