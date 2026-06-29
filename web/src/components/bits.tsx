import type { Bucket, State, StatusRow } from "../api";
import { STATE_LABEL, bucketOf } from "../api";

export const short = (sha: string | null | undefined, n = 7): string =>
  sha ? sha.slice(0, n) : "";

const BADGE_CLASS: Record<Bucket, string> = {
  sync: "b-sync",
  update: "b-update",
  drift: "b-drift",
  local: "b-local",
  external: "b-ext",
};

export function StatusBadge({ state }: { state: State }) {
  const bucket = bucketOf(state);
  return (
    <span className={`badge ${BADGE_CLASS[bucket]}`}>
      <span className="bd" />
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

export function ExternalBadge({ label = "External" }: { label?: string }) {
  return <span className="badge b-ext"><span className="bd" />{label}</span>;
}

/** locked → current/upstream version cell, colored by what changed. */
export function VersionCell({ row }: { row: StatusRow }) {
  const bucket = bucketOf(row.state);
  if (bucket === "sync" || bucket === "local") {
    return <span className="ver">{short(row.lockedSha)}</span>;
  }
  const to = row.upstreamSha && row.upstreamSha !== row.lockedSha
    ? short(row.upstreamSha)
    : row.currentSha && row.currentSha !== row.lockedSha
      ? `${short(row.currentSha, 4)} · dirty`
      : short(row.lockedSha);
  return (
    <span className="ver">
      {short(row.lockedSha)}
      <span className="arr">→</span>
      <span className={bucket === "drift" ? "dr" : "up"}>{to}</span>
    </span>
  );
}

const STAT_META: { bucket: Bucket; label: string; sub: string; color: string }[] = [
  { bucket: "sync", label: "In sync", sub: "converged to lock", color: "var(--sync)" },
  { bucket: "update", label: "Updates", sub: "behind data HEAD", color: "var(--update)" },
  { bucket: "drift", label: "Drifted", sub: "local edits", color: "var(--drift)" },
  { bucket: "local", label: "Kept-local", sub: "pinned by you", color: "var(--local)" },
];

export function StatStrip({ counts }: { counts: Record<Bucket, number> }) {
  return (
    <section className="stats">
      {STAT_META.map((s) => (
        <div className="stat" key={s.bucket}>
          <div className="top"><span className="d" style={{ background: s.color }} />{s.label}</div>
          <div className="n">{counts[s.bucket]}</div>
          <div className="sub">{s.sub}</div>
        </div>
      ))}
    </section>
  );
}

export function emptyCounts(): Record<Bucket, number> {
  return { sync: 0, update: 0, drift: 0, local: 0, external: 0 };
}
