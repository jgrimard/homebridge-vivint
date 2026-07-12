import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers';

import registerPlugin from '../dist/index.js';

function makeLog() {
  const entries = [];
  const record = level => (...args) => entries.push({ level, args });
  const log = record('info');
  for (const level of ['info', 'warn', 'error', 'debug', 'success', 'log']) {
    log[level] = record(level);
  }
  log.entries = entries;
  return log;
}

async function makeFakeApi() {
  const hap = await import('@homebridge/hap-nodejs');
  const api = new EventEmitter();
  api.hap = hap;
  api.version = 2.7;
  api.serverVersion = '2.1.0';
  api.registeredPlatforms = new Map();
  api.registerPlatform = (name, ctor) => api.registeredPlatforms.set(name, ctor);
  api.registerPlatformAccessories = () => {};
  api.unregisterPlatformAccessories = () => {};
  return api;
}

describe('plugin registration', () => {
  it('registers the Vivint platform', async () => {
    const api = await makeFakeApi();
    registerPlugin(api);
    assert.ok(api.registeredPlatforms.has('Vivint'), 'platform "Vivint" should be registered');
  });

  it('constructs the platform and reports a missing refresh token without crashing', async () => {
    const api = await makeFakeApi();
    registerPlugin(api);
    const Platform = api.registeredPlatforms.get('Vivint');

    const log = makeLog();
    const platform = new Platform(log, { platform: 'Vivint', name: 'Vivint' }, api);
    assert.ok(platform);

    // didFinishLaunching with no token: must log a helpful error, not throw,
    // and must not attempt any network access.
    api.emit('didFinishLaunching');
    await new Promise(resolve => setImmediate(resolve));

    const errorLogs = log.entries.filter(entry => entry.level === 'error');
    assert.equal(errorLogs.length, 1);
    assert.match(String(errorLogs[0].args[0]), /No Vivint refresh token is configured/);
  });

  it('accepts cached accessories before launch', async () => {
    const api = await makeFakeApi();
    registerPlugin(api);
    const Platform = api.registeredPlatforms.get('Vivint');
    const platform = new Platform(makeLog(), { platform: 'Vivint', name: 'Vivint' }, api);

    const accessory = {
      UUID: '00000000-0000-0000-0000-000000000001',
      displayName: 'Cached Sensor',
      context: { id: 1, name: 'Cached Sensor', deviceClassName: 'ContactSensor' },
    };
    platform.configureAccessory(accessory);
  });
});
