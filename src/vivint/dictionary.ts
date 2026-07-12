import { readFileSync } from 'node:fs';

/**
 * The Vivint dictionary maps friendly names to the raw wire-format field names
 * and enum values used by the Vivint API (e.g. Fields.Id -> "_id").
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DictNode = { [key: string]: any };

export interface VivintDictionary extends DictNode {
  Fields: Record<string, string>;
  PanelDeviceType: Record<string, string>;
  EquipmentCode: Record<string, number>;
  GarageDoorStates: Record<string, number>;
  SecurityState: Record<string, number>;
  OperatingStates: Record<string, number>;
  OperatingModes: Record<string, number>;
  ObjectType: Record<string, string>;
  PanelCapabilityType: Record<string, number>;
}

const dictUrl = new URL('./vivint_dictionary.json', import.meta.url);
export const VivintDict: VivintDictionary = JSON.parse(readFileSync(dictUrl, 'utf8'));

function isPlainObject(value: unknown): value is DictNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Finds the (possibly nested) dictionary key whose value equals `value`.
 * Nested keys are joined with underscores, except that the top-level "Fields"
 * prefix is omitted (matching the original plugin's behavior).
 */
export function getKeyByValueDeep(object: DictNode, value: unknown): string | undefined {
  const key = Object.keys(object).find(k => object[k] === value);
  if (key !== undefined) {
    return key;
  }
  for (const property of Object.keys(object)) {
    if (isPlainObject(object[property])) {
      const result = getKeyByValueDeep(object[property], value);
      if (result !== undefined) {
        return (property !== 'Fields' ? property + '_' : '') + result;
      }
    }
  }
  return undefined;
}

// Reverse lookups over the large dictionary are expensive, and the same wire
// field names appear in every message, so cache the results per dictionary.
const reverseLookupCaches = new WeakMap<VivintDictionary, Map<string, string>>();

function mapFieldName(property: string, dict: VivintDictionary): string {
  let cache = reverseLookupCaches.get(dict);
  if (!cache) {
    cache = new Map();
    reverseLookupCaches.set(dict, cache);
  }
  const cached = cache.get(property);
  if (cached !== undefined) {
    return cached;
  }
  const mapped = getKeyByValueDeep(dict.Fields, property) || getKeyByValueDeep(dict, property) || property;
  cache.set(property, mapped);
  return mapped;
}

/**
 * Recursively maps wire-format field names in an API object to their friendly
 * dictionary names. Unknown fields are kept as-is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapObject(object: DictNode, dict: VivintDictionary = VivintDict): any {
  const mappedObject: DictNode = {};
  for (const property of Object.keys(object)) {
    const value = object[property];
    const mappedProperty = mapFieldName(property, dict);

    if (Array.isArray(value)) {
      mappedObject[mappedProperty] = value.map(item =>
        isPlainObject(item) || Array.isArray(item) ? mapObject(item as DictNode, dict) : item,
      );
    } else if (isPlainObject(value)) {
      mappedObject[mappedProperty] = mapObject(value, dict);
    } else {
      mappedObject[mappedProperty] = value;
    }
  }
  return mappedObject;
}
