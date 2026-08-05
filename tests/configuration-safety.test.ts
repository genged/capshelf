import { describe, expect, test } from "bun:test";
import {
  cloneConfig,
  containsManagedValue,
  findUnmanagedCollision,
  mergeConfigValues,
  removeManagedValue,
  stableStringifyConfig,
  stableSortConfig,
  type ConfigObject,
} from "../src/config-values";
import { parseTomlConfigObject } from "../src/toml-fragments";

describe("configuration safety", () => {
  test("TOML rejects non-finite numbers recursively and keeps finite values", () => {
    for (const raw of [
      "value = inf\n",
      "value = -inf\n",
      "value = nan\n",
      "[nested]\nvalue = inf\n",
      "values = [1, nan]\n",
    ]) {
      expect(() => parseTomlConfigObject(raw, "config.toml")).toThrow(
        /config\.toml.*non-finite/u,
      );
    }
    expect(
      parseTomlConfigObject("integer = 2\nfloat = 2.5\n", "ok.toml"),
    ).toEqual({ integer: 2, float: 2.5 });
  });

  test("configuration operations preserve special own keys safely", () => {
    const value = JSON.parse(
      '{"__proto__":{"enabled":true},"constructor":1,"toString":2,"valueOf":3,"hasOwnProperty":4,"prototype":5}',
    ) as ConfigObject;
    for (const result of [
      cloneConfig(value),
      stableSortConfig(value) as ConfigObject,
      mergeConfigValues({}, value) as ConfigObject,
    ]) {
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      for (const key of Object.keys(value))
        expect(Object.hasOwn(result, key)).toBe(true);
      expect(JSON.parse(stableStringifyConfig(result))).toEqual(
        JSON.parse(stableStringifyConfig(value)),
      );
    }
    expect(findUnmanagedCollision({}, value)).toBeNull();
    expect(containsManagedValue(value, value)).toBe(true);
    expect(removeManagedValue(value, value)).toBeUndefined();
  });
});
