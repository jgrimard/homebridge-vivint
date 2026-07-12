import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dataPatch } from '../dist/vivint/datapatch.js';

describe('dataPatch', () => {
  it('patches a simple object', () => {
    const data = { a: 1, b: 2 };
    dataPatch(data, { a: 3 });
    assert.deepEqual(data, { a: 3, b: 2 });
  });

  it('patches a nested object', () => {
    const data = { a: { b: 1, c: 2 } };
    dataPatch(data, { 'a.b': 3 });
    assert.deepEqual(data, { a: { b: 3, c: 2 } });
  });

  it('patches a nested object in an array', () => {
    const data = { a: { b: [{ c: 1 }, { d: 1 }] } };
    dataPatch(data, { 'a.b': [{ c: 3 }, { d: 3 }] });
    assert.deepEqual(data, { a: { b: [{ c: 3 }, { d: 3 }] } });
  });

  it('returns false if the patch traverses an undefined path in the data', () => {
    assert.equal(dataPatch({ a: 1 }, { 'a.b': 1 }), false);
  });

  it('adds new scalar keys', () => {
    const data = { a: 1 };
    dataPatch(data, { b: 2 });
    assert.deepEqual(data, { a: 1, b: 2 });
  });
});
