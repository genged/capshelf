import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ItemNeeds } from "./metadata";
import type { RuntimeWarning } from "./runtime-warnings";

const POLICY_PATH = ".runfree/network-policy.json";
const PolicySchema = z.object({
  domains: z.array(z.string()),
});

export type NeedsPolicy =
  | { active: false; checkable: false; allowed: null; advisory: null }
  | { active: true; checkable: true; allowed: Set<string>; advisory: null }
  | { active: true; checkable: false; allowed: null; advisory: string };

const policyCache = new Map<string, NeedsPolicy>();

export function needsPolicyForProject(project: string): NeedsPolicy {
  const cached = policyCache.get(project);
  if (cached) return cached;

  const runfreeDir = join(project, ".runfree");
  if (!isDirectory(runfreeDir)) {
    const result: NeedsPolicy = {
      active: false,
      checkable: false,
      allowed: null,
      advisory: null,
    };
    policyCache.set(project, result);
    return result;
  }

  const path = join(project, POLICY_PATH);
  if (!existsSync(path)) {
    const result: NeedsPolicy = {
      active: true,
      checkable: true,
      allowed: new Set(),
      advisory: null,
    };
    policyCache.set(project, result);
    return result;
  }

  try {
    const parsed = PolicySchema.safeParse(
      JSON.parse(readFileSync(path, "utf-8")),
    );
    if (!parsed.success) return cacheSkipped(project);
    const result: NeedsPolicy = {
      active: true,
      checkable: true,
      allowed: new Set(
        parsed.data.domains.map((domain) => domain.toLowerCase()),
      ),
      advisory: null,
    };
    policyCache.set(project, result);
    return result;
  } catch {
    return cacheSkipped(project);
  }
}

export function needsWarningsForItem(
  project: string,
  ref: string,
  needs: ItemNeeds,
): RuntimeWarning[] {
  const policy = needsPolicyForProject(project);
  if (!policy.active) return [];
  if (!policy.checkable) {
    return [
      {
        type: "needs_check_skipped",
        path: POLICY_PATH,
        message: policy.advisory,
      },
    ];
  }
  const unmet = needs.network.filter(
    (host) => !policy.allowed.has(host.toLowerCase()),
  );
  if (unmet.length === 0) return [];
  return [
    {
      type: "network_needs_unmet",
      path: POLICY_PATH,
      message: `${ref} needs network egress this project does not allow:\n${unmet
        .map((host) => `    ${host} — allow with: ${runfreeHostAdd(host)}`)
        .join("\n")}`,
    },
  ];
}

export function runfreeHostAdd(host: string): string {
  return `runfree host add ${host}`;
}

export function formatDeclaredNeeds(needs: ItemNeeds): string | null {
  const parts: string[] = [];
  if (needs.env.length > 0) parts.push(`reads env: ${needs.env.join(", ")}`);
  if (needs.bin.length > 0) {
    parts.push(`needs on PATH: ${needs.bin.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function clearNeedsPolicyCacheForTests(): void {
  policyCache.clear();
}

function cacheSkipped(project: string): NeedsPolicy {
  const result: NeedsPolicy = {
    active: true,
    checkable: false,
    allowed: null,
    advisory:
      "could not read .runfree/network-policy.json — needs check skipped",
  };
  policyCache.set(project, result);
  return result;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
