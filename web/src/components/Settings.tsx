import { api } from "../api";
import { useFetch } from "../useFetch";

export function Settings() {
  const { data: cfg, error: err } = useFetch(api.config);

  if (err) return <div className="content"><div className="note err">{err}</div></div>;
  if (!cfg) return <div className="content"><div className="skeleton" /></div>;

  return (
    <div className="content" style={{ maxWidth: 760 }}>
      <Card title="Data repo">
        <Row k="Binding" v={cfg.dataRepo ?? "not bound"} mono />
        <Row k="Status" v={cfg.dataRepoReady ? "ready" : "unavailable"} />
        {cfg.dataRepoUpstream && <Row k="Upstream" v={cfg.dataRepoUpstream} mono />}
      </Card>

      <Card title="Project">
        <Row k="Root" v={cfg.project} mono />
        <Row k="Install mode" v={cfg.installMode} mono />
        <Row k="Manifest" v={cfg.paths.manifest} mono />
        <Row k="Lock" v={cfg.paths.lock} mono />
      </Card>

      <Card title="Tracked items">
        <Row k="Project scope" v={String(cfg.counts.tracked)} />
        <Row k="Local scope" v={String(cfg.counts.local)} />
        <Row k="By kind" v={`${cfg.counts.skills} skills · ${cfg.counts.settings} settings · ${cfg.counts.mcp} mcp · ${cfg.counts.codexConfig} codex`} />
      </Card>

      <Card title="Server">
        <Row k="Mode" v="read-only" />
        <p className="note" style={{ textAlign: "left", padding: "4px 0 0", color: "var(--faint)" }}>
          The web server never mutates project or data-repo state. Use the CLI for
          writes: <span className="mono">apply</span>, <span className="mono">update</span>,{" "}
          <span className="mono">promote</span>, <span className="mono">share</span>.
        </p>
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="table" style={{ marginBottom: 16 }}>
      <div className="thead" style={{ display: "flex" }}>
        <div className="th">{title}</div>
      </div>
      <div style={{ padding: "6px 16px 12px" }}>{children}</div>
    </section>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="kv" style={{ padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
      <span className="k">{k}</span>
      <span className={mono ? "v" : ""} style={mono ? {} : { color: "var(--text)" }}>{v}</span>
    </div>
  );
}
