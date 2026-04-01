'use strict';

const { NoCloudVacuumPlatform, PLATFORM_NAME, PLUGIN_NAME } = require('./src/platform');

/**
 * This is the entry point for the Homebridge plugin.
 * Homebridge calls this function once during startup.
 */
module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, NoCloudVacuumPlatform);
};
