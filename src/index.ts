import type { API } from 'homebridge';

import { VivintPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

/**
 * Registers the Vivint platform with Homebridge.
 */
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, VivintPlatform);
};
