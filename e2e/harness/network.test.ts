import { afterEach, expect, test } from "bun:test";
import {
  REQUIRE_OFFLINE_ENV,
  probeEgress,
  resolveLaneNetwork,
} from "../support/network";

const original = process.env[REQUIRE_OFFLINE_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[REQUIRE_OFFLINE_ENV];
  else process.env[REQUIRE_OFFLINE_ENV] = original;
});

test("the canary reports whether non-local egress is possible", async () => {
  const probe = await probeEgress(3_000);
  expect(typeof probe.reachable).toBe("boolean");
  expect(probe.detail.length).toBeGreaterThan(0);
});

/**
 * The lane names its own network condition. A runner that cannot deny egress
 * gets the weaker, accurate name rather than a false "offline" claim, and the
 * required lane makes the denial mandatory by setting the strict variable.
 */
test("the lane label follows the canary, and strict mode fails a reachable lane", async () => {
  delete process.env[REQUIRE_OFFLINE_ENV];
  const probe = await probeEgress(3_000);
  const lane = await resolveLaneNetwork();

  if (probe.reachable) {
    expect(lane).toBe("no-credential local-remote");
    process.env[REQUIRE_OFFLINE_ENV] = "1";
    await expect(resolveLaneNetwork()).rejects.toThrow(REQUIRE_OFFLINE_ENV);
    return;
  }

  expect(lane).toBe("offline");
  process.env[REQUIRE_OFFLINE_ENV] = "1";
  expect(await resolveLaneNetwork()).toBe("offline");
});
