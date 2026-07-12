import type { Logging } from 'homebridge';

import type { PartitionSnapshot, PubNubMessage } from '../types.js';
import { VivintDict, getKeyByValueDeep, mapObject } from './dictionary.js';

const VIVINT_API_URL = 'https://www.vivintsky.com/api';
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Generic error raised for failed Vivint API calls.
 */
export class VivintApiError extends Error {
  constructor(message: string, readonly statusCode?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VivintApiError';
  }
}

/**
 * The session token is missing, expired or revoked. The user must sign in
 * again through the plugin settings UI.
 */
export class VivintAuthError extends VivintApiError {
  constructor(message: string, statusCode?: number) {
    super(message, statusCode);
    this.name = 'VivintAuthError';
  }
}

/**
 * Vivint (or its Cloudflare front end) is throttling or blocking us. Callers
 * must back off aggressively to avoid a long-term block.
 */
export class VivintRateLimitError extends VivintApiError {
  constructor(message: string, statusCode?: number) {
    super(message, statusCode);
    this.name = 'VivintRateLimitError';
  }
}

interface SessionInfo {
  Users: {
    MessageBroadcastChannel: string;
    System: Array<{ PanelId: number }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface SystemInfo {
  System: {
    Partitions: Array<PartitionSnapshot & { PartitionId: number }>;
    PanelContext: { Timestamp: number };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface PanelLogin {
  Name: string;
  Password: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Client for the Vivint Sky API.
 *
 * Authentication uses a long-lived session cookie ("refresh token") obtained
 * through the MFA sign-in flow in the plugin settings UI. The token is kept
 * private and never written to the logs.
 */
export class VivintApiClient {
  private refreshToken: string;
  private sessionInfo!: SessionInfo;
  private systemInfo!: SystemInfo;
  private renewSessionInFlight?: Promise<void>;

  public panelId = 0;
  public partitionId = 0;
  public panelLogin?: PanelLogin;

  constructor(refreshToken: string, private readonly log: Logging) {
    this.refreshToken = refreshToken.trim();
  }

  /**
   * Authenticates and loads the initial system state. Must be called (and
   * must succeed) before any other method is used.
   */
  async connect(): Promise<void> {
    await this.authenticate();

    const system = this.sessionInfo.Users?.System;
    if (!Array.isArray(system) || system.length === 0 || !system[0].PanelId) {
      throw new VivintApiError('Vivint account has no panel associated with it');
    }
    this.panelId = system[0].PanelId;

    const [systemInfo, panelLogin] = await Promise.all([
      this.fetchSystemInfo(),
      this.fetchPanelLogin(),
    ]);
    this.applySystemInfo(systemInfo);
    this.panelLogin = panelLogin;
  }

  /**
   * The PubNub channel suffix for this account's realtime event stream.
   */
  get messageBroadcastChannel(): string {
    return this.sessionInfo.Users.MessageBroadcastChannel;
  }

  deviceSnapshot(): PartitionSnapshot {
    return this.systemInfo.System.Partitions[0];
  }

  deviceSnapshotTs(): number {
    return this.systemInfo.System.PanelContext.Timestamp;
  }

  parsePubNub(message: object): PubNubMessage {
    return mapObject(message as Record<string, unknown>);
  }

  getDictionaryKeyByValue(dictionary: Record<string, unknown>, value: unknown): string | undefined {
    return getKeyByValueDeep(dictionary, value);
  }

  /**
   * Renews the session cookie. Concurrent calls are coalesced into a single
   * request so a burst of 401s cannot stampede the auth endpoint.
   */
  renewSession(): Promise<void> {
    if (!this.renewSessionInFlight) {
      this.renewSessionInFlight = this.authenticate().finally(() => {
        this.renewSessionInFlight = undefined;
      });
    }
    return this.renewSessionInFlight;
  }

  /**
   * Refreshes the cached system snapshot. This periodic call also keeps the
   * realtime notification stream active on Vivint's side.
   */
  async renewSystemInfo(): Promise<void> {
    this.applySystemInfo(await this.fetchSystemInfo());
  }

  /**
   * Refreshes the panel's local RTSP credentials used for camera streaming.
   */
  async renewPanelLogin(): Promise<void> {
    this.panelLogin = await this.fetchPanelLogin();
  }

  async setGarageDoorState(garageDoorId: number, newState: number): Promise<void> {
    await this.putDevice('door', garageDoorId, { [VivintDict.Fields.Id]: garageDoorId, [VivintDict.Fields.Status]: newState });
  }

  async setLockState(lockId: number, locked: boolean): Promise<void> {
    await this.putDevice('locks', lockId, { [VivintDict.Fields.Id]: lockId, [VivintDict.Fields.Status]: locked });
  }

  async setPanelState(newState: number): Promise<void> {
    await this.putDevice('armedstates', null, { armState: newState, forceArm: false });
  }

  async setThermostatFanState(thermostatId: number, newState: number): Promise<void> {
    await this.putDevice('thermostats', thermostatId, { [VivintDict.Fields.FanMode]: newState });
  }

  async setThermostatState(thermostatId: number, newState: number): Promise<void> {
    await this.putDevice('thermostats', thermostatId, { [VivintDict.Fields.OperatingMode]: newState });
  }

  async setThermostatHeatSetPoint(thermostatId: number, newTemperature: number): Promise<void> {
    await this.putDevice('thermostats', thermostatId, { [VivintDict.Fields.HeatSetPoint]: newTemperature });
  }

  async setThermostatCoolSetPoint(thermostatId: number, newTemperature: number): Promise<void> {
    await this.putDevice('thermostats', thermostatId, { [VivintDict.Fields.CoolSetPoint]: newTemperature });
  }

  async setSensorBypass(sensorId: number, bypassState: number): Promise<void> {
    await this.putDevice('sensors', sensorId, { [VivintDict.Fields.Bypassed]: bypassState });
  }

  /**
   * Sends a device state change. The alarm panel itself has no device id and
   * is addressed at the partition level (pass id = null).
   */
  async putDevice(category: string, id: number | null, data: Record<string, unknown>): Promise<void> {
    const path = id != null ? `${category}/${id}` : category;
    await this.request(`/${this.panelId}/${this.partitionId}/${path}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  private applySystemInfo(systemInfo: SystemInfo): void {
    if (!systemInfo?.System?.Partitions?.length) {
      throw new VivintApiError('Vivint API returned a system snapshot without partitions');
    }
    this.systemInfo = systemInfo;
    this.partitionId = systemInfo.System.Partitions[0].PartitionId;
  }

  private async fetchSystemInfo(): Promise<SystemInfo> {
    return await this.requestJsonMapped(`/systems/${this.panelId}`) as SystemInfo;
  }

  private async fetchPanelLogin(): Promise<PanelLogin> {
    return await this.requestJsonMapped(`/panel-login/${this.panelId}`) as PanelLogin;
  }

  /**
   * Authenticates with the current session cookie. Vivint may rotate the
   * cookie in the response; when it does, the new value replaces the old one.
   */
  private async authenticate(): Promise<void> {
    if (!this.refreshToken) {
      throw new VivintAuthError('No refresh token configured. Sign in through the plugin settings UI to obtain one.');
    }

    const response = await this.rawRequest('/authuser', { method: 'GET' });

    if (response.status === 401 || response.status === 403) {
      throw new VivintAuthError(
        'Vivint rejected the saved session token. Open the plugin settings UI and sign in again to obtain a new token.',
        response.status,
      );
    }
    if (!response.ok) {
      throw await this.errorFromResponse(response, 'authentication');
    }

    const rotated = this.extractSessionCookie(response);
    if (rotated && rotated !== this.refreshToken) {
      this.refreshToken = rotated;
      this.log.debug('Vivint issued a rotated session token.');
    }

    this.sessionInfo = mapObject(await response.json() as Record<string, unknown>) as SessionInfo;
  }

  private extractSessionCookie(response: Response): string | undefined {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    const sessionCookie = setCookies.find(cookie => cookie.startsWith('s='));
    return sessionCookie?.split(';')[0];
  }

  /**
   * Performs an authenticated request, transparently renewing the session
   * once if it has expired.
   */
  private async request(path: string, init: { method?: string; body?: string } = {}, isRetry = false): Promise<Response> {
    const response = await this.rawRequest(path, init);

    if (response.status === 401 && !isRetry) {
      this.log.debug('Vivint session expired, renewing and retrying request once.');
      await this.renewSession();
      return this.request(path, init, true);
    }
    if (!response.ok) {
      throw await this.errorFromResponse(response, `${init.method ?? 'GET'} ${path}`);
    }
    return response;
  }

  private async requestJsonMapped(path: string): Promise<unknown> {
    const response = await this.request(path);
    return mapObject(await response.json() as Record<string, unknown>);
  }

  private async rawRequest(path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    const url = `${VIVINT_API_URL}${path}`;
    try {
      return await fetch(url, {
        method: init.method ?? 'GET',
        body: init.body,
        headers: {
          'Cookie': this.refreshToken,
          'Cache-Control': 'no-store',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Network-level failure (offline, DNS, timeout). No response was
      // received, so this is safe to retry with backoff.
      const reason = error instanceof Error ? error.message : String(error);
      throw new VivintApiError(`Could not reach the Vivint API (${reason}). Check the network connection.`, undefined, { cause: error });
    }
  }

  private async errorFromResponse(response: Response, what: string): Promise<VivintApiError> {
    // Drain the body so the socket can be reused; content is not logged
    // because Cloudflare block pages are noisy and API errors may echo data.
    await response.text().catch(() => '');

    if (response.status === 429 || response.status === 403 || response.status === 503) {
      return new VivintRateLimitError(
        `Vivint API is throttling or blocking requests (HTTP ${response.status}). Backing off to avoid a long-term block.`,
        response.status,
      );
    }
    if (response.status === 401) {
      return new VivintAuthError('Vivint session is no longer valid. Sign in again through the plugin settings UI.', response.status);
    }
    return new VivintApiError(`Vivint API request failed (${what}): HTTP ${response.status}`, response.status);
  }
}
