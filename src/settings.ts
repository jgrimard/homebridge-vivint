/**
 * The platform name users put in config.json ("platform": "Vivint").
 */
export const PLATFORM_NAME = 'Vivint';

import { readFileSync } from 'node:fs';

/**
 * Plugin identifier used when registering accessories. Read from package.json
 * so it always matches the name this package is actually installed under
 * (scoped @jgrimard fork or unscoped upstream). Registering under any other
 * name makes Homebridge warn "no loaded plugin could be found for the name".
 * Cached accessories from @balansse/homebridge-vivint still carry over: on
 * restore, Homebridge resolves an unknown plugin name via the active dynamic
 * platform (PLATFORM_NAME) and rewrites the cache.
 */
export const PLUGIN_NAME: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
).name;
