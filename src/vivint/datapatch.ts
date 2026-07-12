/**
 * Applies incremental PubNub patches to cached device data, mutating in place.
 *
 * Patch keys may use dotted paths: applying {"a.b": 1} to {"a": {"b": 2, "c": 3}}
 * results in {"a": {"b": 1, "c": 3}}. Array patches are applied element-wise.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataPatchArr(data: unknown[], patch: unknown[]): boolean {
  for (let idx = 0; idx < patch.length; idx++) {
    const patchValue = patch[idx];
    if (isPlainObject(patchValue)) {
      const target = data[idx];
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion with dataPatch
      if (!isPlainObject(target) || !dataPatch(target, patchValue)) {
        return false;
      }
    } else {
      data[idx] = patchValue;
    }
  }
  return true;
}

export function dataPatch(data: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  if (!isPlainObject(data)) {
    return false;
  }

  for (const key of Object.keys(patch)) {
    const selector = key.split('.');
    if (selector.length > 1) {
      const head = selector.shift() as string;
      const restPatch: Record<string, unknown> = { [selector.join('.')]: patch[key] };
      const target = data[head];
      if (!isPlainObject(target) || !dataPatch(target, restPatch)) {
        return false;
      }
    } else if (Array.isArray(patch[key])) {
      const target = data[key];
      if (!Array.isArray(target) || !dataPatchArr(target, patch[key] as unknown[])) {
        return false;
      }
    } else {
      data[key] = patch[key];
    }
  }
  return true;
}
