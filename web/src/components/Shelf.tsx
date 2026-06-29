import { useMemo } from "react";
import type { Catalog, ItemKind, StatusRow } from "../api";
import { KindIcon } from "../icons";
import { StatusBadge } from "./bits";
import { useCommand } from "./CommandDialog";

export function Shelf({
  catalog, installed,
}: {
  catalog: Catalog | null;
  installed: Map<string, StatusRow>;
}) {
  const all = useMemo(
    () => (catalog ? [...catalog.system, ...catalog.data] : []),
    [catalog],
  );
  const skills = all.filter((i) => i.kind === "skills");
  const frags = all.filter((i) => i.kind !== "skills");

  if (!catalog) return <div className="content"><div className="skeleton" /></div>;

  return (
    <div className="content">
      <div className="toolbar">
        <div className="tabs">
          <button className="on">All <span className="pill">{all.length}</span></button>
          <button>Skills <span className="pill">{skills.length}</span></button>
          <button>Settings · MCP <span className="pill">{frags.length}</span></button>
        </div>
      </div>

      {!catalog.dataRepoReady && (
        <div className="note">No data repo bound — only system items are shown. Run <span className="mono">capshelf set-data &lt;path&gt;</span>.</div>
      )}

      <Section title="Skills" items={skills} installed={installed} />
      <Section title="Settings · MCP · Codex" items={frags} installed={installed} />
    </div>
  );
}

function Section({
  title, items, installed,
}: {
  title: string;
  items: Catalog["data"];
  installed: Map<string, StatusRow>;
}) {
  const showCommand = useCommand();
  if (items.length === 0) return null;
  return (
    <>
      <div className="sec-h"><h3>{title}</h3><div className="ln" /></div>
      <div className="cat">
        {items.map((it) => {
          const row = installed.get(`${it.kind as ItemKind}/${it.name}`);
          return (
            <div className="card" key={`${it.source}/${it.kind}/${it.name}`}>
              <div className="ch">
                <span className="ti"><KindIcon kind={it.kind} /></span>
                <div>
                  <div className="nm">{it.name}</div>
                  <div className="kd">{it.kind} · {it.source}</div>
                </div>
              </div>
              {it.description && <div className="desc">{it.description}</div>}
              {it.tags && it.tags.length > 0 && (
                <div className="tagrow">{it.tags.map((t) => <span className="tag" key={t}>#{t}</span>)}</div>
              )}
              <div className="foot">
                {row ? (
                  <StatusBadge state={row.state} />
                ) : (
                  <button
                    className="btn btn--sm add"
                    onClick={() => showCommand({ args: `add ${it.kind}/${it.name}` })}
                  >
                    Add
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
