import type { ComponentChildren } from "preact";
import type { ExternalUserSkill } from "../../external";
import { StateBadge } from "./common";

/** `<scope>/<source>/skills/<name>`, the id a shadowed item has in the UI. */
export function shadowedItemId(
  skill: ExternalUserSkill,
  shadow: ExternalUserSkill["shadows"][number],
): string {
  return `${shadow.scope}/${shadow.source}/skills/${skill.name}`;
}

/**
 * The per-harness sentence for a user-level skill that shares a name with a
 * managed skill. Claude loads its personal copy first, so that is a shadow.
 * Codex offers both copies, so that is a name clash and not a finding.
 */
export function shadowWording(surface: ExternalUserSkill["surface"]): {
  lead: string;
  tail: string;
  tone: "attention" | "muted";
} {
  return surface === "claude"
    ? { lead: "shadows", tail: "", tone: "attention" }
    : { lead: "same name as", tail: ", Codex offers both", tone: "muted" };
}

/**
 * A read-only row for something a harness loads in this project that
 * Capshelf does not manage. It sits in a kind group beside the panels, has
 * no pin, no commands, and no diff, and says where it lives.
 */
export function ExternalRow({
  domId,
  itemRef,
  origin,
  detail,
  note,
  children,
  machineLink,
}: {
  domId: string;
  itemRef: string;
  origin: string;
  detail: string;
  note: string;
  children?: ComponentChildren;
  machineLink?: boolean | undefined;
}): preact.JSX.Element {
  const slash = itemRef.indexOf("/");
  const prefix = slash === -1 ? "" : itemRef.slice(0, slash + 1);
  const name = slash === -1 ? itemRef : itemRef.slice(slash + 1);
  return (
    <div id={domId} class="panel panel-external" title={note}>
      <div class="panel-static">
        <span class="panel-ref">
          <span class="panel-ref-kind">{prefix}</span>
          {name}
        </span>
        <span class="chip chip-origin">{origin}</span>
        <span class="panel-detail muted">{detail}</span>
        {children}
        {machineLink ? (
          <a class="panel-link" href="#/machine">
            This machine
          </a>
        ) : null}
        <StateBadge icon="notequal" tone="external" label="External" />
      </div>
    </div>
  );
}
