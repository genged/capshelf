/**
 * The machine-wide list of Capshelf projects the web UI shows.
 *
 * `capshelf init` adds the project it initializes, and `capshelf ui` adds the
 * project it runs inside. Nothing removes an entry: the file is small, user
 * owned, and edited by hand when a project moves. The UI reports a registered
 * path that no longer holds a manifest instead of hiding it.
 *
 * The file lives under the XDG config home, next to nothing else Capshelf
 * writes there today, following the clone cache convention in
 * `data-bootstrap.ts` (`$XDG_DATA_HOME/capshelf/data`).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ConfigValue } from "./config-values";
import { atomicWriteFile } from "./fs-utils";
import { PRODUCT_NAME } from "./identity";

export const PROJECT_REGISTRY_VERSION = 1 as const;
export const PROJECT_REGISTRY_FILE = "projects.json";

const RegisteredProjectSchema = z.object({
  path: z.string().min(1),
  registeredAt: z.string(),
});

const ProjectRegistrySchema = z.object({
  version: z.literal(PROJECT_REGISTRY_VERSION),
  projects: z.array(RegisteredProjectSchema).default([]),
});

export type RegisteredProject = z.infer<typeof RegisteredProjectSchema>;
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

/**
 * `$XDG_CONFIG_HOME/capshelf/projects.json`, falling back to
 * `~/.config/capshelf/projects.json` when the variable is unset or blank.
 */
export function projectRegistryPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg : join(homedir(), ".config");
  return join(base, PRODUCT_NAME, PROJECT_REGISTRY_FILE);
}

/** The one field read before the version decides whether the file is ours. */
const VersionProbe = z.object({ version: z.number().optional() });

export function emptyProjectRegistry(): ProjectRegistry {
  return { version: PROJECT_REGISTRY_VERSION, projects: [] };
}

export async function loadProjectRegistry(
  path: string = projectRegistryPath(),
): Promise<ProjectRegistry> {
  if (!existsSync(path)) return emptyProjectRegistry();
  const raw: ConfigValue = JSON.parse(await readFile(path, "utf-8"));
  const probe = VersionProbe.safeParse(raw);
  const version = probe.success ? probe.data.version : undefined;
  if (version !== undefined && version > PROJECT_REGISTRY_VERSION) {
    throw new Error(
      `${path} is registry version ${version}, newer than this ${PRODUCT_NAME} supports — upgrade ${PRODUCT_NAME}`,
    );
  }
  return ProjectRegistrySchema.parse(raw);
}

export async function saveProjectRegistry(
  registry: ProjectRegistry,
  path: string = projectRegistryPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const normalized = ProjectRegistrySchema.parse(registry);
  await atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
}

/**
 * Add `project` to the registry in memory. Returns true when it was new.
 * Paths compare resolved, so `.` and a trailing slash never register a
 * second copy of the same project. Order is insertion order.
 */
export function addRegisteredProject(
  registry: ProjectRegistry,
  project: string,
  now: Date = new Date(),
): boolean {
  const path = resolve(project);
  if (registry.projects.some((entry) => resolve(entry.path) === path)) {
    return false;
  }
  registry.projects.push({ path, registeredAt: now.toISOString() });
  return true;
}

/** Load, add, and save. Returns whether the project was new. */
export async function registerProject(
  project: string,
  path: string = projectRegistryPath(),
): Promise<boolean> {
  const registry = await loadProjectRegistry(path);
  const added = addRegisteredProject(registry, project);
  if (added) await saveProjectRegistry(registry, path);
  return added;
}
