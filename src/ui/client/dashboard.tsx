import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import type {
  DiffViewName,
  UiDiffResponse,
  UiOverview,
  UiProjectStatus,
  UiShelf,
} from "../shared/api-types";
import { homeDisplay } from "../shared/display";
import {
  awaitingStatus,
  changedItemIds,
  currentStatus,
  externalEntries,
  findingsAllClear,
  jumpCandidates,
  type JumpTarget,
  projectCounts,
  type StatusRead,
  sortTree,
  splitDisplayPath,
  type TreeEntry,
} from "../shared/view-model";
import { commandDataOverride } from "../../command-text";
import { ApiError, apiGet, hasToken } from "./api";
import { EmptyState, KeyHelp, PaneFocus } from "./common";
import { FindingsView } from "./FindingsView";
import { Icon } from "./icons";
import { JumpDialog } from "./JumpDialog";
import { MachineView } from "./MachineView";
import { ProjectRail, RailPicker } from "./ProjectRail";
import { type ListFilter, ProjectView } from "./ProjectView";
import { isLegacyUserSkillItem } from "../shared/route";
import { type Route, routeHash, useRoute } from "./router";
import { ShelfView } from "./ShelfView";
import { TopBar, topView } from "./TopBar";

function jumpRoute(target: JumpTarget): Route {
  switch (target.type) {
    case "item":
      return { view: "status", project: target.project, item: target.item };
    case "project":
      return { view: "status", project: target.project, item: null };
    case "shelf":
      return {
        view: "shelf",
        repo: target.repo,
        section: "items",
        ref: target.ref,
      };
    case "machine":
      return { view: "machine", entry: target.entry };
  }
}

export type DiffSource = Pick<UiProjectStatus, "project" | "snapshot">;

export interface ProjectLoad extends StatusRead {
  error: ApiError | null;
  changed: Set<string>;
}

export const EMPTY_LOAD: ProjectLoad = {
  state: "loading",
  data: null,
  stale: false,
  error: null,
  changed: new Set(),
};

export function Dashboard(): preact.JSX.Element {
  const [route, navigate] = useRoute();
  const [overview, setOverview] = useState<UiOverview | null>(null);
  const [overviewError, setOverviewError] = useState<ApiError | null>(null);
  const [loads, setLoads] = useState<Map<string, ProjectLoad>>(() => new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [filter, setFilter] = useState<ListFilter>("all");
  const [helpOpen, setHelpOpen] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [shelves, setShelves] = useState<UiShelf[] | null>(null);
  const diffCache = useRef(new Map<string, Promise<UiDiffResponse>>());
  // Generation counter so a stale reply arriving after a newer refresh cannot
  // overwrite newer data.
  const readGeneration = useRef(0);

  const loadProject = useCallback(
    async (path: string, generation: number): Promise<void> => {
      try {
        const data = await apiGet<UiProjectStatus>("/api/project/status", {
          project: path,
        });
        if (generation !== readGeneration.current) return;
        let changed = new Set<string>();
        setLoads((previous) => {
          const next = new Map(previous);
          const old = previous.get(path);
          changed = changedItemIds(old?.data?.items, data.items);
          next.set(path, {
            state: "ready",
            data,
            stale: false,
            error: null,
            changed,
          });
          return next;
        });
        if (changed.size > 0) {
          window.setTimeout(() => {
            setLoads((previous) => {
              const current = previous.get(path);
              if (!current) return previous;
              const next = new Map(previous);
              next.set(path, { ...current, changed: new Set() });
              return next;
            });
          }, 3000);
        }
      } catch (error) {
        if (generation !== readGeneration.current) return;
        setLoads((previous) => {
          const next = new Map(previous);
          const old = previous.get(path) ?? EMPTY_LOAD;
          next.set(path, {
            ...old,
            state: "error",
            stale: true,
            error:
              error instanceof ApiError
                ? error
                : new ApiError(0, String(error)),
          });
          return next;
        });
      }
    },
    [],
  );

  const refreshAll = useCallback(async (): Promise<void> => {
    if (!hasToken()) return;
    readGeneration.current += 1;
    const generation = readGeneration.current;
    setRefreshing(true);
    try {
      const next = await apiGet<UiOverview>("/api/overview");
      if (generation !== readGeneration.current) return;
      setOverview(next);
      setOverviewError(null);
      const existing = next.projects.filter((project) => project.exists);
      setLoads((previous) => {
        const map = new Map<string, ProjectLoad>();
        for (const project of existing) {
          const old = previous.get(project.path) ?? EMPTY_LOAD;
          map.set(project.path, { ...old, state: "loading" });
        }
        return map;
      });
      diffCache.current.clear();
      setShelves(null);
      await Promise.all(
        existing.map((project) => loadProject(project.path, generation)),
      );
      if (generation !== readGeneration.current) return;
      setRefreshedAt(new Date());
    } catch (error) {
      if (generation !== readGeneration.current) return;
      setOverviewError(
        error instanceof ApiError ? error : new ApiError(0, String(error)),
      );
    } finally {
      if (generation === readGeneration.current) setRefreshing(false);
    }
  }, [loadProject]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (event.key === "Escape") {
        setHelpOpen(false);
        return;
      }
      const dialogOpen = document.body.classList.contains("has-dialog");
      if (
        typing ||
        dialogOpen ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (event.key === "r") {
        event.preventDefault();
        void refreshAll();
      } else if (event.key === "/") {
        event.preventDefault();
        setJumpOpen(true);
      } else if (event.key === "?") {
        event.preventDefault();
        setHelpOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refreshAll]);

  useEffect(() => {
    if (!jumpOpen || shelves !== null || overview === null) return;
    // Guard so a read started before a refresh cannot fill the cleared catalogs
    // with old shelves.
    let current = true;
    void Promise.all(
      overview.shelves.map((shelf) =>
        apiGet<UiShelf>("/api/shelf", { repo: shelf.dataRepo }).catch(
          () => null,
        ),
      ),
    ).then((read) => {
      if (current) {
        setShelves(read.filter((shelf): shelf is UiShelf => shelf !== null));
      }
    });
    return () => {
      current = false;
    };
  }, [jumpOpen, shelves, overview]);

  const projects = overview?.projects ?? [];
  // Keep the last good read during a refresh so cross-project views do not
  // empty while it runs.
  const statuses = useMemo<UiProjectStatus[]>(
    () =>
      [...loads.values()].flatMap((load) => {
        const status = currentStatus(load);
        return status ? [status] : [];
      }),
    [loads],
  );
  const statusByProject = useMemo(
    () => new Map(statuses.map((status) => [status.project, status])),
    [statuses],
  );
  const pendingProjects = useMemo(
    () =>
      new Set(
        [...loads.entries()].flatMap(([path, load]) =>
          awaitingStatus(load) ? [path] : [],
        ),
      ),
    [loads],
  );
  const pending = pendingProjects.size;
  const jumpRows = useMemo(
    () =>
      jumpCandidates(
        overview?.projects ?? [],
        statuses,
        (shelves ?? []).map((shelf) => ({
          dataRepo: shelf.dataRepo,
          items: shelf.items,
        })),
      ),
    [overview, statuses, shelves],
  );
  const treeEntries = useMemo<TreeEntry[]>(
    () =>
      sortTree(
        projects.map((project): TreeEntry => {
          const base = { path: project.path, display: project.display };
          if (!project.exists) {
            return { ...base, state: "missing", counts: null };
          }
          const load = loads.get(project.path);
          if (!load || load.state === "loading") {
            const status = load ? currentStatus(load) : null;
            return {
              ...base,
              state: "loading",
              counts: status ? projectCounts(status.items) : null,
            };
          }
          if (load.state === "error" || load.data === null) {
            return { ...base, state: "error", counts: null };
          }
          return {
            ...base,
            state: "ready",
            counts: projectCounts(load.data.items),
          };
        }),
      ),
    [projects, loads],
  );

  const defaultProject = useMemo<string | null>(() => {
    if (!overview) return null;
    const current = overview.currentProject;
    if (
      current !== null &&
      overview.projects.some(
        (project) => project.path === current && project.exists,
      )
    ) {
      return current;
    }
    return overview.projects.find((project) => project.exists)?.path ?? null;
  }, [overview]);

  const selectedPath =
    route.view === "status" && route.project !== null
      ? route.project
      : defaultProject;
  const selectedLoad =
    selectedPath === null ? null : (loads.get(selectedPath) ?? null);
  const selectedRegistered =
    selectedPath === null
      ? null
      : (projects.find((project) => project.path === selectedPath) ?? null);
  const selectedItem = route.view === "status" ? route.item : null;

  // Diffs are keyed by snapshot so an older read finishing last cannot answer
  // for the one on screen.
  const loadDiff = useCallback(
    (
      status: DiffSource,
      itemId: string,
      view: DiffViewName,
    ): Promise<UiDiffResponse> => {
      const key = `${status.project}\t${status.snapshot}\t${itemId}\t${view}`;
      const cached = diffCache.current.get(key);
      if (cached) return cached;
      const promise = apiGet<UiDiffResponse>("/api/project/diff", {
        project: status.project,
        snapshot: status.snapshot,
        item: itemId,
        view,
      });
      diffCache.current.set(key, promise);
      // A refresh clears the cache, so delete only this request's own entry,
      // not a newer request's.
      promise.catch(() => {
        if (diffCache.current.get(key) === promise) {
          diffCache.current.delete(key);
        }
      });
      return promise;
    },
    [],
  );

  // Old bookmarks may name user-level skill rows under a project; those now
  // live in This machine.
  const legacyUserSkill =
    route.view === "status" &&
    route.item !== null &&
    isLegacyUserSkillItem(route.item);
  useEffect(() => {
    if (legacyUserSkill) navigate({ view: "machine", entry: null });
  }, [legacyUserSkill, navigate]);

  if (!hasToken()) {
    return (
      <div class="app">
        <main class="page-message">
          <EmptyState title="Open the URL that capshelf ui printed">
            <p>
              The address carries this session's access token. Run{" "}
              <code>capshelf ui</code> again if that terminal is closed.
            </p>
          </EmptyState>
        </main>
      </div>
    );
  }

  const railShelf =
    selectedLoad?.data?.shelf ??
    statuses.find((status) => status.shelf !== null)?.shelf ??
    null;
  const shelfRepo =
    railShelf?.dataRepo ?? overview?.shelves[0]?.dataRepo ?? null;
  // With --data every project reads one override repo, so the first shelf is
  // the resolved path commands must name.
  const commandOverride = commandDataOverride(
    overview?.dataOverride,
    overview?.shelves[0]?.dataRepo,
  );
  const selectProject = (path: string): void =>
    navigate({ view: "status", project: path, item: null });
  const openFindings = (): void =>
    navigate({ view: "findings", project: null, item: null });
  const inFindings = route.view === "findings";
  const findingsCount = statuses.reduce(
    (sum, status) => sum + projectCounts(status.items).attention,
    0,
  );
  const unreadProjects = projects
    .filter(
      (registered) =>
        !registered.exists || loads.get(registered.path)?.state === "error",
    )
    .map((registered) => splitDisplayPath(registered.display).name);
  const findingsClear = findingsAllClear({
    discovering: overview === null,
    found: findingsCount,
    pending,
    unread: unreadProjects.length,
  });
  const picker = (
    <RailPicker
      entries={treeEntries}
      selectedPath={inFindings ? null : selectedPath}
      findings={findingsCount}
      findingsComplete={findingsClear || findingsCount > 0}
      onSelect={selectProject}
      onFindings={openFindings}
    />
  );
  const routedItem =
    route.view === "status" || route.view === "findings" ? route.item : null;
  const routedProject =
    route.view === "findings"
      ? route.project
      : route.view === "status"
        ? selectedPath
        : null;
  // The project view renders a failed refresh's old data, so it resolves
  // against the load; findings use current statuses only.
  const routedStatus =
    routedProject === null
      ? undefined
      : route.view === "status"
        ? (loads.get(routedProject)?.data ?? undefined)
        : statusByProject.get(routedProject);
  const hasSelection =
    routedItem !== null &&
    routedStatus !== undefined &&
    (route.view === "findings"
      ? routedStatus.items.some(
          (entry) => entry.id === routedItem && entry.attention,
        )
      : routedStatus.items.some((entry) => entry.id === routedItem) ||
        externalEntries(routedStatus).some((entry) => entry.id === routedItem));

  return (
    <div class="app">
      <TopBar
        view={topView(route)}
        projectsHref={routeHash({
          view: "status",
          project: selectedPath,
          item: null,
        })}
        shelfHref={routeHash({
          view: "shelf",
          repo: shelfRepo,
          section: "items",
          ref: null,
        })}
        refreshing={refreshing}
        refreshedAt={refreshedAt}
        onRefresh={() => void refreshAll()}
        onJump={() => setJumpOpen(true)}
        onHelp={() => setHelpOpen((open) => !open)}
      />
      {overviewError ? (
        <main class="page-message">
          <EmptyState title="The dashboard could not load">
            <p>{overviewError.message}</p>
            {overviewError.hint ? (
              <p class="muted">{overviewError.hint}</p>
            ) : null}
            <button
              type="button"
              class="button"
              onClick={() => void refreshAll()}
            >
              Try again
            </button>
          </EmptyState>
        </main>
      ) : route.view === "machine" ? (
        <MachineView
          overview={overview}
          loads={loads}
          entry={route.entry}
          onSelect={(entry) => navigate({ view: "machine", entry })}
        />
      ) : route.view === "shelf" ? (
        <ShelfView
          overview={overview}
          route={route}
          navigate={navigate}
          statuses={statusByProject}
          pending={pendingProjects}
          generation={refreshedAt?.getTime() ?? 0}
        />
      ) : overview !== null && projects.length === 0 ? (
        <main class="page-message">
          <EmptyState title="No projects yet">
            <p>
              <code>capshelf ui</code> shows every project on this machine that
              Capshelf manages. <code>capshelf init</code> in a project folder
              registers it. Running <code>capshelf ui</code> inside an existing
              project registers that one.
            </p>
            <p class="muted">Registry: {overview.registryDisplay}</p>
          </EmptyState>
        </main>
      ) : (
        <div class={`frame${hasSelection ? " has-selection" : ""}`}>
          <PaneFocus
            selection={
              hasSelection
                ? `${route.view}\t${routedProject}\t${routedItem}`
                : null
            }
          />
          <ProjectRail
            entries={treeEntries}
            selectedPath={inFindings ? null : selectedPath}
            shelf={railShelf}
            cliVersion={overview?.cliVersion ?? null}
            onSelect={selectProject}
            top={
              <a
                class="rail-row has-icon"
                href="#/findings"
                aria-current={inFindings ? "page" : undefined}
              >
                <Icon name="inbox" />
                <span class="rail-row-name">All findings</span>
                <span
                  class={`count${findingsCount > 0 ? " is-attention" : findingsClear ? " is-ok" : ""}`}
                >
                  {findingsCount > 0 ? (
                    findingsCount
                  ) : findingsClear ? (
                    <Icon name="check" />
                  ) : (
                    "?"
                  )}
                  <span class="visually-hidden">
                    {findingsCount > 0
                      ? findingsCount === 1
                        ? " item needs attention"
                        : " items need attention"
                      : findingsClear
                        ? "No item needs attention"
                        : "Not every project is read"}
                  </span>
                </span>
              </a>
            }
          />
          {route.view === "findings" ? (
            <FindingsView
              statuses={statuses}
              pending={pending}
              discovering={overview === null}
              unread={unreadProjects}
              dataOverride={commandOverride}
              project={route.project}
              item={route.item}
              onSelect={(project, item) =>
                navigate({ view: "findings", project, item })
              }
              loadDiff={loadDiff}
              picker={picker}
            />
          ) : overview === null ||
            selectedPath === null ||
            selectedRegistered === null ? (
            <>
              <section class="list" aria-label="Items">
                {picker}
                {overview === null ? (
                  <div class="list-empty">Reading every project…</div>
                ) : (
                  <EmptyState title="No project to show">
                    <p>Every registered path is missing its manifest.</p>
                    <p class="muted">Registry: {overview.registryDisplay}</p>
                  </EmptyState>
                )}
              </section>
              <section class="detail" aria-hidden="true" />
            </>
          ) : !selectedRegistered.exists ? (
            <>
              <section class="list" aria-label="Items">
                {picker}
                <EmptyState title={selectedRegistered.display}>
                  <p>
                    This path no longer holds a Capshelf project. Remove its
                    entry from <code>{overview.registryDisplay}</code>, or run{" "}
                    <code>capshelf init</code> there again.
                  </p>
                </EmptyState>
              </section>
              <section class="detail" aria-hidden="true" />
            </>
          ) : (
            <ProjectView
              project={selectedPath}
              registered={selectedRegistered}
              load={selectedLoad ?? EMPTY_LOAD}
              filter={filter}
              onFilter={setFilter}
              selected={selectedItem}
              onSelect={(itemId) =>
                navigate({
                  view: "status",
                  project: selectedPath,
                  item: itemId,
                })
              }
              displayPath={(path) => homeDisplay(path, overview.home)}
              loadDiff={loadDiff}
              picker={picker}
              dataOverride={commandOverride}
            />
          )}
        </div>
      )}
      {helpOpen ? <KeyHelp onClose={() => setHelpOpen(false)} /> : null}
      {jumpOpen ? (
        <JumpDialog
          rows={jumpRows}
          shelvesLoading={shelves === null}
          onOpen={(target) => {
            setJumpOpen(false);
            navigate(jumpRoute(target));
          }}
          onClose={() => setJumpOpen(false)}
        />
      ) : null}
    </div>
  );
}
