import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import type { ItemKind } from "../../master";
import type {
  DiffViewName,
  UiDiffResponse,
  UiOverview,
  UiProjectStatus,
} from "../shared/api-types";
import {
  changedItemIds,
  projectCounts,
  sortTree,
  type FilterTab,
  type TreeEntry,
} from "../shared/view-model";
import { ActionsCard, ActionsLoading, RevisionsCard } from "./ActionsCard";
import { ApiError, apiGet, hasToken } from "./api";
import { EmptyState, KeyHelp } from "./common";
import { ProjectReview, ReviewLoading } from "./ProjectReview";
import { ProjectTree } from "./ProjectTree";
import { useRoute } from "./router";
import { ShelfView } from "./ShelfView";
import { TopBar } from "./TopBar";

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
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<FilterTab>("all");
  const [kind, setKind] = useState<ItemKind | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const diffCache = useRef(new Map<string, Promise<UiDiffResponse>>());
  const autoOpened = useRef(new Set<string>());
  const filterRef = useRef<HTMLInputElement>(null);

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
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (event.key === "Escape") {
        setHelpOpen(false);
        setDrawerOpen(false);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "r") {
        event.preventDefault();
        void refreshAll();
      } else if (event.key === "/") {
        event.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
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
          if (!project.exists) {
            return {
              path: project.path,
              display: project.display,
              state: "missing",
              counts: null,
            };
          }
          const load = loads.get(project.path);
          if (!load || load.state === "loading") {
            return {
              path: project.path,
              display: project.display,
              state: "loading",
              counts: load?.data ? projectCounts(load.data.items) : null,
            };
          }
          if (load.state === "error" || load.data === null) {
            return {
              path: project.path,
              display: project.display,
              state: "error",
              counts: null,
            };
          }
          return {
            path: project.path,
            display: project.display,
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
  const routeItem = route.view === "status" ? route.item : null;

  const isExpanded = (project: string, itemId: string): boolean =>
    expanded.has(expandedKey(project, itemId));
  const toggleExpanded = (project: string, itemId: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      const key = expandedKey(project, itemId);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // The first attention panel opens by itself once per project, so the
  // first finding is visible without a click. A route that names an item
  // opens that item instead.
  useEffect(() => {
    if (selectedPath === null || selectedLoad?.state !== "ready") return;
    const data = selectedLoad.data;
    if (!data) return;
    if (routeItem !== null) {
      const key = expandedKey(selectedPath, routeItem);
      setExpanded((previous) =>
        previous.has(key) ? previous : new Set(previous).add(key),
      );
      window.requestAnimationFrame(() => {
        document
          .getElementById(panelDomId(selectedPath, routeItem))
          ?.scrollIntoView({ block: "start" });
      });
      return;
    }
    if (autoOpened.current.has(selectedPath)) return;
    autoOpened.current.add(selectedPath);
    const first = data.items.find(
      (item) => item.attention && item.diffViews.length > 0,
    );
    if (first) {
      setExpanded((previous) =>
        new Set(previous).add(expandedKey(selectedPath, first.id)),
      );
    }
  }, [selectedPath, selectedLoad, routeItem]);

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

  const selectedShelf =
    selectedLoad?.state === "ready" ? (selectedLoad.data?.shelf ?? null) : null;

  return (
    <div class={`app${drawerOpen ? " drawer-open" : ""}`}>
      <TopBar
        overview={overview}
        shelf={selectedShelf}
        refreshing={refreshing}
        refreshedAt={refreshedAt}
        onRefresh={() => void refreshAll()}
        query={query}
        onQuery={setQuery}
        filterRef={filterRef}
        view={route.view}
        onView={(view) =>
          navigate(
            view === "shelf"
              ? {
                  view: "shelf",
                  repo:
                    selectedShelf?.dataRepo ??
                    overview?.shelves[0]?.dataRepo ??
                    null,
                  ref: null,
                }
              : { view: "status", project: selectedPath, item: null },
          )
        }
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((open) => !open)}
        onToggleHelp={() => setHelpOpen((open) => !open)}
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
      ) : route.view === "shelf" ? (
        <ShelfView overview={overview} route={route} navigate={navigate} />
      ) : (
        <div class="workspace">
          <aside class="tree-rail" aria-label="Projects">
            <ProjectTree
              entries={treeEntries}
              loads={loads}
              selectedPath={selectedPath}
              query={query}
              registryDisplay={overview?.registryDisplay ?? null}
              onSelect={(path) => {
                setDrawerOpen(false);
                navigate({ view: "status", project: path, item: null });
              }}
              onSelectItem={(path, itemId) => {
                setDrawerOpen(false);
                navigate({ view: "status", project: path, item: itemId });
              }}
            />
          </aside>
          {drawerOpen ? (
            <button
              type="button"
              class="drawer-scrim"
              aria-label="Close the project list"
              onClick={() => setDrawerOpen(false)}
            />
          ) : null}
          <main class="review" aria-label="Review">
            {overview === null ? (
              <ReviewLoading />
            ) : projects.length === 0 ? (
              <EmptyState title="No projects are registered on this machine">
                <p>
                  <code>capshelf init</code> registers a project when it
                  initializes it. Run <code>capshelf ui</code> inside an
                  existing project to register that one.
                </p>
                <p class="muted">Registry: {overview.registryDisplay}</p>
              </EmptyState>
            ) : selectedPath === null || selectedRegistered === null ? (
              <EmptyState title="No project to show">
                <p>Every registered path is missing its manifest.</p>
                <p class="muted">Registry: {overview.registryDisplay}</p>
              </EmptyState>
            ) : !selectedRegistered.exists ? (
              <EmptyState title={selectedRegistered.display}>
                <p>
                  This path no longer holds a Capshelf project. Remove its entry
                  from <code>{overview.registryDisplay}</code>, or run{" "}
                  <code>capshelf init</code> there again.
                </p>
              </EmptyState>
            ) : (
              <ProjectReview
                project={selectedPath}
                registered={selectedRegistered}
                load={selectedLoad ?? EMPTY_LOAD}
                tab={tab}
                onTab={setTab}
                kind={kind}
                onKind={setKind}
                query={query}
                isExpanded={(itemId) => isExpanded(selectedPath, itemId)}
                onToggle={(itemId) => toggleExpanded(selectedPath, itemId)}
                loadDiff={(itemId, view) =>
                  loadDiff(selectedPath, itemId, view)
                }
                panelDomId={(itemId) => panelDomId(selectedPath, itemId)}
              />
            )}
          </main>
          <aside class="side-rail" aria-label="Actions and shelf revisions">
            {selectedLoad?.state === "ready" && selectedLoad.data ? (
              <>
                <ActionsCard status={selectedLoad.data} />
                <RevisionsCard shelf={selectedLoad.data.shelf} />
              </>
            ) : selectedLoad?.state === "loading" ? (
              <ActionsLoading />
            ) : null}
          </aside>
        </div>
      )}
      {helpOpen ? <KeyHelp onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}

function expandedKey(project: string, itemId: string): string {
  return `${project}\t${itemId}`;
}

export function panelDomId(project: string, itemId: string): string {
  return `panel-${hashKey(`${project}\t${itemId}`)}`;
}

function hashKey(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}
