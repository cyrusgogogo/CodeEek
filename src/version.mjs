import manifest from '../package.json' with { type: 'json' };

export const PLUGIN_NAME = manifest.name;
export const PLUGIN_VERSION = manifest.version;
export const TARGET_DSH_VERSION = manifest.engines?.dsh;
export const API_VERSION = 1;
