import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_INSTALL_MODE,
  InstallModeSchema,
  manifestPath,
  manifestReadPath,
} from "./paths";
import type { InstallMode } from "./paths";
import { normalizeRemoteUrl } from "./git";
import { MANIFEST_FILE, METADATA_DIR, PRODUCT_NAME } from "./identity";
import type { ItemKind } from "./master";

export const ManifestSchema = z
  .object({
    installMode: InstallModeSchema.default(DEFAULT_INSTALL_MODE),
    dataRepoUpstream: z
      .string()
      .optional()
      .refine(
        (value) => value === undefined || normalizeRemoteUrl(value) !== null,
        {
          message: "dataRepoUpstream must be a supported git remote URL",
        },
      ),
    dataRepo: z.never().optional(),
    skills: z.array(z.string()).default([]),
    commands: z.array(z.string()).optional(),
    settings: z.array(z.string()).default([]),
    mcp: z.array(z.string()).default([]),
    codexConfig: z.array(z.string()).default([]),
  })
  .superRefine((manifest, ctx) => {
    if ((manifest.commands?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["commands"],
        message:
          "commands are no longer managed by capshelf; convert them to skills under skills/<name>/SKILL.md",
      });
    }
  })
  .transform(
    ({ commands: _commands, dataRepo: _dataRepo, ...manifest }) => manifest,
  );

export type Manifest = z.infer<typeof ManifestSchema> & {
  installMode: InstallMode;
};

export function emptyManifest(): Manifest {
  return ManifestSchema.parse({});
}

export async function loadManifest(project: string): Promise<Manifest> {
  const p = manifestReadPath(project);
  if (!p) return emptyManifest();
  const raw = await readFile(p, "utf-8");
  const parsed = JSON.parse(raw);
  if (hasLegacyDataRepo(parsed)) {
    const legacyDataRepo = (parsed as { dataRepo: string }).dataRepo;
    throw new Error(
      `${p} uses the legacy dataRepo field.\n` +
        "  fix it manually:\n" +
        `    1. remove dataRepo from ${p}.\n` +
        "    2. point capshelf at that path:\n" +
        `         ${PRODUCT_NAME} set-data ${legacyDataRepo}\n` +
        `    3. optionally declare the upstream (commits to ${METADATA_DIR}/${MANIFEST_FILE}):\n` +
        `         ${PRODUCT_NAME} set-upstream <origin-url>`,
    );
  }
  return ManifestSchema.parse(parsed);
}

export async function saveManifest(
  project: string,
  m: Manifest,
): Promise<void> {
  const p = manifestPath(project);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(m, null, 2)}\n`);
}

export function manifestNamesForKind(
  manifest: Manifest,
  kind: ItemKind,
): string[] {
  switch (kind) {
    case "skills":
      return manifest.skills;
    case "settings":
      return manifest.settings;
    case "mcp":
      return manifest.mcp;
    case "codex-config":
      return manifest.codexConfig;
  }
}

export function addManifestName(
  manifest: Manifest,
  kind: ItemKind,
  name: string,
): void {
  const list = manifestNamesForKind(manifest, kind);
  if (!list.includes(name)) list.push(name);
}

export function removeManifestName(
  manifest: Manifest,
  kind: ItemKind,
  name: string,
): void {
  const list = manifestNamesForKind(manifest, kind);
  const index = list.indexOf(name);
  if (index !== -1) list.splice(index, 1);
}

function hasLegacyDataRepo(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "dataRepo" in value &&
    typeof (value as { dataRepo?: unknown }).dataRepo === "string" &&
    (value as { dataRepo: string }).dataRepo.length > 0
  );
}
