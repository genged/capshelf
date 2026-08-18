/**
 * The required lane must not depend on credentials or on public network state.
 * `GIT_TERMINAL_PROMPT=0` only stops an interactive prompt; it does not stop
 * network access, so the lane states its own network condition instead of
 * assuming one.
 */
export type LaneNetwork = "offline" | "no-credential local-remote";

export const REQUIRE_OFFLINE_ENV = "CAPSHELF_E2E_REQUIRE_OFFLINE";

export interface EgressProbe {
  reachable: boolean;
  detail: string;
}

interface Target {
  hostname: string;
  port: number;
}

/** One name and one literal address: a name-only probe also measures DNS. */
const CANARY_TARGETS: readonly Target[] = [
  { hostname: "github.com", port: 443 },
  { hostname: "1.1.1.1", port: 443 },
];

async function connectOnce(
  target: Target,
  timeoutMs: number,
): Promise<boolean> {
  let socket: { end(): void } | null = null;
  const attempt = Bun.connect({
    hostname: target.hostname,
    port: target.port,
    socket: { data() {}, open() {}, error() {}, close() {} },
  }).then((connected) => {
    socket = connected;
    return true;
  });
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([attempt, timeout]);
  } catch {
    return false;
  } finally {
    void attempt.catch(() => false).then(() => socket?.end());
  }
}

export async function probeEgress(timeoutMs = 4_000): Promise<EgressProbe> {
  for (const target of CANARY_TARGETS) {
    if (await connectOnce(target, timeoutMs)) {
      return {
        reachable: true,
        detail: `connected to ${target.hostname}:${target.port}`,
      };
    }
  }
  return {
    reachable: false,
    detail: `no connection to ${CANARY_TARGETS.map((t) => `${t.hostname}:${t.port}`).join(", ")}`,
  };
}

/**
 * Name the lane from what the canary measured. A runner that cannot enforce
 * egress denial gets the weaker, accurate name; only `CAPSHELF_E2E_REQUIRE_OFFLINE=1`
 * turns a reachable network into a harness failure.
 */
export async function resolveLaneNetwork(): Promise<LaneNetwork> {
  const probe = await probeEgress();
  if (!probe.reachable) return "offline";
  if (process.env[REQUIRE_OFFLINE_ENV] === "1") {
    throw new Error(
      `${REQUIRE_OFFLINE_ENV}=1 requires non-local egress to be denied, but the canary ${probe.detail}`,
    );
  }
  return "no-credential local-remote";
}
