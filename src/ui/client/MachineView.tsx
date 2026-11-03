import type { ExternalClaudePlugin, ExternalUserSkill } from "../../external";
import type { UiOverview, UiProjectStatus } from "../shared/api-types";
import { homeDisplay } from "../shared/display";
import {
  machinePluginKey,
  machineSkillKey,
  splitDisplayPath,
} from "../shared/view-model";
import { EmptyState, PaneFocus, Skeleton } from "./common";
import type { ProjectLoad } from "./dashboard";
import { shadowedItemId, shadowWording } from "./ExternalRow";
import { DetailHead } from "./ItemDetail";
import { onListKeyDown } from "./ItemRow";
import { Icon } from "./icons";

interface SkillEntry {
  type: "skill";
  key: string;
  skill: ExternalUserSkill;
  /** One entry per project and lock entry that shares the skill's name. */
  clashes: Array<{ project: string; name: string; itemId: string }>;
}

interface PluginEntry {
  type: "plugin";
  key: string;
  plugin: ExternalClaudePlugin;
  projects: string[];
}

type MachineEntry = SkillEntry | PluginEntry;

/**
 * What lives in the home folder: user-level skills and user or managed
 * plugins. Every project on the machine loads them. The view is built from
 * the project statuses the dashboard has already loaded; the inventory is
 * the same in each, only the name clashes differ per project.
 */
export function MachineView({
  overview,
  loads,
  entry: selected,
  onSelect,
}: {
  overview: UiOverview | null;
  loads: Map<string, ProjectLoad>;
  /** The route's entry key, so a link or a Jump row opens one entry. */
  entry: string | null;
  onSelect: (entry: string | null) => void;
}): preact.JSX.Element {
  if (overview === null) {
    return (
      <main class="page-message">
        <Skeleton lines={4} label="Loading this machine" />
      </main>
    );
  }
  const display = (path: string): string => homeDisplay(path, overview.home);
  const ready: UiProjectStatus[] = [];
  let pending = 0;
  // A failed refresh keeps old data; this view reads current statuses only.
  for (const load of loads.values()) {
    if (load.data && load.state !== "error") ready.push(load.data);
    else if (load.state === "loading") pending += 1;
  }

  const skills = new Map<string, SkillEntry>();
  const plugins = new Map<string, PluginEntry>();
  for (const status of ready) {
    const projectName = splitDisplayPath(status.display).name;
    for (const skill of status.externalUserSkills) {
      const key = machineSkillKey(skill);
      const entry = skills.get(key) ?? {
        type: "skill" as const,
        key,
        skill,
        clashes: [],
      };
      for (const shadow of skill.shadows) {
        entry.clashes.push({
          project: status.project,
          name: projectName,
          itemId: shadowedItemId(skill, shadow),
        });
      }
      skills.set(key, entry);
    }
    for (const plugin of status.externalClaudePlugins) {
      if (plugin.scope !== "user" && plugin.scope !== "managed") continue;
      const key = machinePluginKey(plugin);
      const entry = plugins.get(key) ?? {
        type: "plugin" as const,
        key,
        plugin,
        projects: [],
      };
      entry.projects.push(projectName);
      plugins.set(key, entry);
    }
  }
  const skillRows = [...skills.values()].sort(
    (a, b) =>
      a.skill.name.localeCompare(b.skill.name) ||
      a.skill.surface.localeCompare(b.skill.surface),
  );
  const groups: Array<{ label: string; rows: MachineEntry[] }> = [
    {
      label: "Claude personal skills",
      rows: skillRows.filter((entry) => entry.skill.surface === "claude"),
    },
    {
      label: "Codex user skills",
      rows: skillRows.filter((entry) => entry.skill.surface === "codex"),
    },
    {
      label: "Claude plugins, user or managed scope",
      rows: [...plugins.values()].sort((a, b) =>
        a.plugin.id.localeCompare(b.plugin.id),
      ),
    },
  ].filter((group) => group.rows.length > 0);
  const all = groups.flatMap((group) => group.rows);
  // A finding first: a personal Claude skill that hides a managed one.
  const current =
    all.find((entry) => entry.key === selected) ??
    all.find(
      (entry) =>
        entry.type === "skill" &&
        entry.skill.surface === "claude" &&
        entry.clashes.length > 0,
    ) ??
    all[0] ??
    null;

  const hasSelection = current !== null && current.key === selected;
  return (
    <div class={`frame is-machine${hasSelection ? " has-selection" : ""}`}>
      <PaneFocus selection={hasSelection ? selected : null} />
      <section class="list" aria-label="This machine">
        <div class="list-head">
          <h1 class="list-title">This machine</h1>
          <p class="list-sub">
            Skills and plugins in the home folder. Every project on this machine
            loads them. Capshelf reports them and never edits them.
          </p>
        </div>
        {ready.length === 0 ? (
          <div class="list-empty">
            {pending > 0 ? (
              <Skeleton lines={4} label="Reading the projects" />
            ) : (
              "No project has been read yet. The inventory comes from the project statuses."
            )}
          </div>
        ) : all.length === 0 ? (
          <p class="list-empty">
            No user-level skill and no user or managed Claude plugin.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h2 class="list-group-head">
                {group.label}
                <span class="count">{group.rows.length}</span>
              </h2>
              <ul class="list-rows">
                {group.rows.map((entry) => (
                  <MachineRow
                    key={entry.key}
                    entry={entry}
                    selected={current?.key === entry.key}
                    display={display}
                    onSelect={() => onSelect(entry.key)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
        <h2 class="list-group-head">Registry</h2>
        <p class="list-sub list-registry">
          <span class="mono">{overview.registryDisplay}</span> ·{" "}
          {overview.projects.length}{" "}
          {overview.projects.length === 1 ? "project" : "projects"}
          {pending > 0 ? ` · ${pending} loading` : ""}
        </p>
      </section>
      {current === null ? (
        <section class="detail detail-empty">
          <EmptyState title="Nothing in the home folder">
            <p>No user-level skill and no user or managed plugin loads here.</p>
          </EmptyState>
        </section>
      ) : (
        <MachineDetail
          entry={current}
          display={display}
          onBack={() => onSelect(null)}
        />
      )}
    </div>
  );
}

function MachineRow({
  entry,
  selected,
  display,
  onSelect,
}: {
  entry: MachineEntry;
  selected: boolean;
  display: (path: string) => string;
  onSelect: () => void;
}): preact.JSX.Element {
  const shadows =
    entry.type === "skill" &&
    entry.skill.surface === "claude" &&
    entry.clashes.length > 0;
  return (
    <li>
      <button
        type="button"
        class={`list-row tone-${shadows ? "attention" : "external"}`}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        onKeyDown={onListKeyDown}
      >
        <Icon
          name={shadows ? "alert" : "notequal"}
          label={
            shadows ? "Shadows a managed skill" : "Not managed by Capshelf"
          }
        />
        <span class="list-row-name">
          {entry.type === "skill" ? entry.skill.name : entry.plugin.name}
        </span>
        <span class="list-row-state">
          {entry.type === "skill"
            ? entry.clashes.length === 0
              ? ""
              : entry.skill.surface === "claude"
                ? `Shadows ${entry.clashes.length}`
                : "Same name"
            : entry.plugin.enabled
              ? "enabled"
              : "disabled"}
        </span>
        <span class="list-row-sub mono">
          {entry.type === "skill"
            ? display(entry.skill.path)
            : (entry.plugin.marketplace ?? entry.plugin.id)}
        </span>
      </button>
    </li>
  );
}

function MachineDetail({
  entry,
  display,
  onBack,
}: {
  entry: MachineEntry;
  display: (path: string) => string;
  onBack: () => void;
}): preact.JSX.Element {
  if (entry.type === "plugin") {
    const { plugin } = entry;
    return (
      <article class="detail" aria-label={plugin.id}>
        <div class="detail-body">
          <DetailHead
            crumbs={`This machine / Claude plugins, ${plugin.scope} scope`}
            title={plugin.name}
            backLabel="This machine"
            onBack={onBack}
          >
            <p class="detail-state">
              <Icon name="notequal" />
              <span>
                <b>
                  {plugin.enabled
                    ? "Enabled in Claude settings."
                    : "Disabled in Claude settings."}
                </b>{" "}
                <span class="muted">
                  {plugin.enabled
                    ? "It loads in every project."
                    : "Claude does not load it."}{" "}
                  Capshelf reports it and never edits it.
                </span>
              </span>
            </p>
          </DetailHead>
          <section class="detail-section">
            <div class="card">
              <dl class="props">
                <dt>Id</dt>
                <dd class="mono">{plugin.id}</dd>
                <dt>Scope</dt>
                <dd>{plugin.scope}</dd>
                <dt>State</dt>
                <dd>{plugin.enabled ? "enabled" : "disabled"}</dd>
                <dt>Settings</dt>
                <dd class="mono">{display(plugin.settingsPath)}</dd>
                <dt>Seen in</dt>
                <dd>{entry.projects.join(", ")}</dd>
              </dl>
            </div>
          </section>
        </div>
      </article>
    );
  }
  const { skill, clashes } = entry;
  const words = shadowWording(skill.surface);
  const surface = skill.surface === "claude" ? "Claude" : "Codex";
  return (
    <article class="detail" aria-label={skill.name}>
      <div class="detail-body">
        <DetailHead
          crumbs={`This machine / ${surface} ${skill.surface === "claude" ? "personal" : "user"} skills`}
          title={skill.name}
          backLabel="This machine"
          onBack={onBack}
        >
          <p
            class={`detail-state${clashes.length > 0 && words.tone === "attention" ? " tone-attention" : ""}`}
          >
            <Icon
              name={
                clashes.length > 0 && words.tone === "attention"
                  ? "alert"
                  : "notequal"
              }
            />
            <span>
              {clashes.length === 0 ? (
                <>
                  <b>No managed skill has this name.</b>{" "}
                  <span class="muted">
                    {surface} loads it in every project.
                  </span>
                </>
              ) : words.tone === "attention" ? (
                <>
                  <b>Shadows a managed skill.</b>{" "}
                  <span class="muted">
                    Claude loads this personal copy first, so the projects below
                    do not get their pinned version in Claude.
                  </span>
                </>
              ) : (
                <>
                  <b>Same name as a managed skill.</b>{" "}
                  <span class="muted">Codex offers both copies.</span>
                </>
              )}
            </span>
          </p>
        </DetailHead>
        {clashes.length > 0 ? (
          <section class="detail-section" aria-label="Projects">
            <h3 class="section-label">
              {words.tone === "attention" ? "Shadowed in" : "Same name in"}
            </h3>
            <table class="table">
              <tbody>
                {clashes.map((clash) => (
                  <tr key={`${clash.project}:${clash.itemId}`}>
                    <td>
                      <a
                        href={`#/status/${encodeURIComponent(clash.project)}/${encodeURIComponent(clash.itemId)}`}
                      >
                        {clash.name}
                      </a>
                    </td>
                    <td class="muted mono">
                      {clash.itemId.split("/")[0]} skills/{skill.name}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        <section class="detail-section" aria-label="Where it lives">
          <h3 class="section-label">Where it lives</h3>
          <div class="card">
            <dl class="props">
              <dt>Path</dt>
              <dd class="mono">{display(skill.path)}</dd>
              <dt>Loaded by</dt>
              <dd>{surface}, in every project on this machine</dd>
              <dt>Capshelf</dt>
              <dd class="muted">
                Does not manage it, and does not edit files in the home folder.
              </dd>
            </dl>
          </div>
          {clashes.length > 0 && words.tone === "attention" ? (
            <p class="section-note">
              To let the pinned version load, rename or remove the personal copy
              yourself. Capshelf prints no command for it.
            </p>
          ) : null}
        </section>
      </div>
    </article>
  );
}
