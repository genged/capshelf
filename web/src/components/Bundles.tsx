import type { Catalog, ItemKind, StatusRow } from "../api";
import { KindIcon } from "../icons";
import { StatusBadge, ExternalBadge } from "./bits";
import { useCommand } from "./CommandDialog";

function parseMember(ref: string): { kind: ItemKind; name: string } {
  const [kind = "", ...rest] = ref.split("/");
  return { kind: kind as ItemKind, name: rest.join("/") || kind };
}

export function Bundles({
  catalog, installed,
}: {
  catalog: Catalog | null;
  installed: Map<string, StatusRow>;
}) {
  const showCommand = useCommand();
  if (!catalog) return <div className="content"><div className="skeleton" /></div>;
  const bundles = catalog.bundles ?? [];
  if (bundles.length === 0)
    return <div className="content"><div className="note">No bundles in this data repo.</div></div>;

  return (
    <div className="content">
      {bundles.map((b) => {
        const members = b.members.map(parseMember);
        const counts = members.reduce<Record<string, number>>((acc, m) => {
          acc[m.kind] = (acc[m.kind] ?? 0) + 1;
          return acc;
        }, {});
        const allInstalled = members.every((m) => installed.has(`${m.kind}/${m.name}`));
        return (
          <div className="bundle" key={b.name}>
            <div className="bh">
              <div>
                <div className="nm">{b.name}</div>
                {b.description && <div className="desc">{b.description}</div>}
              </div>
              <div className="chips">
                {Object.entries(counts).map(([k, n]) => (
                  <span className="chipc" key={k}>{n} {k}</span>
                ))}
              </div>
              <button
                className={`btn${allInstalled ? "" : " btn--primary"}`}
                style={{ marginLeft: 14 }}
                disabled={allInstalled}
                onClick={() => showCommand({ args: `add bundles/${b.name}` })}
              >
                {allInstalled ? "Installed" : "Add bundle"}
              </button>
            </div>
            {members.map((m) => {
              const row = installed.get(`${m.kind}/${m.name}`);
              return (
                <div className="member" key={`${m.kind}/${m.name}`}>
                  <span className="ti"><KindIcon kind={m.kind} /></span>
                  <div>
                    <div className="nm" style={{ fontSize: 13, fontWeight: 600 }}>{m.name}</div>
                    <div className="kd" style={{ fontSize: 11, color: "var(--faint)" }}>{m.kind}</div>
                  </div>
                  {row ? <StatusBadge state={row.state} /> : <ExternalBadge label="not installed" />}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
