import { useEffect, useMemo, useRef, useState } from "react";
import type { Catalog, StatusReport } from "../api";
import { STATE_LABEL } from "../api";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

export function CommandPalette({
  open, onClose, report, catalog,
}: {
  open: boolean;
  onClose: () => void;
  report: StatusReport | null;
  catalog: Catalog | null;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const go = (hash: string) => () => { location.hash = hash; onClose(); };

  const commands = useMemo<Cmd[]>(() => {
    const nav: Cmd[] = [
      ["overview", "Overview"], ["items", "Items"], ["shelf", "Shelf"],
      ["bundles", "Bundles"], ["activity", "Activity"], ["settings", "Settings"],
    ].map(([id, label]) => ({ id: `nav-${id}`, label: label!, group: "Go to", run: go(`#${id}`) }));

    const items: Cmd[] = (report?.items ?? []).map((r) => ({
      id: `item-${r.kind}-${r.name}`,
      label: r.name,
      hint: `${r.kind} · ${STATE_LABEL[r.state] ?? r.state}`,
      group: "Items",
      run: go("#items"),
    }));

    const shelf: Cmd[] = catalog
      ? [...catalog.data, ...catalog.system].map((c) => ({
          id: `cat-${c.kind}-${c.name}`,
          label: c.name,
          hint: `${c.kind} · shelf`,
          group: "Shelf",
          run: go("#shelf"),
        }))
      : [];

    return [...nav, ...items, ...shelf];
  }, [report, catalog]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? commands.filter((c) =>
          (c.label + " " + (c.hint ?? "")).toLowerCase().includes(needle),
        )
      : commands;
    return list.slice(0, 50);
  }, [commands, q]);

  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  useEffect(() => { setSel(0); }, [q]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); results[sel]?.run(); }
  };

  let lastGroup = "";
  return (
    <div className="pal-backdrop" onClick={onClose}>
      <div className="pal" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input
          ref={inputRef}
          className="pal-input"
          placeholder="Jump to a screen or item…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="pal-list">
          {results.length === 0 && <div className="note">No matches.</div>}
          {results.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head && <div className="pal-group">{head}</div>}
                <div
                  className={`pal-item${i === sel ? " sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => c.run()}
                >
                  <span className="pal-label">{c.label}</span>
                  {c.hint && <span className="pal-hint">{c.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="pal-foot"><span><span className="pal-kbd">↑↓</span> navigate</span><span><span className="pal-kbd">↵</span> open</span><span><span className="pal-kbd">esc</span> close</span></div>
      </div>
    </div>
  );
}
