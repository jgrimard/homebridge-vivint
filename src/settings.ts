/**
 * The platform name users put in config.json ("platform": "Vivint").
 */
export const PLATFORM_NAME = 'Vivint';

/**
 * Plugin identifier used when registering accessories. Deliberately kept as the
 * unscoped name (not the scoped package.json name) to match the identifier used
 * by @balansse/homebridge-vivint, so cached accessories carry over between the
 * two; Homebridge resolves the mismatch via its plugin-rename fallback.
 */
export const PLUGIN_NAME = 'homebridge-vivint';
