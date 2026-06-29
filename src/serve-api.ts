import {
  lockPath,
  manifestPath,
  projectRoot,
  resolveDataRepoOptional,
} from "./paths";
import { loadManifest } from "./manifest";
import { loadLocalLock, loadLock } from "./lock";
import { headSha, recentCommits } from "./git";
import { CLI_VERSION, SYSTEM_ITEMS, shaOfSystemItem } from "./bundled";
import { PRODUCT_NAME } from "./identity";
import {
  ITEM_KINDS,
  isFragmentItemKind,
  listMasterItems,
  shaOfGitVisibleItem,
} from "./master";
import type { ItemKind } from "./master";
import { shaOfFragmentItem } from "./fragments";
import { isGitRepo } from "./git";
import { buildStatusReport } from "./status-report";
import { loadDataItemMetadata, loadSystemItemMetadata } from "./metadata";
import type { ItemMetadata } from "./metadata";
import { listBundles, memberRef } from "./bundles";
import { parseItemRef } from "./item-ref";

/**
 * Read-only JSON API for `capshelf serve`. Every endpoint reuses the same core
 * the CLI uses, so the UI and `--json` output can never disagree. The server
 * binds one project (the cwd) and never mutates anything.
 */
export interface ApiContext {
  project: string;
  dataOverride?: string;
}

export function defaultApiContext(dataOverride?: string): ApiContext {
  return { project: projectRoot(), dataOverride };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Route an /api/* request. Returns null for non-API paths. */
export async function handleApiRequest(
  req: Request,
  ctx: ApiContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/")) return null;
  if (req.method !== "GET") return json({ error: "read-only" }, 405);

  try {
    switch (url.pathname) {
      case "/api/health":
        return json(await health(ctx));
      case "/api/status":
        return json(await status(ctx, url));
      case "/api/catalog":
        return json(await catalog(ctx, url));
      case "/api/config":
        return json(await config(ctx));
      case "/api/activity":
        return json(await activity(ctx, url));
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

async function health(ctx: ApiContext) {
  const manifest = await loadManifest(ctx.project);
  const dataRepo = await resolveDataRepoOptional({
    override: ctx.dataOverride,
    manifest,
    project: ctx.project,
  });
  const dataRepoReady = !!dataRepo && (await isGitRepo(dataRepo));
  return {
    product: PRODUCT_NAME,
    version: CLI_VERSION,
    project: ctx.project,
    dataRepo,
    dataRepoReady,
    installMode: manifest.installMode,
    readOnly: true,
  };
}

async function status(ctx: ApiContext, url: URL) {
  const scope = url.searchParams.get("scope");
  const itemRef = url.searchParams.get("item") ?? undefined;
  return buildStatusReport({
    project: ctx.project,
    dataOverride: ctx.dataOverride,
    ref: itemRef ? parseItemRef(itemRef) : undefined,
    opts: {
      diff: url.searchParams.get("diff") === "1",
      project: scope === "project",
      local: scope === "local",
    },
  });
}

async function config(ctx: ApiContext) {
  const manifest = await loadManifest(ctx.project);
  const dataRepo = await resolveDataRepoOptional({
    override: ctx.dataOverride,
    manifest,
    project: ctx.project,
  });
  const [lock, local] = await Promise.all([
    loadLock(ctx.project),
    loadLocalLock(ctx.project),
  ]);
  return {
    project: ctx.project,
    dataRepo,
    dataRepoReady: !!dataRepo && (await isGitRepo(dataRepo)),
    dataRepoUpstream: manifest.dataRepoUpstream ?? null,
    installMode: manifest.installMode,
    readOnly: true,
    paths: {
      manifest: manifestPath(ctx.project),
      lock: lockPath(ctx.project),
    },
    counts: {
      tracked: Object.keys(lock.items).length,
      local: Object.keys(local.items).length,
      skills: manifest.skills.length,
      settings: manifest.settings.length,
      mcp: manifest.mcp.length,
      codexConfig: manifest.codexConfig.length,
    },
  };
}

async function activity(ctx: ApiContext, url: URL) {
  const manifest = await loadManifest(ctx.project);
  const dataRepo = await resolveDataRepoOptional({
    override: ctx.dataOverride,
    manifest,
    project: ctx.project,
  });
  if (!dataRepo || !(await isGitRepo(dataRepo))) {
    return {
      dataRepoReady: false,
      dataRepo: dataRepo ?? null,
      head: null,
      commits: [],
    };
  }
  const limit = Math.min(Number(url.searchParams.get("n")) || 25, 100);
  const [head, commits] = await Promise.all([
    headSha(dataRepo),
    recentCommits(dataRepo, limit),
  ]);
  return { dataRepoReady: true, dataRepo, head, commits };
}

const metaFields = (meta: ItemMetadata) => ({
  ...(meta.description !== undefined && { description: meta.description }),
  ...(meta.tags.length > 0 && { tags: meta.tags }),
});

async function catalog(ctx: ApiContext, url: URL) {
  const manifest = await loadManifest(ctx.project);
  const dataRepo = await resolveDataRepoOptional({
    override: ctx.dataOverride,
    manifest,
    project: ctx.project,
  });
  const kindParam = url.searchParams.get("kind");
  const kind = ITEM_KINDS.includes(kindParam as ItemKind)
    ? (kindParam as ItemKind)
    : undefined;

  const system = await Promise.all(
    SYSTEM_ITEMS.filter((s) => !kind || s.kind === kind).map(async (item) => ({
      source: "system" as const,
      kind: item.kind,
      name: item.name,
      sha: await shaOfSystemItem(item),
      ...metaFields(loadSystemItemMetadata(item)),
    })),
  );

  if (!dataRepo || !(await isGitRepo(dataRepo))) {
    return {
      dataRepo: dataRepo ?? null,
      dataRepoReady: false,
      system,
      data: [],
    };
  }

  const dataItems = await listMasterItems(dataRepo, kind);
  const data = await Promise.all(
    dataItems.map(async (item) => ({
      source: "data" as const,
      kind: item.kind,
      name: item.name,
      path: item.path,
      sha: isFragmentItemKind(item.kind)
        ? await shaOfFragmentItem(dataRepo, item.kind, item.name)
        : await shaOfGitVisibleItem(dataRepo, item.repoRelPath),
      ...metaFields(await loadDataItemMetadata(item)),
    })),
  );

  const listing = await listBundles(dataRepo);
  const bundles = listing.bundles.map((bundle) => ({
    name: bundle.name,
    ...(bundle.description !== undefined && {
      description: bundle.description,
    }),
    ...(bundle.tags.length > 0 && { tags: bundle.tags }),
    members: bundle.members.map(memberRef),
    ...(bundle.malformed !== undefined && { malformed: bundle.malformed }),
  }));

  return { dataRepo, dataRepoReady: true, system, data, bundles };
}
