import { api } from "../api";
import { useFetch } from "../useFetch";

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function Activity() {
  const { data, error: err } = useFetch(api.activity);

  if (err) return <div className="content"><div className="note err">{err}</div></div>;
  if (!data) return <div className="content"><div className="skeleton" /></div>;
  if (!data.dataRepoReady)
    return <div className="content"><div className="note">No data repo bound — bind one to see its history.</div></div>;
  if (data.commits.length === 0)
    return <div className="content"><div className="note">No commits in the data repo yet.</div></div>;

  return (
    <div className="content" style={{ maxWidth: 820 }}>
      <div className="sec-h"><h3>Data repo history</h3><div className="ln" /></div>
      <section className="table">
        {data.commits.map((c, i) => (
          <div className="tr" key={c.sha} style={{ gridTemplateColumns: "16px 1fr auto", gap: 14, cursor: "default" }}>
            <Node head={i === 0 && c.sha === data.head} last={i === data.commits.length - 1} />
            <div className="cell-item">
              <div style={{ minWidth: 0 }}>
                <div className="nm" style={{ whiteSpace: "normal" }}>{c.subject}</div>
                <div className="kd">{c.author} · <span className="mono">{c.sha.slice(0, 7)}</span></div>
              </div>
            </div>
            <div className="src" style={{ color: "var(--faint)" }}>{ago(c.date)}</div>
          </div>
        ))}
      </section>
    </div>
  );
}

function Node({ head, last }: { head: boolean; last: boolean }) {
  return (
    <div style={{ position: "relative", height: "100%", minHeight: 40, justifySelf: "center" }}>
      {!last && <span style={{ position: "absolute", left: "50%", top: 22, bottom: -14, width: 1, background: "var(--line-2)", transform: "translateX(-50%)" }} />}
      <span style={{
        position: "absolute", left: "50%", top: 18, width: 9, height: 9, borderRadius: "50%",
        transform: "translate(-50%,-50%)",
        background: head ? "var(--accent)" : "var(--panel)",
        border: `2px solid ${head ? "var(--accent)" : "var(--line-2)"}`,
        boxShadow: head ? "0 0 8px var(--accent)" : "none",
      }} />
    </div>
  );
}
