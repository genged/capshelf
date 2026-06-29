import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { IconCopy, IconCheck, IconClose } from "../icons";

interface CommandRequest {
  /** args after `capshelf`, e.g. "update settings/permissions-base" */
  args: string;
  title?: string;
  note?: string;
}

type Show = (req: CommandRequest) => void;
const Ctx = createContext<Show>(() => {});

/** Open the command dialog from anywhere: const show = useCommand(). */
export function useCommand(): Show {
  return useContext(Ctx);
}

export function CommandProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<CommandRequest | null>(null);
  const show = useCallback<Show>((r) => setReq(r), []);

  // ?cmd=<args> deep-links the dialog open (shareable "run this" links).
  useEffect(() => {
    const args = new URLSearchParams(location.search).get("cmd");
    if (args) setReq({ args });
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      {req && <Dialog req={req} onClose={() => setReq(null)} />}
    </Ctx.Provider>
  );
}

function Dialog({ req, onClose }: { req: CommandRequest; onClose: () => void }) {
  const full = `capshelf ${req.args}`;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="pal-backdrop" onClick={onClose}>
      <div className="cmddlg" onClick={(e) => e.stopPropagation()}>
        <div className="cmddlg-head">
          <div className="cmddlg-title">{req.title ?? "Run this in your terminal"}</div>
          <button className="x" onClick={onClose} aria-label="close"><IconClose /></button>
        </div>
        <button className="cmddlg-code" onClick={copy} title="Copy">
          <span><span className="p">capshelf</span> {req.args}</span>
          <span className="cmddlg-copy">
            {copied ? <IconCheck className="ico" /> : <IconCopy className="ico" />}
            {copied ? "Copied" : "Copy"}
          </span>
        </button>
        <p className="cmddlg-note">
          {req.note ??
            "capshelf serve is read-only — run this to make the change, then it’ll show up here."}
        </p>
      </div>
    </div>
  );
}
