import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { debounceLeading } from '../dist/utils/debounce.js';

describe('debounceLeading', () => {
  it('runs the first call immediately', async () => {
    const calls = [];
    const fn = debounceLeading(async value => {
      calls.push(value);
      return value;
    }, 50);
    assert.equal(await fn(1), 1);
    assert.deepEqual(calls, [1]);
  });

  it('coalesces a burst into leading + one trailing call with the last value', async () => {
    const calls = [];
    const fn = debounceLeading(async value => {
      calls.push(value);
      return value;
    }, 50);

    const results = await Promise.all([fn(1), fn(2), fn(3)]);
    assert.deepEqual(calls, [1, 3]);
    assert.deepEqual(results, [1, 3, 3]);
  });

  it('runs again on the leading edge after the quiet window', async () => {
    const calls = [];
    const fn = debounceLeading(async value => {
      calls.push(value);
      return value;
    }, 20);

    await fn(1);
    await sleep(40);
    await fn(2);
    assert.deepEqual(calls, [1, 2]);
  });

  it('propagates errors to all coalesced callers', async () => {
    const fn = debounceLeading(async () => {
      throw new Error('boom');
    }, 20);
    await assert.rejects(fn(), /boom/);
  });
});
