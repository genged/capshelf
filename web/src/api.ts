// Typed client for the read-only capshelf serve API. Shapes mirror the CLI's
// --json output (the server reuses the same core).

export type ItemKind = "skills" | "settings" | "mcp" | "codex-config";
export type ItemSource = "data" | "system";
export type State =
  | "ok"
  | "missing_source_commit"
  | "update_available"
  | "drifted_local"
  | "drifted_and_update"
  | "missing_installed"
  | "missing_output"
  | "missing_upstream"
  | "upstream_dirty"
  | "source_dirty"
  | "drifted_and_upstream_dirty"
  | "output_drift"
  | "source_dirty_and_output_drift"
  | "kept-local";

export interface RuntimeWarning {
  type: string;
  path?: string;
  [k: string]: unknown;
}

export interface StatusRow {
  scope: "project" | "local";
  source: ItemSource;
  kind: ItemKind;
  name: string;
  state: State;
  lockedSha: string;
  currentSha: string | null;
  upstreamSha: string | null;
  upstreamDirty?: boolean;
  sourceCommit?: string;
  local?: true;
  localReason?: string;
  cliVersion?: string;
  label?: string;
  runtimeWarnings?: RuntimeWarning[];
}

export interface StatusDiff {
  item: string;
  kind: ItemKind;
  name: string;
  path: string;
  text: string;
}

export interface StatusReport {
  project: string;
  dataRepo: string | null;
  cliVersion: string;
  count: number;
  items: StatusRow[];
  diffs?: StatusDiff[];
  external: { name: string; source?: string }[];
  externalClaudePlugins: { id?: string; name: string }[];
  personalClaudeExternal: { kind: string; name: string; path: string }[];
}

export interface Health {
  product: string;
  version: string;
  project: string;
  dataRepo: string | null;
  dataRepoReady: boolean;
  installMode: string;
  readOnly: boolean;
}

export interface CatalogItem {
  source: ItemSource;
  kind: ItemKind;
  name: string;
  sha: string;
  path?: string;
  description?: string;
  tags?: string[];
}

export interface CatalogBundle {
  name: string;
  description?: string;
  tags?: string[];
  members: string[];
  malformed?: boolean;
}

export interface Catalog {
  dataRepo: string | null;
  dataRepoReady: boolean;
  system: CatalogItem[];
  data: CatalogItem[];
  bundles?: CatalogBundle[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export interface Config {
  project: string;
  dataRepo: string | null;
  dataRepoReady: boolean;
  dataRepoUpstream: string | null;
  installMode: string;
  readOnly: boolean;
  paths: { manifest: string; lock: string };
  counts: {
    tracked: number; local: number;
    skills: number; settings: number; mcp: number; codexConfig: number;
  };
}

export interface RepoCommit {
  sha: string; author: string; date: string; subject: string;
}
export interface Activity {
  dataRepoReady: boolean;
  dataRepo: string | null;
  head: string | null;
  commits: RepoCommit[];
}

export const api = {
  health: () => get<Health>("api/health"),
  config: () => get<Config>("api/config"),
  activity: () => get<Activity>("api/activity"),
  status: (opts: { diff?: boolean; item?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.diff) q.set("diff", "1");
    if (opts.item) q.set("item", opts.item);
    const qs = q.toString();
    return get<StatusReport>(`api/status${qs ? `?${qs}` : ""}`);
  },
  catalog: () => get<Catalog>("api/catalog"),
};

// ---- presentation helpers shared across screens ----

export type Bucket = "sync" | "update" | "drift" | "local" | "external";

export function bucketOf(state: State): Bucket {
  switch (state) {
    case "ok":
      return "sync";
    case "kept-local":
      return "local";
    case "update_available":
    case "missing_output":
    case "missing_installed":
    case "missing_upstream":
    case "missing_source_commit":
      return "update";
    default:
      return "drift";
  }
}

export const STATE_LABEL: Record<State, string> = {
  ok: "In sync",
  kept_local: "Kept-local",
  "kept-local": "Kept-local",
  update_available: "Update",
  drifted_local: "Drifted",
  drifted_and_update: "Drifted · update",
  missing_installed: "Missing",
  missing_output: "Missing output",
  missing_upstream: "Upstream gone",
  missing_source_commit: "Commit missing",
  upstream_dirty: "Source dirty",
  source_dirty: "Source dirty",
  drifted_and_upstream_dirty: "Drifted · dirty",
  output_drift: "Output drift",
  source_dirty_and_output_drift: "Source · output drift",
} as Record<State, string>;
