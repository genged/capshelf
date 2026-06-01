import type { Lock } from "./lock";
import type { Manifest } from "./manifest";
import {
  applyFragmentOutput,
  fragmentContributionState,
  fragmentOutputPath,
  planFragmentOutput,
  type FragmentApplyResult,
  type FragmentContributionState,
  type FragmentOutputPlan,
} from "./fragments";
import { mergeConfigObjects, type ConfigObject } from "./config-values";

export type SettingsApplyResult = FragmentApplyResult;
export type SettingsContributionState = FragmentContributionState;
export type SettingsOutputPlan = FragmentOutputPlan;

export interface ApplySettingsOptions {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  oldManifest?: Manifest;
  nextManifest?: Manifest;
  oldLock: Lock;
  nextLock: Lock;
  dryRun?: boolean;
}

export function settingsOutputPath(project: string): string {
  return fragmentOutputPath(project, "claude-settings");
}

export async function applySettingsFragments(
  opts: ApplySettingsOptions,
): Promise<SettingsApplyResult> {
  return await applyFragmentOutput({ ...opts, target: "claude-settings" });
}

export async function planSettingsOutput(
  opts: ApplySettingsOptions,
): Promise<SettingsOutputPlan> {
  return await planFragmentOutput({ ...opts, target: "claude-settings" });
}

export async function settingsContributionState(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
): Promise<SettingsContributionState> {
  return await fragmentContributionState(
    project,
    dataRepo,
    manifest,
    lock,
    "claude-settings",
  );
}

export function mergeSettingsFragments(
  fragments: ConfigObject[],
): ConfigObject {
  return mergeConfigObjects(fragments);
}
