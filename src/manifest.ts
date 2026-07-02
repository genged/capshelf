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
import { isSafeItemName } from "./assert";
import { MANIFEST_FILE, METADATA_DIR, PRODUCT_NAME } from "./identity";
import type { ItemKind } from "./master";

// Names in a committed manifest are as untrusted as lockfile names — a cloned
// project's manifest could carry `skills: ["../../evil"]`, which would flow to
// installedPath. Validate every tracked name against the one canonical rule.
const itemNameArray = z
  .array(
    z.string().refine(isSafeItemName, {
      message:
        "unsafe item name (must be non-empty, relative, no '..' segments, no leading '-')",
    }),
  )
  .default([]);

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
    skills: itemNameArray,
    commands: z.array(z.string()).optional(),
    settings: itemNameArray,
    mcp: itemNameArray,
    codexConfig: itemNameArray,
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
  // "shelves" is reserved for multi-shelf federation. Detect it before zod
  // parsing: the non-strict schema would silently strip it and the next
  // saveManifest would delete the federation config with no error. See
  // local/specs/multi-shelf-federation-spec.md, Compatibility Reservations,
  // Group 2(b).
  if (hasShelvesKey(parsed)) {
    throw new Error(
      `${p} declares "shelves": this project uses multi-shelf federation, which this capshelf version does not support; upgrade capshelf`,
    );
  }
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

/**
 * True when a parsed JSON document carries a `shelves` key with any value
 * (including `null`). Reserved by the federation spec; see `loadManifest`.
 * (Duplicated in local-config.ts to avoid a module cycle via paths.ts.)
 */
function hasShelvesKey(value: unknown): boolean {
  return typeof value === "object" && value !== null && "shelves" in value;
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
