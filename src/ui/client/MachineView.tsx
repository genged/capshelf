import type { ExternalClaudePlugin, ExternalUserSkill } from "../../external";
import type { UiOverview, UiProjectStatus } from "../shared/api-types";
import { homeDisplay } from "../shared/display";
import { EmptyState, Skeleton } from "./common";
import { shadowedItemId, shadowWording } from "./ExternalRow";
import type { ProjectLoad } from "./dashboard";

interface SkillEntry {
  skill: ExternalUserSkill;
  /** One entry per project and lock entry that shares the skill's name. */
  clashes: Array<{
    project: string;
    display: string;
    itemId: string;
  }>;
}

interface PluginEntry {
  plugin: ExternalClaudePlugin;
  projects: string[];
}

/**
 * The canonical description of what lives in the home directory: user-level
 * skills and user or managed plugins. Every project on the machine loads
 * them, so each project page lists them too and links here. The view is
 * built from the project statuses the dashboard has already loaded; the
 * inventory is the same in each, only the name clashes differ per project.
 */
export function MachineView({
  overview,
  loads,
}: {
  overview: UiOverview | null;
  loads: Map<string, ProjectLoad>;
}): preact.JSX.Element {
  if (overview === null) {
    return (
      <main class="machine page">
        <Skeleton lines={4} label="Loading this machine" />
      </main>
    );
  }
  const display = (path: string): string => homeDisplay(path, overview.home);
  const ready: UiProjectStatus[] = [];
  let pending = 0;
  for (const load of loads.values()) {
    if (load.data) ready.push(load.data);
    else if (load.state === "loading") pending += 1;
  }

  const skills = new Map<string, SkillEntry>();
  const plugins = new Map<string, PluginEntry>();
  for (const status of ready) {
    for (const skill of status.externalUserSkills) {
      const key = `${skill.surface}\t${skill.path}`;
      const entry = skills.get(key) ?? { skill, clashes: [] };
      for (const shadow of skill.shadows) {
        entry.clashes.push({
          project: status.project,
          display: status.display,
          itemId: shadowedItemId(skill, shadow),
        });
      }
      skills.set(key, entry);
    }
    for (const plugin of status.externalClaudePlugins) {
      if (plugin.scope !== "user" && plugin.scope !== "managed") continue;
      const key = `${plugin.scope}\t${plugin.id}`;
      const entry = plugins.get(key) ?? { plugin, projects: [] };
      entry.projects.push(status.display);
      plugins.set(key, entry);
    }
  }
  const skillRows = [...skills.values()].sort(
    (a, b) =>
      a.skill.name.localeCompare(b.skill.name) ||
      a.skill.surface.localeCompare(b.skill.surface),
  );
  const pluginRows = [...plugins.values()].sort((a, b) =>
    a.plugin.id.localeCompare(b.plugin.id),
  );

  return (
    <main class="machine page" aria-label="This machine">
      <article class="reader">
        <header class="reader-head">
          <h1 class="mono">{overview.host}</h1>
          <p class="muted reader-facts">
            registry <span class="mono">{overview.registryDisplay}</span>
            {" · "}
            {ready.length} {ready.length === 1 ? "project" : "projects"} read
            {pending > 0 ? ` · ${pending} loading` : ""}
          </p>
          <p>
            Skills and plugins that live in the home directory. Every project on
            this machine loads them. Capshelf reports them and never edits them.
          </p>
        </header>

        {ready.length === 0 ? (
          <EmptyState title="No project has been read yet">
            <p>The inventory comes from the project statuses.</p>
          </EmptyState>
        ) : (
          <>
            <section aria-labelledby="machine-skills">
              <h2 id="machine-skills">
                {skillRows.length === 0
                  ? "No user-level skills"
                  : `${skillRows.length} user-level ${skillRows.length === 1 ? "skill" : "skills"}`}
              </h2>
              {skillRows.length > 0 ? (
                <ul class="machine-rows">
                  {skillRows.map(({ skill, clashes }) => {
                    const words = shadowWording(skill.surface);
                    return (
                      <li
                        key={`${skill.surface}:${skill.path}`}
                        class="machine-row"
                      >
                        <span class="mono machine-ref">
                          skills/{skill.name}
                        </span>
                        <span class="chip chip-origin">
                          {skill.surface === "claude" ? "Claude" : "Codex"}
                        </span>
                        <span class="muted mono machine-path">
                          {display(skill.path)}
                        </span>
                        {clashes.length === 0 ? (
                          <span class="muted machine-note">
                            same name as no managed skill
                          </span>
                        ) : (
                          <span class={`machine-note tone-${words.tone}`}>
                            {words.lead}{" "}
                            {clashes.map((clash, index) => (
                              <span key={`${clash.project}:${clash.itemId}`}>
                                {index > 0 ? ", " : ""}
                                <a
                                  href={`#/status/${encodeURIComponent(clash.project)}/${encodeURIComponent(clash.itemId)}`}
                                >
                                  skills/{skill.name} in {clash.display}
                                </a>
                              </span>
                            ))}
                            {words.tail}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>

            <section aria-labelledby="machine-plugins">
              <h2 id="machine-plugins">
                {pluginRows.length === 0
                  ? "No user or managed Claude plugins"
                  : `${pluginRows.length} Claude ${pluginRows.length === 1 ? "plugin" : "plugins"}, user or managed scope`}
              </h2>
              {pluginRows.length > 0 ? (
                <ul class="machine-rows">
                  {pluginRows.map(({ plugin, projects }) => (
                    <li
                      key={`${plugin.scope}:${plugin.id}`}
                      class="machine-row"
                    >
                      <span class="mono machine-ref">plugins/{plugin.id}</span>
                      <span class="chip chip-origin">{plugin.scope}</span>
                      <span class="muted">
                        {plugin.enabled ? "enabled" : "disabled"}
                        {" · "}
                        <span class="mono">{display(plugin.settingsPath)}</span>
                      </span>
                      <span class="muted machine-note">
                        loads in every project
                        {projects.length < ready.length
                          ? ` (seen in ${projects.length} of ${ready.length} read)`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </>
        )}
      </article>
    </main>
  );
}
