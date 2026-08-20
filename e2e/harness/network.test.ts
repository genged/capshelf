import { afterEach, expect, test } from "bun:test";
import {
  type EgressProbe,
  REQUIRE_OFFLINE_ENV,
  probeEgress,
  resolveLaneNetwork,
} from "../support/network";

const original = process.env[REQUIRE_OFFLINE_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[REQUIRE_OFFLINE_ENV];
  else process.env[REQUIRE_OFFLINE_ENV] = original;
});

const REACHABLE: EgressProbe = {
  reachable: true,
  detail: "connected to example.invalid:443",
};
const DENIED: EgressProbe = {
  reachable: false,
  detail: "no connection to example.invalid:443",
};

test("the canary reports whether non-local egress is possible", async () => {
  const probe = await probeEgress(3_000);
  expect(typeof probe.reachable).toBe("boolean");
  expect(probe.detail.length).toBeGreaterThan(0);
});

/**
 * The policy is tested against fixed observations, not against the network.
 * Classifying a live probe would exercise only the branch matching the machine
 * the tests happen to run on, and comparing two live probes would fail whenever
 * reachability changed between them even though each call classified its own
 * observation correctly.
 */
test("a denied lane is offline, and stays offline under strict mode", async () => {
  delete process.env[REQUIRE_OFFLINE_ENV];
  expect(await resolveLaneNetwork(DENIED)).toBe("offline");

  process.env[REQUIRE_OFFLINE_ENV] = "1";
  expect(await resolveLaneNetwork(DENIED)).toBe("offline");
});

test("a reachable lane gets the weaker name, and strict mode refuses it", async () => {
  delete process.env[REQUIRE_OFFLINE_ENV];
  expect(await resolveLaneNetwork(REACHABLE)).toBe(
    "no-credential local-remote",
  );

  process.env[REQUIRE_OFFLINE_ENV] = "1";
  await expect(resolveLaneNetwork(REACHABLE)).rejects.toThrow(
    REQUIRE_OFFLINE_ENV,
  );
});

test("one live observation classifies to one lane name", async () => {
  delete process.env[REQUIRE_OFFLINE_ENV];
  const probe = await probeEgress(3_000);
  const lane = await resolveLaneNetwork(probe);
  expect(lane).toBe(probe.reachable ? "no-credential local-remote" : "offline");
});
