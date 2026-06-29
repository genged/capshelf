import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Catalog, Health, StatusReport, StatusRow } from "./api";
import { Shell } from "./components/Shell";
import { Overview } from "./components/Overview";
import { ItemScreen } from "./components/ItemScreen";
import { Shelf } from "./components/Shelf";
import { Bundles } from "./components/Bundles";
import { Settings } from "./components/Settings";
import { Activity } from "./components/Activity";
import { CommandPalette } from "./components/CommandPalette";
import { bucketOf } from "./api";

const ROUTES = ["overview", "items", "shelf", "bundles", "activity", "settings"] as const;
type Route = (typeof ROUTES)[number];
const TITLE: Record<Route, string> = {
  overview: "Overview", items: "Items", shelf: "Shelf",
  bundles: "Bundles", activity: "Activity", settings: "Settings",
};

function currentRoute(): Route {
  const h = location.hash.replace(/^#/, "") as Route;
  return ROUTES.includes(h) ? h : "overview";
}

export default function App() {
  const [route, setRoute] = useState<Route>(currentRoute());
  const [health, setHealth] = useState<Health | null>(null);
  const [report, setReport] = useState<StatusReport | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(
    new URLSearchParams(location.search).get("cmdk") === "1",
  );

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // ⌘K / Ctrl-K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // theme
  useEffect(() => {
    if (localStorage.getItem("capshelf-theme") === "light")
      document.body.classList.add("light");
  }, []);
  const toggleTheme = useCallback(() => {
    const light = document.body.classList.toggle("light");
    localStorage.setItem("capshelf-theme", light ? "light" : "dark");
  }, []);

  // initial load: health + status
  useEffect(() => {
    Promise.all([api.health(), api.status()])
      .then(([h, r]) => { setHealth(h); setReport(r); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // catalog loaded lazily for shelf/bundles and palette search
  useEffect(() => {
    if ((route === "shelf" || route === "bundles" || paletteOpen) && !catalog)
      api.catalog().then(setCatalog).catch(() => setCatalog(null));
  }, [route, catalog, paletteOpen]);

  const installed = useMemo(() => {
    const m = new Map<string, StatusRow>();
    for (const r of report?.items ?? []) m.set(`${r.kind}/${r.name}`, r);
    return m;
  }, [report]);

  const attention = useMemo(
    () => (report?.items ?? []).filter((r) => {
      const b = bucketOf(r.state);
      return b === "update" || b === "drift";
    }).length,
    [report],
  );

  return (
    <>
      <Shell
        route={route}
        title={TITLE[route]}
        health={health}
        attention={attention}
        onToggleTheme={toggleTheme}
        onOpenPalette={() => setPaletteOpen(true)}
      >
        {error ? (
          <div className="content"><div className="note err">Couldn’t reach the capshelf API: {error}</div></div>
        ) : route === "overview" ? (
          report ? <Overview report={report} /> : <Loading />
        ) : route === "items" ? (
          report ? <ItemScreen report={report} /> : <Loading />
        ) : route === "shelf" ? (
          <Shelf catalog={catalog} installed={installed} />
        ) : route === "bundles" ? (
          <Bundles catalog={catalog} installed={installed} />
        ) : route === "activity" ? (
          <Activity />
        ) : (
          <Settings />
        )}
      </Shell>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        report={report}
        catalog={catalog}
      />
    </>
  );
}

function Loading() {
  return <div className="content"><div className="skeleton" /></div>;
}
