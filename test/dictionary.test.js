import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getKeyByValueDeep, mapObject, VivintDict } from '../dist/vivint/dictionary.js';

describe('dictionary', () => {
  it('loads the Vivint dictionary with the sections the plugin relies on', () => {
    assert.equal(VivintDict.Fields.Id, '_id');
    assert.equal(VivintDict.Fields.Status, 's');
    assert.equal(VivintDict.PanelDeviceType.DoorLock, 'door_lock_device');
    assert.equal(VivintDict.SecurityState.ARMED_AWAY, 4);
    assert.equal(VivintDict.ObjectType.InboxMessage, 'inbox_message');
  });

  it('resolves nested keys by value', () => {
    assert.equal(getKeyByValueDeep(VivintDict.Fields, '_id'), 'Id');
  });

  it('maps wire field names to friendly names recursively', () => {
    const mapped = mapObject({ _id: 5, s: true, unknown_field: 'x' });
    assert.equal(mapped.Id, 5);
    assert.equal(mapped.Status, true);
    assert.equal(mapped.unknown_field, 'x');
  });

  it('maps arrays of objects', () => {
    const mapped = mapObject({ d: [{ _id: 1 }, { _id: 2 }] });
    const devices = mapped.Devices ?? mapped.d;
    assert.deepEqual(devices.map(item => item.Id), [1, 2]);
  });
});
