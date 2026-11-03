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
} from "../shared/api-types";
import { homeDisplay } from "../shared/display";
import {
  changedItemIds,
  projectCounts,
  sortTree,
  type TreeEntry,
} from "../shared/view-model";
import { ApiError, apiGet, hasToken } from "./api";
import { EmptyState, KeyHelp } from "./common";
import { MachineView } from "./MachineView";
import { ProjectRail, RailPicker } from "./ProjectRail";
import { type ListFilter, ProjectView } from "./ProjectView";
import { routeHash, useRoute } from "./router";
import { ShelfView } from "./ShelfView";
import { TopBar, topView } from "./TopBar";

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
      } else if (event.key === "?") {
        event.preventDefault();
        setHelpOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refreshAll]);

  const projects = overview?.projects ?? [];
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
    null ??
    [...loads.values()].find((load) => load.data?.shelf)?.data?.shelf ??
    null;
  const shelfRepo =
    railShelf?.dataRepo ?? overview?.shelves[0]?.dataRepo ?? null;
  const selectProject = (path: string): void =>
    navigate({ view: "status", project: path, item: null });

  return (
    <div class="app">
      <TopBar
        view={topView(route)}
        projectsHref={routeHash({
          view: "status",
          project: selectedPath,
          item: null,
        })}
        shelfHref={routeHash({ view: "shelf", repo: shelfRepo, ref: null })}
        refreshing={refreshing}
        refreshedAt={refreshedAt}
        onRefresh={() => void refreshAll()}
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
        <MachineView overview={overview} loads={loads} />
      ) : route.view === "shelf" ? (
        <ShelfView overview={overview} route={route} navigate={navigate} />
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
        <div class={`frame${selectedItem !== null ? " has-selection" : ""}`}>
          <ProjectRail
            entries={treeEntries}
            selectedPath={selectedPath}
            shelf={railShelf}
            cliVersion={overview?.cliVersion ?? null}
            onSelect={selectProject}
          />
          {overview === null ||
          selectedPath === null ||
          selectedRegistered === null ? (
            <>
              <section class="list" aria-label="Items">
                <RailPicker
                  entries={treeEntries}
                  selectedPath={selectedPath}
                  onSelect={selectProject}
                />
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
                <RailPicker
                  entries={treeEntries}
                  selectedPath={selectedPath}
                  onSelect={selectProject}
                />
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
              picker={
                <RailPicker
                  entries={treeEntries}
                  selectedPath={selectedPath}
                  onSelect={selectProject}
                />
              }
            />
          )}
        </div>
      )}
      {helpOpen ? <KeyHelp onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}
