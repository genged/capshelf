import { useEffect, useMemo, useState } from "react";
import { api, bucketOf } from "../api";
import type { StatusDiff, StatusReport, StatusRow } from "../api";
import { KindIcon, IconClose, IconCopy } from "../icons";
import { StatusBadge, VersionCell, short } from "./bits";

const refOf = (r: StatusRow) => `${r.kind}/${r.name}`;

export function ItemScreen({ report }: { report: StatusReport }) {
  const ordered = useMemo(
    () =>
      [...report.items].sort(
        (a, b) => rank(bucketOf(a.state)) - rank(bucketOf(b.state)),
      ),
    [report],
  );
  const [selRef, setSelRef] = useState<string | null>(ordered[0] ? refOf(ordered[0]) : null);
  const selected = ordered.find((r) => refOf(r) === selRef) ?? ordered[0] ?? null;

  return (
    <div className="content">
      <div className={`layout${selected ? " with-drawer" : ""}`}>
        <section className="table">
          <div className="thead"><div /><div className="th">Item</div><div className="th">Status</div></div>
          {ordered.length === 0 && <div className="note">No items installed.</div>}
          {ordered.map((r) => (
            <div
              className={`tr${selected && refOf(r) === refOf(selected) ? " active" : ""}`}
              key={refOf(r)}
              onClick={() => setSelRef(refOf(r))}
            >
              <span className="cbx" />
              <div className="cell-item">
                <span className="ti"><KindIcon kind={r.kind} /></span>
                <div>
                  <div className="nm">{r.name}</div>
                  <div className="kd">{r.kind}{r.local ? " · pinned" : ""}</div>
                </div>
              </div>
              <div className="badge-cell"><StatusBadge state={r.state} /></div>
            </div>
          ))}
        </section>
        {selected && <Drawer row={selected} onClose={() => setSelRef(null)} />}
      </div>
    </div>
  );
}

function Drawer({ row, onClose }: { row: StatusRow; onClose: () => void }) {
  const bucket = bucketOf(row.state);
  const [diff, setDiff] = useState<StatusDiff | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    if (bucket !== "drift") { setDiff(null); return; }
    setLoading(true);
    api
      .status({ item: `${row.kind}/${row.name}`, diff: true })
      .then((r) => { if (live) setDiff(r.diffs?.[0] ?? null); })
      .catch(() => { if (live) setDiff(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [row.kind, row.name, bucket]);

  const cli =
    bucket === "drift"
      ? `revert ${row.kind}/${row.name}`
      : bucket === "update"
        ? `update ${row.kind}/${row.name}`
        : `status ${row.kind}/${row.name}`;

  return (
    <aside className="drawer">
      <div className="dw-head">
        <span className="ti"><KindIcon kind={row.kind} /></span>
        <div>
          <div className="nm">{row.name}</div>
          <div className="kd">{row.kind} · {row.source}</div>
        </div>
        <button className="x" onClick={onClose} aria-label="close"><IconClose /></button>
      </div>

      <div className="dw-meta">
        <StatusBadge state={row.state} />
        <span className="ver"><VersionInline row={row} /></span>
      </div>

      <div className="dw-tabs"><span className="on">Diff</span><span>Metadata</span><span>History</span></div>

      {bucket === "drift" ? (
        loading ? (
          <div className="note">Loading diff…</div>
        ) : diff ? (
          <DiffView text={diff.text} />
        ) : (
          <div className="note">No textual diff available.</div>
        )
      ) : (
        <div className="note">
          {bucket === "update"
            ? "Newer content is available in the data repo. Apply to converge."
            : bucket === "local"
              ? "Pinned locally — reconciliation tolerates this divergence."
              : "This item is in sync with its locked content."}
        </div>
      )}

      <div className="dw-sec">
        <div className="lbl">Versions</div>
        <div className="kv"><span className="k">Locked</span><span className="v">{short(row.lockedSha, 12)}</span></div>
        {row.currentSha && <div className="kv"><span className="k">Current</span><span className="v">{short(row.currentSha, 12)}</span></div>}
        {row.upstreamSha && <div className="kv"><span className="k">Upstream</span><span className="v">{short(row.upstreamSha, 12)}</span></div>}
        {row.sourceCommit && <div className="kv"><span className="k">Source commit</span><span className="v">{short(row.sourceCommit, 12)}</span></div>}
      </div>

      <div className="dw-sec">
        <div className="lbl">Equivalent command</div>
        <div className="cli"><span><span className="p">capshelf</span> {cli}</span>
          <IconCopy className="ico cp" />
        </div>
      </div>
    </aside>
  );
}

function VersionInline({ row }: { row: StatusRow }) {
  return <VersionCell row={row} />;
}

function DiffView({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="diff">
      {lines.map((line, i) => {
        const cls = line.startsWith("+") && !line.startsWith("+++")
          ? "add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "del"
            : "ctx";
        const gut = cls === "add" ? "+" : cls === "del" ? "-" : " ";
        const body = cls === "ctx" ? line : line.slice(1);
        return (
          <div className={`dl ${cls}`} key={i}>
            <span className="gut">{gut}</span>
            <span className="tx">{body || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

function rank(bucket: ReturnType<typeof bucketOf>): number {
  return { drift: 0, update: 1, local: 2, sync: 3, external: 4 }[bucket];
}
