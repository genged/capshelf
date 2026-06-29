import type { ReactNode } from "react";
import type { Health } from "../api";
import {
  IconActivity, IconBundles, IconItems, IconOverview, IconSearch,
  IconSettings, IconShelf, IconSync, IconMenu, IconClock,
} from "../icons";

const NAV = [
  { id: "overview", label: "Overview", Icon: IconOverview },
  { id: "items", label: "Items", Icon: IconItems, attention: true },
  { id: "shelf", label: "Shelf", Icon: IconShelf },
  { id: "bundles", label: "Bundles", Icon: IconBundles },
  { id: "activity", label: "Activity", Icon: IconActivity },
] as const;

function repoName(dataRepo: string | null): string {
  if (!dataRepo) return "no data repo";
  const parts = dataRepo.replace(/\/$/, "").split("/");
  return parts.slice(-2).join("/") || dataRepo;
}

export function Shell({
  route, title, health, attention, onToggleTheme, onOpenPalette, children,
}: {
  route: string;
  title: string;
  health: Health | null;
  attention: number;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <aside className="sb">
        <div className="sb-brand">
          <div className="logo">C</div>
          <div className="nm">capshelf</div>
          <div className="tag">serve</div>
        </div>
        <a className="switcher" href="#settings" title="Data repo">
          <span className={`dot${health?.dataRepoReady ? "" : " off"}`} />
          <div className="info">
            <div className="repo">{repoName(health?.dataRepo ?? null)}</div>
            <div className="sub">{health?.dataRepoReady ? "synced" : "not bound"}</div>
          </div>
        </a>

        <div className="nav-label">Project</div>
        <nav className="nav">
          {NAV.map((item) => {
            const showCount = "attention" in item && item.attention && attention > 0;
            return (
              <a key={item.id} href={`#${item.id}`} className={route === item.id ? "on" : ""}>
                <item.Icon />
                {item.label}
                {showCount ? <span className="count">{attention}</span> : null}
              </a>
            );
          })}
        </nav>
        <div className="nav-label" style={{ marginTop: 10 }}>Workspace</div>
        <nav className="nav">
          <a href="#settings" className={route === "settings" ? "on" : ""}><IconSettings /> Settings</a>
        </nav>

        <div className="sb-foot">
          <div className="conn">
            <IconClock className="ico" />
            {health ? "localhost" : "connecting…"}
            <span className="ro">read-only</span>
          </div>
          <div className="user">
            <div className="av" />
            <div>
              <div className="un">you</div>
              <div className="ue">{health?.version ? `capshelf ${health.version}` : ""}</div>
            </div>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="hamb" aria-label="menu"><IconMenu /></button>
          <div className="crumb">
            <span className="c1">{health ? projectName(health.project) : "…"}</span>
            <span className="sep">/</span>
            <span className="c2">{title}</span>
          </div>
          <div className="grow" />
          <button className="search" onClick={onOpenPalette} style={{ cursor: "pointer" }}>
            <IconSearch className="ico" />
            <span style={{ flex: 1, textAlign: "left" }}>Search…</span>
            <span className="k">⌘K</span>
          </button>
          <button className="btn btn--icon" title="Toggle theme" onClick={onToggleTheme}>
            <IconSync className="ico" />
          </button>
        </header>
        {children}
      </div>

      <nav className="tabbar">
        <a href="#overview" className={route === "overview" ? "on" : ""}><IconOverview /> Overview</a>
        <a href="#items" className={route === "items" ? "on" : ""}><IconItems /> Items</a>
        <a href="#shelf" className={route === "shelf" ? "on" : ""}><IconShelf /> Shelf</a>
        <a href="#bundles" className={route === "bundles" ? "on" : ""}><IconBundles /> Bundles</a>
      </nav>
    </div>
  );
}

function projectName(project: string): string {
  return project.replace(/\/$/, "").split("/").pop() || project;
}
