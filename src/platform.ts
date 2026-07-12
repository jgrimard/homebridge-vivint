import type {
  API,
  Categories,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import type { HapCategories } from './devices/device.js';
import {
  findHandlerByClassName,
  findHandlerForData,
  IRRELEVANT_DEVICE_TYPES,
  VivintDevice,
} from './devices/index.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { DeviceData, PubNubMessage, VivintAccessoryContext, VivintPlatformConfig } from './types.js';
import { sanitizeDeviceName } from './utils/sanitizeName.js';
import { VivintApiClient, VivintAuthError, VivintRateLimitError } from './vivint/api.js';
import { VivintDict } from './vivint/dictionary.js';
import { VivintEventStream } from './vivint/eventStream.js';

const DEFAULT_API_LOGIN_REFRESH_SECS = 1200;
const MIN_API_LOGIN_REFRESH_SECS = 300;

// Startup retry backoff. Rate-limit responses back off much harder, because
// retrying into a Cloudflare block can extend it to 24 hours.
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const RETRY_RATE_LIMITED_BASE_MS = 5 * 60_000;
const RETRY_RATE_LIMITED_MAX_MS = 60 * 60_000;
const RETRY_AUTH_MS = 60 * 60_000;

type VivintAccessory = PlatformAccessory<VivintAccessoryContext>;

export class VivintPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly config: VivintPlatformConfig;

  public vivintApi!: VivintApiClient;
  public ffmpegPath = 'ffmpeg';

  private readonly cachedAccessories = new Map<string, VivintAccessory>();
  private readonly devices = new Map<number, VivintDevice>();
  private panelDeviceId = 0;
  private lastSnapshotTime = 0;

  private readonly eventStream: VivintEventStream;
  private sessionRefreshTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private shuttingDown = false;

  private pollInFlight = false;
  private pollConsecutiveFailures = 0;
  private pollTicksToSkip = 0;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.config = config as VivintPlatformConfig;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.eventStream = new VivintEventStream(log);

    this.api.on('didFinishLaunching', () => {
      this.initialize().catch(error => this.log.error('Unexpected initialization error:', error));
    });

    this.api.on('shutdown', () => {
      this.shuttingDown = true;
      this.stopTimers();
      this.eventStream.stop();
    });
  }

  /**
   * Called by Homebridge for every accessory restored from cache.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Loading accessory from cache:', accessory.displayName);
    this.cachedAccessories.set(accessory.UUID, accessory as VivintAccessory);
  }

  private get apiLoginRefreshSecs(): number {
    const configured = this.config.apiLoginRefreshSecs ?? DEFAULT_API_LOGIN_REFRESH_SECS;
    if (configured < MIN_API_LOGIN_REFRESH_SECS) {
      this.log.warn(`apiLoginRefreshSecs of ${configured}s is too aggressive and risks Vivint rate limiting; using ${MIN_API_LOGIN_REFRESH_SECS}s.`);
      return MIN_API_LOGIN_REFRESH_SECS;
    }
    return configured;
  }

  private async initialize(): Promise<void> {
    const refreshToken = this.config.refreshToken;
    if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
      this.log.error('No Vivint refresh token is configured. Open the plugin settings in the Homebridge UI '
        + 'and use the sign-in form (it supports Vivint\'s multi-factor authentication) to generate one. '
        + 'Cached accessories will remain visible but will not update.');
      return;
    }

    await this.resolveFfmpegPath();

    this.vivintApi = new VivintApiClient(refreshToken, this.log);
    this.connectWithRetry(1);
  }

  /**
   * Connects to the Vivint API, retrying forever with error-appropriate
   * backoff. The plugin stays alive during Vivint or network outages and
   * recovers on its own.
   */
  private connectWithRetry(attempt: number): void {
    if (this.shuttingDown) {
      return;
    }

    this.vivintApi.connect().then(() => {
      this.log.info('Connected to the Vivint API.');
      this.onConnected();
    }).catch((error: unknown) => {
      let delayMs: number;
      if (error instanceof VivintAuthError) {
        this.log.error(`${error.message} Will re-check once per hour in case the token is updated.`);
        delayMs = RETRY_AUTH_MS;
      } else if (error instanceof VivintRateLimitError) {
        delayMs = Math.min(RETRY_RATE_LIMITED_BASE_MS * 2 ** (attempt - 1), RETRY_RATE_LIMITED_MAX_MS);
        this.log.warn(`${error.message} Retrying in ${Math.round(delayMs / 60000)} minute(s).`);
      } else {
        delayMs = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn(`Could not connect to Vivint (${message}). Retrying in ${Math.round(delayMs / 1000)} second(s).`);
      }
      // Add jitter so many Homebridge instances do not retry in lockstep.
      delayMs = Math.round(delayMs * (0.85 + Math.random() * 0.3));
      this.retryTimer = setTimeout(() => this.connectWithRetry(attempt + 1), delayMs);
      this.retryTimer.unref();
    });
  }

  private onConnected(): void {
    try {
      this.reconcileAccessories();
    } catch (error) {
      this.log.error('Error while setting up accessories:', error);
      return;
    }

    this.handleSnapshot();

    this.eventStream.start(this.vivintApi.messageBroadcastChannel, message => this.handlePubNubMessage(message));

    this.startTimers();
  }

  private async resolveFfmpegPath(): Promise<void> {
    try {
      const mod = await import('ffmpeg-for-homebridge');
      const resolved = typeof mod === 'string' ? mod : mod.default;
      if (typeof resolved === 'string' && resolved.length > 0) {
        this.ffmpegPath = resolved;
      }
    } catch {
      this.log.debug('ffmpeg-for-homebridge binary not available, falling back to ffmpeg from PATH.');
    }
    this.log.debug('Using ffmpeg at:', this.ffmpegPath);
  }

  // ---------------------------------------------------------------------------
  // Accessory lifecycle
  // ---------------------------------------------------------------------------

  /**
   * The UUID seed must stay identical to previous plugin versions so users'
   * existing accessories (rooms, automations, names) survive upgrades.
   */
  private serialFor(data: DeviceData): string {
    const hex = (value?: number) => (value || 0).toString(16).padStart(8, '0');
    return `${hex(data.SerialNumber32Bit)}:${hex(data.SerialNumber)}:${data.Id}`;
  }

  private isIgnored(data: DeviceData): boolean {
    const ignored = this.config.ignoreDeviceTypes ?? [];
    return ignored.includes(data.Type ?? '')
      || ignored.includes(`${data.EquipmentCode}`)
      || ignored.includes(`${data.Id}`);
  }

  private reconcileAccessories(): void {
    const snapshotDevices = this.vivintApi.deviceSnapshot().Devices.filter(data => data.Id);
    const managed: Array<{ data: DeviceData; handlerName: string; uuid: string }> = [];

    for (const data of snapshotDevices) {
      if (IRRELEVANT_DEVICE_TYPES.includes(data.Type ?? '')) {
        this.log.debug(`Skipping unusable device [Type]:${data.Type} [ID]:${data.Id}`);
        continue;
      }

      const handler = findHandlerForData(data);
      if (!handler) {
        this.log.info(`Device not (yet) supported [ID]:${data.Id} [Type]:${data.Type} [EquipmentCode]:${data.EquipmentCode} [Name]:${data.Name}`);
        continue;
      }

      if (this.isIgnored(data)) {
        this.log.info(`Ignored device [ID]:${data.Id} [Type]:${data.Type} [EquipmentCode]:${data.EquipmentCode} [Name]:${data.Name}`);
        continue;
      }

      if (this.config.logDeviceList === true) {
        this.log.info(`Managing device [ID]:${data.Id} [Type]:${data.Type} [EquipmentCode]:${data.EquipmentCode} [Name]:${data.Name}`);
      }

      const uuid = this.api.hap.uuid.generate(`Vivint:${data.Id}:${this.serialFor(data)}`);
      managed.push({ data, handlerName: handler.className, uuid });
    }

    // Remove cached accessories that are stale, changed type, or are cameras
    // that must be re-published because camera streaming was toggled off.
    const removed: VivintAccessory[] = [];
    for (const [uuid, accessory] of this.cachedAccessories) {
      const match = managed.find(m => m.uuid === uuid);
      const typeChanged = match && match.handlerName !== accessory.context.deviceClassName;
      const cameraDisabled = match && this.config.disableCameras === true
        && accessory.getService(this.Service.CameraRTPStreamManagement) !== undefined;

      if (!match || typeChanged || cameraDisabled) {
        removed.push(accessory);
        this.cachedAccessories.delete(uuid);
      }
    }
    if (removed.length > 0) {
      this.log.info(`Removing ${removed.length} accessories`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, removed);
    }

    // Create and register accessories that are not in the cache.
    const added: VivintAccessory[] = [];
    for (const { data, handlerName, uuid } of managed) {
      let accessory = this.cachedAccessories.get(uuid);
      if (!accessory) {
        accessory = this.createAccessory(data, handlerName, uuid);
        added.push(accessory);
        this.cachedAccessories.set(uuid, accessory);
      }
      this.bindAccessory(accessory, data);
    }
    if (added.length > 0) {
      this.log.info(`Adding ${added.length} accessories`);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, added);
    }
  }

  private createAccessory(data: DeviceData, handlerName: string, uuid: string): VivintAccessory {
    const handler = findHandlerByClassName(handlerName)!;
    // Categories is a const enum in hap-nodejs; go through a structural cast
    // to use its runtime object as a value.
    const hapCategories = (this.api.hap as unknown as { Categories: HapCategories }).Categories;
    const category = handler.inferCategory(data, hapCategories) as Categories;
    const deviceName = sanitizeDeviceName(data.Name, data.Id);
    const serial = this.serialFor(data);

    const accessory = new this.api.platformAccessory(deviceName, uuid, category) as VivintAccessory;
    accessory.context.name = deviceName;
    accessory.context.id = data.Id;
    accessory.context.deviceClassName = handlerName;
    accessory.context.serial = serial;

    let manufacturer = 'Vivint';
    let model = data.EquipmentCode !== undefined
      ? this.vivintApi.getDictionaryKeyByValue(VivintDict.EquipmentCode, data.EquipmentCode) ?? handlerName
      : handlerName;

    // Devices bridged from other ecosystems report their origin in ActualType.
    if (data.ActualType) {
      const parts = data.ActualType.split('_');
      if (parts.length > 0) {
        manufacturer = parts[0].toUpperCase();
      }
      if (parts.length > 1) {
        model = parts[1].toUpperCase();
      }
    }

    const informationService = accessory.getService(this.Service.AccessoryInformation)!;
    informationService
      .setCharacteristic(this.Characteristic.Manufacturer, manufacturer)
      .setCharacteristic(this.Characteristic.Model, model)
      .setCharacteristic(this.Characteristic.SerialNumber, serial);

    const firmware = data.CurrentSoftwareVersion || data.SoftwareVersion;
    if (firmware) {
      informationService.setCharacteristic(this.Characteristic.FirmwareRevision, firmware);
    }

    return accessory;
  }

  private bindAccessory(accessory: VivintAccessory, data: DeviceData): void {
    const handler = findHandlerByClassName(accessory.context.deviceClassName);
    if (!handler) {
      this.log.warn(`Unknown device class '${accessory.context.deviceClassName}' for accessory '${accessory.displayName}', skipping.`);
      return;
    }
    try {
      const device = new handler(this, accessory, data);
      this.devices.set(device.id, device);
      if (accessory.context.deviceClassName === 'Panel') {
        this.panelDeviceId = device.id;
      }
    } catch (error) {
      this.log.error(`Failed to set up accessory '${accessory.displayName}':`, error);
    }
  }

  // ---------------------------------------------------------------------------
  // State updates
  // ---------------------------------------------------------------------------

  private handleSnapshot(): void {
    const snapshot = this.vivintApi.deviceSnapshot();
    this.lastSnapshotTime = this.vivintApi.deviceSnapshotTs();
    this.log.debug(`Handling device snapshot for timestamp ${this.lastSnapshotTime}`);

    // The partition-level security status lives on the panel device in HomeKit.
    const panelData = snapshot.Devices.find(device => device.Id === this.panelDeviceId);
    if (panelData) {
      panelData.Status = snapshot.Status;
    }

    for (const [deviceId, device] of this.devices) {
      const data = snapshot.Devices.find(item => item.Id === deviceId);
      if (data) {
        device.handleSnapshot(data);
      }
    }
  }

  private handlePubNubMessage(rawMessage: object): void {
    const message: PubNubMessage = this.vivintApi.parsePubNub(rawMessage);
    this.log.debug('Parsed PubNub message:', JSON.stringify(message));

    if (!message.Data) {
      return;
    }

    // Messages from Nest and MyQ devices do not carry PlatformContext info.
    const messageTimestamp = message.Data.PlatformContext?.Timestamp;
    if (messageTimestamp !== undefined && messageTimestamp < this.lastSnapshotTime) {
      this.log.debug('Ignoring stale realtime update', messageTimestamp, '<', this.lastSnapshotTime);
      return;
    }

    if (message.Id === this.vivintApi.panelId && message.Data.Status !== undefined) {
      // Partition-level arm state change; route it to the panel device.
      message.Data.Devices = [{
        Id: this.panelDeviceId,
        Status: message.Data.Status,
      }];
    } else if (message.Type === VivintDict.ObjectType.InboxMessage
      && typeof message.Data.Subject === 'string'
      && message.Data.Subject.includes('failed to lock')) {
      // "Alert: <name> failed to lock" inbox messages indicate a jammed lock.
      const lockName = message.Data.Subject.split('Alert: ')[1]?.split(' failed to lock')[0];
      const lockDevice = [...this.devices.values()].find(device =>
        device.data.Type === VivintDict.PanelDeviceType.DoorLock && device.name === lockName);
      if (lockDevice) {
        message.Data.Devices = [{
          Id: lockDevice.id,
          Status: this.Characteristic.LockCurrentState.JAMMED,
        }];
      }
    }

    for (const patch of message.Data.Devices ?? []) {
      this.devices.get(patch.Id)?.handlePatch(patch);
    }
  }

  // ---------------------------------------------------------------------------
  // Periodic refresh
  // ---------------------------------------------------------------------------

  private startTimers(): void {
    this.stopTimers();
    const refreshSecs = this.apiLoginRefreshSecs;

    // Session renewal keeps the auth cookie fresh; failures are retried on
    // the next cycle rather than in a tight loop.
    this.sessionRefreshTimer = setInterval(() => {
      this.vivintApi.renewSession()
        .then(() => this.vivintApi.renewPanelLogin())
        .catch(error => {
          if (error instanceof VivintAuthError) {
            this.log.error(error.message);
          } else {
            this.log.warn('Could not renew the Vivint session (will retry on the next cycle):',
              error instanceof Error ? error.message : error);
          }
        });
    }, refreshSecs * 1000);
    this.sessionRefreshTimer.unref();

    // Periodic snapshot polling keeps the realtime notification stream active
    // and reconverges state after missed events.
    this.pollTimer = setInterval(() => this.pollSystemInfo(), (refreshSecs / 20) * 1000);
    this.pollTimer.unref();
  }

  private stopTimers(): void {
    for (const timer of [this.sessionRefreshTimer, this.pollTimer, this.retryTimer]) {
      if (timer) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    }
    this.sessionRefreshTimer = this.pollTimer = this.retryTimer = undefined;
  }

  private async pollSystemInfo(): Promise<void> {
    if (this.pollInFlight) {
      return;
    }
    // After repeated failures, skip an exponentially growing number of ticks
    // so an outage does not turn into a stream of doomed API requests.
    if (this.pollTicksToSkip > 0) {
      this.pollTicksToSkip--;
      return;
    }

    this.pollInFlight = true;
    try {
      await this.vivintApi.renewSystemInfo();
      this.handleSnapshot();
      if (this.pollConsecutiveFailures > 0) {
        this.log.info('Vivint API polling recovered.');
      }
      this.pollConsecutiveFailures = 0;
    } catch (error) {
      this.pollConsecutiveFailures++;
      this.pollTicksToSkip = Math.min(2 ** this.pollConsecutiveFailures, 32) - 1;
      if (error instanceof VivintRateLimitError) {
        this.pollTicksToSkip = Math.max(this.pollTicksToSkip, 16);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.pollConsecutiveFailures === 1) {
        this.log.warn(`Could not refresh device states (${message}). Backing off; realtime updates may still arrive.`);
      } else {
        this.log.debug(`Device state refresh still failing (attempt ${this.pollConsecutiveFailures}): ${message}`);
      }
    } finally {
      this.pollInFlight = false;
    }
  }
}
