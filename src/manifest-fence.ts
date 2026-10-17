/**
 * Spec M9. Capshelf 0.13 refuses a manifest or local config that holds a
 * `shelves` key, whatever its value, and it drops every key it does not know
 * when it saves. A project with a plugin therefore carries this string under
 * `shelves`, so 0.13 stops before it can drop the `plugins` array.
 * `capshelf data upstream` saves the manifest without a lock read, so lock
 * version 5 alone does not stop it. Federation uses an array, so this string
 * can never be a federation config.
 */
import { isConfigObject, type ConfigValue } from "./config-values";

export const PLUGIN_FENCE =
  "plugin items: this project needs a capshelf release that supports plugins";

export function fenceFor(pluginCount: number): { shelves?: string } {
  return pluginCount > 0 ? { shelves: PLUGIN_FENCE } : {};
}

/**
 * True when a parsed JSON document carries a `shelves` key with any value
 * (including `null`). Reserved by the federation spec; see
 * `assertFenceOrFederation`. Shared by manifest.ts and local-config.ts, which
 * enforce the same reservation.
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
