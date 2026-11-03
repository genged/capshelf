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
  changedItemIds,
  externalEntries,
  jumpCandidates,
  type JumpTarget,
  projectCounts,
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
import { type Route, routeHash, useRoute } from "./router";
import { ShelfView } from "./ShelfView";
import { TopBar, topView } from "./TopBar";

/** The route a jump row opens. */
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

export interface ProjectLoad {
  state: "loading" | "ready" | "error";
  data: UiProjectStatus | null;
  error: ApiError | null;
  /** Item ids whose state moved in the last refresh; highlighted once. */
  changed: Set<string>;
}

export const EMPTY_LOAD: ProjectLoad = {
  state: "loading",
  data: null,
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
  // Shelf catalogs for Jump, read the first time it opens.
  const [shelves, setShelves] = useState<UiShelf[] | null>(null);
  const diffCache = useRef(new Map<string, Promise<UiDiffResponse>>());

  const loadProject = useCallback(async (path: string): Promise<void> => {
    try {
      const data = await apiGet<UiProjectStatus>("/api/project/status", {
        project: path,
      });
      let changed = new Set<string>();
      setLoads((previous) => {
        const next = new Map(previous);
        const old = previous.get(path);
        changed = changedItemIds(old?.data?.items, data.items);
        next.set(path, { state: "ready", data, error: null, changed });
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
      setLoads((previous) => {
        const next = new Map(previous);
        const old = previous.get(path) ?? EMPTY_LOAD;
        next.set(path, {
          ...old,
          state: "error",
          error:
            error instanceof ApiError ? error : new ApiError(0, String(error)),
        });
        return next;
      });
    }
  }, []);

  const refreshAll = useCallback(async (): Promise<void> => {
    if (!hasToken()) return;
    setRefreshing(true);
    try {
      const next = await apiGet<UiOverview>("/api/overview");
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
      await Promise.all(existing.map((project) => loadProject(project.path)));
      setRefreshedAt(new Date());
    } catch (error) {
      setOverviewError(
        error instanceof ApiError ? error : new ApiError(0, String(error)),
      );
    } finally {
      setRefreshing(false);
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
      // A dialog holds the keyboard; the page shortcuts wait for it to close.
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

  // Jump ranks shelf items too, so it reads each shelf the first time it
  // opens. A shelf that fails to read only drops out of the results.
  useEffect(() => {
    if (!jumpOpen || shelves !== null || overview === null) return;
    void Promise.all(
      overview.shelves.map((shelf) =>
        apiGet<UiShelf>("/api/shelf", { repo: shelf.dataRepo }).catch(
          () => null,
        ),
      ),
    ).then((read) =>
      setShelves(read.filter((shelf): shelf is UiShelf => shelf !== null)),
    );
  }, [jumpOpen, shelves, overview]);

  const projects = overview?.projects ?? [];
  // The views across projects read only current statuses. A failed refresh
  // keeps its old data for the project view, which says the refresh failed,
  // but All findings, Jump, Rollouts, and Coverage leave it out and All
  // findings names it as unread. A refresh in progress keeps the last good
  // read, so the views do not empty while it runs.
  const statuses = useMemo<UiProjectStatus[]>(
    () =>
      [...loads.values()].flatMap((load) =>
        load.data && load.state !== "error" ? [load.data] : [],
      ),
    [loads],
  );
  const statusByProject = useMemo(
    () => new Map(statuses.map((status) => [status.project, status])),
    [statuses],
  );
  // Projects on their first status read. Only for these does a shelf view
  // let the shelf's pin flag stand in for the missing row.
  const pendingProjects = useMemo(
    () =>
      new Set(
        [...loads.entries()].flatMap(([path, load]) =>
          load.data === null && load.state === "loading" ? [path] : [],
        ),
      ),
    [loads],
  );
  const pending = pendingProjects.size;
  const jumpRows = useMemo(
    () =>
      jumpCandidates(
        statuses,
        (shelves ?? []).map((shelf) => ({
          dataRepo: shelf.dataRepo,
          items: shelf.items,
        })),
      ),
    [statuses, shelves],
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
            return {
              ...base,
              state: "loading",
              counts: load?.data ? projectCounts(load.data.items) : null,
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

  const loadDiff = useCallback(
    (
      project: string,
      itemId: string,
      view: DiffViewName,
    ): Promise<UiDiffResponse> => {
      const key = `${project}\t${itemId}\t${view}`;
      const cached = diffCache.current.get(key);
      if (cached) return cached;
      const promise = apiGet<UiDiffResponse>("/api/project/diff", {
        project,
        item: itemId,
        view,
      });
      diffCache.current.set(key, promise);
      promise.catch(() => diffCache.current.delete(key));
      return promise;
    },
    [],
  );

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

  // The rail foot names the shelf of the selected project, else the first.
  const railShelf =
    selectedLoad?.data?.shelf ??
    statuses.find((status) => status.shelf !== null)?.shelf ??
    null;
  const shelfRepo =
    railShelf?.dataRepo ?? overview?.shelves[0]?.dataRepo ?? null;
  // With --data, every project reads the one override repository, so the
  // first shelf is the resolved path that commands must name.
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
  const picker = (
    <RailPicker
      entries={treeEntries}
      selectedPath={inFindings ? null : selectedPath}
      findings={findingsCount}
      onSelect={selectProject}
      onFindings={openFindings}
    />
  );
  // A phone shows the detail only for an entry that still exists. A finding
  // that an update resolved, or an item that a refresh removed, falls back
  // to the list instead of an empty page with no way back.
  const routedItem =
    route.view === "status" || route.view === "findings" ? route.item : null;
  const routedProject =
    route.view === "findings"
      ? route.project
      : route.view === "status"
        ? selectedPath
        : null;
  // The project view still renders a failed refresh's old data, so it
  // resolves against the load. All findings reads current statuses only.
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
          <PaneFocus hasSelection={hasSelection} />
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
                  class={`count${findingsCount > 0 ? " is-attention" : " is-ok"}`}
                >
                  {findingsCount > 0 ? findingsCount : <Icon name="check" />}
                  <span class="visually-hidden">
                    {findingsCount === 1
                      ? " item needs attention"
                      : " items need attention"}
                  </span>
                </span>
              </a>
            }
          />
          {route.view === "findings" ? (
            <FindingsView
              statuses={statuses}
              pending={pending}
              unread={projects
                .filter(
                  (registered) =>
                    !registered.exists ||
                    loads.get(registered.path)?.state === "error",
                )
                .map((registered) => splitDisplayPath(registered.display).name)}
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
              loadDiff={(itemId, view) => loadDiff(selectedPath, itemId, view)}
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
