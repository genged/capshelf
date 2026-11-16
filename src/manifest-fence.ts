/**
 * Capshelf 0.13 refuses a `shelves` key but drops unknown keys on save, so a
 * plugin project carries this string there to stop it before it drops
 * `plugins`; federation uses an array, so no clash.
 */
import { isConfigObject, type ConfigValue } from "./config-values";

export const PLUGIN_FENCE =
  "plugin items: this project needs a capshelf release that supports plugins";

export function fenceFor(pluginCount: number): { shelves?: string } {
  return pluginCount > 0 ? { shelves: PLUGIN_FENCE } : {};
}

/**
 * `shelves` is reserved by the federation spec, so a key with any value, even
 * null, counts.
 */
export function hasShelvesKey(value: ConfigValue): boolean {
  return isConfigObject(value) && "shelves" in value;
}

export function assertFenceOrFederation(path: string, raw: ConfigValue): void {
  if (!hasShelvesKey(raw)) return;
  if (isConfigObject(raw) && raw.shelves === PLUGIN_FENCE) {
    const plugins = raw.plugins;
    if (Array.isArray(plugins) && plugins.length > 0) return;
    throw new Error(
      `${path} holds the plugin fence under "shelves" but no plugin; remove the "shelves" key`,
    );
  }
  throw new Error(
    `${path} declares "shelves": this project uses multi-shelf federation, which this capshelf version does not support; upgrade capshelf`,
  );
}
