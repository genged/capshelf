import { useMemo, useState } from "react";
import type { StatusReport } from "../api";
import { bucketOf } from "../api";
import { KindIcon, IconMore } from "../icons";
import { StatStrip, StatusBadge, ExternalBadge, VersionCell, emptyCounts } from "./bits";
import { useCommand } from "./CommandDialog";
import type { StatusRow } from "../api";

type Tab = "all" | "attention" | "sync" | "local" | "external";

function rowCommand(r: StatusRow): string {
  const ref = `${r.kind}/${r.name}`;
  switch (bucketOf(r.state)) {
    case "update": return `update ${ref}`;
    case "drift": return `revert ${ref}`;
    case "local": return `keep-local ${ref}`;
    default: return `status ${ref}`;
  }
}

export function Overview({ report }: { report: StatusReport }) {
  const [tab, setTab] = useState<Tab>("all");
  const showCommand = useCommand();

  const counts = useMemo(() => {
    const c = emptyCounts();
    for (const r of report.items) c[bucketOf(r.state)]++;
    c.external = report.external.length + report.externalClaudePlugins.length;
    return c;
  }, [report]);

  const rows = useMemo(() => {
    if (tab === "external") return [];
    return report.items.filter((r) => {
      const b = bucketOf(r.state);
      if (tab === "all") return true;
      if (tab === "attention") return b === "update" || b === "drift";
      if (tab === "sync") return b === "sync";
      if (tab === "local") return b === "local";
      return true;
    });
  }, [report, tab]);

  const attention = counts.update + counts.drift;

  return (
    <div className="content">
      <StatStrip counts={counts} />

      <div className="toolbar">
        <div className="tabs">
          <TabBtn id="all" tab={tab} set={setTab} label="All" n={report.items.length} />
          <TabBtn id="attention" tab={tab} set={setTab} label="Needs attention" n={attention} att />
          <TabBtn id="sync" tab={tab} set={setTab} label="In sync" n={counts.sync} />
          <TabBtn id="local" tab={tab} set={setTab} label="Kept-local" n={counts.local} />
          <TabBtn id="external" tab={tab} set={setTab} label="External" n={counts.external} />
        </div>
        <div className="tb-right">
          <button className="btn btn--sm">Kind</button>
          <button className="btn btn--sm">Sort</button>
        </div>
      </div>

      <section className="table">
        <div className="thead">
          <div /><div className="th">Item</div><div className="th">Source</div>
          <div className="th">Version</div><div className="th">Status</div><div />
        </div>

        {tab === "external" ? (
          <ExternalRows report={report} />
        ) : rows.length === 0 ? (
          <div className="note">Nothing here.</div>
        ) : (
          rows.map((r) => (
            <div
              className="tr"
              key={`${r.scope}/${r.source}/${r.kind}/${r.name}`}
              onClick={() => { location.hash = "#items"; }}
            >
              <span className="cbx" />
              <div className="cell-item">
                <span className="ti"><KindIcon kind={r.kind} /></span>
                <div>
                  <div className="nm">{r.name}</div>
                  <div className="kd">{r.kind}{r.local ? " · pinned by you" : ""}</div>
                </div>
              </div>
              <div className="src src-cell">{r.source}</div>
              <div className="ver-cell"><VersionCell row={r} /></div>
              <div className="badge-cell"><StatusBadge state={r.state} /></div>
              <button
                className="rowmore"
                title="Show command"
                onClick={(e) => { e.stopPropagation(); showCommand({ args: rowCommand(r) }); }}
              >
                <IconMore />
              </button>
            </div>
          ))
        )}

        <div className="tfoot">
          Showing {tab === "external" ? counts.external : rows.length} of {report.items.length + counts.external}
        </div>
      </section>
    </div>
  );
}

function TabBtn({ id, tab, set, label, n, att }: {
  id: Tab; tab: Tab; set: (t: Tab) => void; label: string; n: number; att?: boolean;
}) {
  return (
    <button className={`${tab === id ? "on" : ""}${att ? " att" : ""}`} onClick={() => set(id)}>
      {label} <span className="pill">{n}</span>
    </button>
  );
}

function ExternalRows({ report }: { report: StatusReport }) {
  const items = [
    ...report.external.map((e) => ({ name: e.name, kind: "skills" as const, note: e.source ?? "skills.sh" })),
    ...report.externalClaudePlugins.map((p) => ({ name: p.name, kind: "skills" as const, note: "Claude plugin" })),
  ];
  if (items.length === 0) return <div className="note">No external items.</div>;
  return (
    <>
      {items.map((e, i) => (
        <div className="tr tr--ext" key={`${e.name}-${i}`}>
          <span className="cbx" />
          <div className="cell-item">
            <span className="ti"><KindIcon kind={e.kind} /></span>
            <div><div className="nm">{e.name}</div><div className="kd">{e.kind} · {e.note}</div></div>
          </div>
          <div className="src src-cell">external</div>
          <div className="ver-cell"><span className="ver">not co-managed</span></div>
          <div className="badge-cell"><ExternalBadge /></div>
          <div className="rowmore" />
        </div>
      ))}
    </>
  );
}
