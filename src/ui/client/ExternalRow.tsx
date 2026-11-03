import type { ExternalUserSkill } from "../../external";
import type { ExternalEntry } from "../shared/view-model";
import { DetailHead } from "./ItemDetail";
import { Icon, type IconName } from "./icons";

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

export interface ExternalRowText {
  icon: IconName;
  kind: string;
  state: string;
}

/** The list row's quiet words for an external entry. */
export function externalRowText(entry: ExternalEntry): ExternalRowText {
  switch (entry.type) {
    case "skills.sh":
      return { icon: "notequal", kind: "skill", state: "skills.sh" };
    case "plugin":
      return {
        icon: "notequal",
        kind: "Claude plugin",
        state: `${entry.plugin.scope}${entry.plugin.enabled ? "" : ", disabled"}`,
      };
    case "user-skill":
      return {
        icon: "notequal",
        kind: `${entry.skill.surface === "claude" ? "Claude" : "Codex"} user skill`,
        state:
          entry.skill.shadows.length > 0
            ? entry.skill.surface === "claude"
              ? "Shadows"
              : "Same name"
            : "home folder",
      };
  }
}

/**
 * The detail of something a harness loads here that Capshelf does not
 * manage. It has no pin, no diff, and no command. It says who manages it
 * and where it lives.
 */
export function ExternalDetail({
  entry,
  project,
  projectName,
  displayPath,
  onBack,
}: {
  entry: ExternalEntry;
  project: string;
  projectName: string;
  displayPath: (path: string) => string;
  onBack: () => void;
}): preact.JSX.Element {
  const managedBy =
    entry.type === "skills.sh"
      ? "Managed by skills.sh."
      : entry.type === "plugin"
        ? "Enabled in Claude settings."
        : "A user-level skill from the home folder.";
  const shadows = entry.type === "user-skill" ? entry.skill.shadows : [];
  const words =
    entry.type === "user-skill" ? shadowWording(entry.skill.surface) : null;
  return (
    <article class="detail" aria-label={entry.name}>
      <div class="action-bar">
        <span class="action-bar-who">
          <Icon name="notequal" />
          <b>{entry.name}</b>
          <span>in {projectName}</span>
        </span>
        <span class="action-bar-note">Not managed by Capshelf</span>
      </div>
      <div class="detail-body">
        <DetailHead
          crumbs={<>{projectName} / Not managed by Capshelf</>}
          title={entry.name}
          backLabel={projectName}
          onBack={onBack}
        >
          <p class="detail-state">
            <Icon name="notequal" />
            <span>
              <b>{managedBy}</b>{" "}
              <span class="muted">
                Capshelf reports it and never edits it. It has no pin and no
                diff.
              </span>
            </span>
          </p>
        </DetailHead>

        {words && shadows.length > 0 && entry.type === "user-skill" ? (
          <section class="detail-section">
            <p
              class={`banner${words.tone === "attention" ? " tone-attention" : ""}`}
            >
              <Icon name={words.tone === "attention" ? "alert" : "notequal"} />
              <span>
                {words.tone === "attention"
                  ? "Claude loads this personal copy first, so it "
                  : "It has the "}
                {words.lead === "shadows" ? "shadows " : "same name as "}
                {shadows.map((shadow, index) => (
                  <span key={shadowedItemId(entry.skill, shadow)}>
                    {index > 0 ? ", " : ""}
                    <a
                      href={`#/status/${encodeURIComponent(project)}/${encodeURIComponent(shadowedItemId(entry.skill, shadow))}`}
                    >
                      the {shadow.scope} skill {entry.skill.name}
                    </a>
                  </span>
                ))}
                {words.tail}.
              </span>
            </p>
          </section>
        ) : null}

        <section class="detail-section">
          <div class="card">
            <dl class="props">
              {entry.type === "skills.sh" ? (
                <>
                  <dt>Kind</dt>
                  <dd>Skill</dd>
                  <dt>Source</dt>
                  <dd class="mono">{entry.skill.source || "not recorded"}</dd>
                  <dt>Recorded in</dt>
                  <dd class="mono">skills-lock.json</dd>
                </>
              ) : entry.type === "plugin" ? (
                <>
                  <dt>Kind</dt>
                  <dd>Claude plugin</dd>
                  <dt>Id</dt>
                  <dd class="mono">{entry.plugin.id}</dd>
                  <dt>Scope</dt>
                  <dd>{entry.plugin.scope}</dd>
                  <dt>State</dt>
                  <dd>{entry.plugin.enabled ? "enabled" : "disabled"}</dd>
                  <dt>Settings</dt>
                  <dd class="mono">{displayPath(entry.plugin.settingsPath)}</dd>
                </>
              ) : (
                <>
                  <dt>Kind</dt>
                  <dd>
                    {entry.skill.surface === "claude" ? "Claude" : "Codex"}{" "}
                    user-level skill
                  </dd>
                  <dt>Path</dt>
                  <dd class="mono">{displayPath(entry.skill.path)}</dd>
                  <dt>Loaded by</dt>
                  <dd>
                    {entry.skill.surface === "claude" ? "Claude" : "Codex"}, in
                    every project on this machine
                  </dd>
                </>
              )}
            </dl>
          </div>
          {entry.type === "user-skill" ||
          (entry.type === "plugin" &&
            (entry.plugin.scope === "user" ||
              entry.plugin.scope === "managed")) ? (
            <p class="section-note">
              <a href="#/machine">This machine</a> lists everything in the home
              folder.
            </p>
          ) : null}
        </section>
      </div>
    </article>
  );
}
