import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeDeviceName } from '../dist/utils/sanitizeName.js';

describe('sanitizeDeviceName', () => {
  it('keeps clean names as-is', () => {
    assert.equal(sanitizeDeviceName('Front Door', 1), 'Front Door');
  });

  it('strips characters HomeKit does not accept', () => {
    assert.equal(sanitizeDeviceName('Front Door (Main)!', 1), 'Front Door Main');
  });

  it('collapses repeated whitespace', () => {
    assert.equal(sanitizeDeviceName('Front   Door', 1), 'Front Door');
  });

  it('falls back to a generic name when empty', () => {
    assert.equal(sanitizeDeviceName('', 42), 'Unnamed device ID 42');
    assert.equal(sanitizeDeviceName(undefined, 42), 'Unnamed device ID 42');
    assert.equal(sanitizeDeviceName('!!!', 42), 'Unnamed device ID 42');
  });

  it('trims leading and trailing non-alphanumeric characters', () => {
    assert.equal(sanitizeDeviceName('\'Bedroom Lamp\'', 1), 'Bedroom Lamp');
  });
});
