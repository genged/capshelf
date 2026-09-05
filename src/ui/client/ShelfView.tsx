import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { rankRows } from "../../pick-rank";
import type {
  UiOverview,
  UiShelf,
  UiShelfItemDetail,
} from "../shared/api-types";
import { shortCommit } from "../shared/view-model";
import { ApiError, apiGet } from "./api";
import { EmptyState, Skeleton, formatDay } from "./common";
import { highlightLine, languageForPath } from "./highlight";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";
import type { Route } from "./router";

interface ShelfRow {
  ref: string;
  kind: string;
  name: string;
  tags: string[];
  description?: string;
  source: "data" | "system" | "bundle";
  detail: string;
}

type Load<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "error"; error: ApiError };

export function ShelfView({
  overview,
  route,
  navigate,
}: {
  overview: UiOverview | null;
  route: Extract<Route, { view: "shelf" }>;
  navigate: (route: Route) => void;
}): preact.JSX.Element {
  const repo = route.repo ?? overview?.shelves[0]?.dataRepo ?? null;
  const [shelf, setShelf] = useState<Load<UiShelf>>({ state: "idle" });
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<Load<UiShelfItemDetail>>({
    state: "idle",
  });
  const [file, setFile] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (repo === null) return;
    setShelf({ state: "loading" });
    apiGet<UiShelf>("/api/shelf", { repo }).then(
      (data) => setShelf({ state: "ready", data }),
      (error: unknown) =>
        setShelf({
          state: "error",
          error:
            error instanceof ApiError ? error : new ApiError(0, String(error)),
        }),
    );
  }, [repo]);

  const ref = route.ref;
  useEffect(() => {
    setFile(null);
  }, [ref]);
  useEffect(() => {
    if (repo === null || ref === null) {
      setDetail({ state: "idle" });
      return;
    }
    if (ref.startsWith("bundles/")) {
      setDetail({ state: "idle" });
      return;
    }
    setDetail({ state: "loading" });
    apiGet<UiShelfItemDetail>("/api/shelf/item", {
      repo,
      ref,
      ...(file !== null && { file }),
    }).then(
      (data) => setDetail({ state: "ready", data }),
      (error: unknown) =>
        setDetail({
          state: "error",
          error:
            error instanceof ApiError ? error : new ApiError(0, String(error)),
        }),
    );
  }, [repo, ref, file]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      )
        return;
      if (event.key === "/" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rows = useMemo<ShelfRow[]>(() => {
    if (shelf.state !== "ready") return [];
    const bundles: ShelfRow[] = shelf.data.bundles.map((bundle) => ({
      ref: bundle.ref,
      kind: "bundles",
      name: bundle.name,
      tags: bundle.tags,
      ...(bundle.description !== undefined && {
        description: bundle.description,
      }),
      source: "bundle",
      detail: bundle.malformed
        ? "malformed"
        : `${bundle.members.length} ${bundle.members.length === 1 ? "member" : "members"}`,
    }));
    const items: ShelfRow[] = shelf.data.items.map((item) => ({
      ref: item.ref,
      kind: item.kind,
      name: item.name,
      tags: item.tags,
      ...(item.description !== undefined && { description: item.description }),
      source: item.source,
      detail:
        item.usage.length === 0
          ? "not used"
          : `${item.usage.length} ${item.usage.length === 1 ? "project" : "projects"}`,
    }));
    return [...bundles, ...items];
  }, [shelf]);

  const ranked = useMemo(() => {
    if (query.trim().length === 0) {
      return rows.map((row) => ({ row, positions: [] as number[] }));
    }
    return rankRows(query, rows).map((entry) => ({
      row: entry.row,
      positions: entry.positions,
    }));
  }, [rows, query]);

  const select = (nextRef: string | null): void =>
    navigate({ view: "shelf", repo, ref: nextRef });

  if (overview === null) {
    return (
      <main class="shelf page">
        <Skeleton lines={4} label="Loading the shelf" />
      </main>
    );
  }
  if (repo === null) {
    return (
      <main class="shelf page">
        <EmptyState title="No shelf to show">
          <p>No registered project is bound to a data repo on this machine.</p>
        </EmptyState>
      </main>
    );
  }

  const grouped = query.trim().length === 0;
  let lastGroup = "";

  return (
    <main class="shelf" aria-label="Shelf">
      <section class="shelf-list" aria-label="Items and bundles">
        <div class="shelf-list-head">
          {overview.shelves.length > 1 ? (
            <label class="shelf-picker">
              <span class="visually-hidden">Shelf</span>
              <select
                value={repo}
                onChange={(event) =>
                  navigate({
                    view: "shelf",
                    repo: event.currentTarget.value,
                    ref: null,
                  })
                }
              >
                {overview.shelves.map((entry) => (
                  <option key={entry.dataRepo} value={entry.dataRepo}>
                    {entry.display}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p class="shelf-name mono" title={repo}>
              {overview.shelves.find((entry) => entry.dataRepo === repo)
                ?.display ?? repo}
            </p>
          )}
          {shelf.state === "ready" ? (
            <p class="muted shelf-facts">
              @{" "}
              <span class="mono">
                {shelf.data.facts.headShort || "no commits"}
              </span>
              {shelf.data.facts.branch ? ` · ${shelf.data.facts.branch}` : ""}
              {shelf.data.facts.clean ? "" : " · uncommitted changes"}
              {" · "}
              {shelf.data.projects.length}{" "}
              {shelf.data.projects.length === 1 ? "project" : "projects"}
            </p>
          ) : null}
          <label class="filter shelf-search">
            <Icon name="search" />
            <span class="visually-hidden">Search items and bundles</span>
            <input
              ref={searchRef}
              type="search"
              placeholder="Search items and bundles"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
              autocomplete="off"
              spellcheck={false}
            />
          </label>
        </div>
        {shelf.state === "loading" || shelf.state === "idle" ? (
          <Skeleton lines={6} label="Loading the shelf" />
        ) : shelf.state === "error" ? (
          <EmptyState title="The shelf could not be read">
            <p>{shelf.error.message}</p>
            {shelf.error.hint ? <p class="muted">{shelf.error.hint}</p> : null}
          </EmptyState>
        ) : ranked.length === 0 ? (
          <p class="muted shelf-empty">
            {rows.length === 0
              ? "The shelf holds no items or bundles yet."
              : `Nothing matches “${query}”.`}
          </p>
        ) : (
          <ul class="shelf-rows">
            {ranked.map(({ row, positions }) => {
              const group = row.source === "bundle" ? "bundles" : row.kind;
              const heading = grouped && group !== lastGroup ? group : null;
              lastGroup = group;
              return (
                <li key={row.ref}>
                  {heading ? <h2 class="shelf-group">{heading}</h2> : null}
                  <button
                    type="button"
                    class={`shelf-row${ref === row.ref ? " is-selected" : ""}`}
                    aria-current={ref === row.ref ? "true" : undefined}
                    onClick={() => select(row.ref)}
                  >
                    <span class="shelf-row-ref mono">
                      <HighlightedRef text={row.ref} positions={positions} />
                      {row.source === "system" ? (
                        <span class="chip chip-system">system</span>
                      ) : null}
                    </span>
                    <span class="shelf-row-detail muted">{row.detail}</span>
                    {row.description ? (
                      <span class="shelf-row-desc muted">
                        {row.description}
                      </span>
                    ) : null}
                    {row.tags.length > 0 ? (
                      <span class="shelf-row-tags">
                        {row.tags.map((tag) => (
                          <span key={tag} class="chip chip-tag">
                            #{tag}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {shelf.state === "ready" && shelf.data.warnings.length > 0 ? (
          <div class="shelf-warnings">
            <h2>Catalog warnings</h2>
            <ul>
              {shelf.data.warnings.map((warning) => (
                <li key={warning}>
                  <Icon name="alert" label="Warning" /> {warning}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
      <section class="shelf-reader" aria-label="Item">
        {ref === null ? (
          <EmptyState title="Select an item">
            <p>
              The reader shows the item's files, its metadata, and the projects
              that hold it.
            </p>
          </EmptyState>
        ) : ref.startsWith("bundles/") && shelf.state === "ready" ? (
          <BundleReader shelf={shelf.data} bundleRef={ref} onSelect={select} />
        ) : detail.state === "loading" || detail.state === "idle" ? (
          <Skeleton lines={8} label="Loading the item" />
        ) : detail.state === "error" ? (
          <EmptyState title="The item could not be read">
            <p>{detail.error.message}</p>
            {detail.error.hint ? (
              <p class="muted">{detail.error.hint}</p>
            ) : null}
          </EmptyState>
        ) : (
          <ItemReader
            detail={detail.data}
            file={file}
            onFile={setFile}
            onSelect={select}
          />
        )}
      </section>
    </main>
  );
}

function HighlightedRef({
  text,
  positions,
}: {
  text: string;
  positions: number[];
}): preact.JSX.Element {
  if (positions.length === 0) return <>{text}</>;
  const marked = new Set(positions);
  const chars = [...text];
  const parts: preact.JSX.Element[] = [];
  let run = "";
  let plain = "";
  const flushPlain = (): void => {
    if (plain) parts.push(<span key={`p${parts.length}`}>{plain}</span>);
    plain = "";
  };
  const flushRun = (): void => {
    if (run) parts.push(<mark key={`m${parts.length}`}>{run}</mark>);
    run = "";
  };
  chars.forEach((char, index) => {
    if (marked.has(index)) {
      flushPlain();
      run += char;
    } else {
      flushRun();
      plain += char;
    }
  });
  flushPlain();
  flushRun();
  return <>{parts}</>;
}

function BundleReader({
  shelf,
  bundleRef,
  onSelect,
}: {
  shelf: UiShelf;
  bundleRef: string;
  onSelect: (ref: string) => void;
}): preact.JSX.Element {
  const bundle = shelf.bundles.find((entry) => entry.ref === bundleRef);
  if (!bundle) {
    return <EmptyState title="Bundle not found" />;
  }
  return (
    <article class="reader">
      <header class="reader-head">
        <h1 class="mono">{bundle.ref}</h1>
        {bundle.description ? <p>{bundle.description}</p> : null}
        <Tags tags={bundle.tags} />
      </header>
      {bundle.malformed ? (
        <p class="tone-attention">{bundle.malformed}</p>
      ) : (
        <>
          <h2>Members</h2>
          <ul class="reader-list">
            {bundle.members.map((member) => (
              <li key={member}>
                <button
                  type="button"
                  class="link-button mono"
                  onClick={() => onSelect(member)}
                >
                  {member}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p class="muted">
        Install with <code>capshelf add {bundle.ref}</code> in a project.
      </p>
    </article>
  );
}

function Tags({ tags }: { tags: string[] }): preact.JSX.Element | null {
  if (tags.length === 0) return null;
  return (
    <p class="reader-tags">
      {tags.map((tag) => (
        <span key={tag} class="chip chip-tag">
          #{tag}
        </span>
      ))}
    </p>
  );
}

function ItemReader({
  detail,
  file,
  onFile,
  onSelect,
}: {
  detail: UiShelfItemDetail;
  file: string | null;
  onFile: (file: string | null) => void;
  onSelect: (ref: string) => void;
}): preact.JSX.Element {
  const current = detail.file;
  const currentName = current?.name ?? file;
  const isMarkdown = currentName?.toLowerCase().endsWith(".md") ?? false;
  const { metadata } = detail;
  return (
    <article class="reader">
      <header class="reader-head">
        <h1 class="mono">
          {detail.ref}
          {detail.source === "system" ? (
            <span class="chip chip-system">system</span>
          ) : null}
        </h1>
        {detail.description ? <p>{detail.description}</p> : null}
        <Tags tags={detail.tags} />
        <p class="muted reader-facts">
          {detail.lastCommit ? (
            <>
              last change <span class="mono">{detail.lastCommit.short}</span>{" "}
              {formatDay(detail.lastCommit.date)} · {detail.lastCommit.subject}
            </>
          ) : detail.source === "system" ? (
            "bundled in this CLI"
          ) : (
            "no committed change found"
          )}
        </p>
      </header>

      {metadata.requires.length > 0 ||
      metadata.conflictsWith.length > 0 ||
      hasNeeds(metadata.needs) ? (
        <dl class="facts">
          {metadata.requires.length > 0 ? (
            <div class="fact">
              <dt>Requires</dt>
              <dd>
                {metadata.requires.map((requirement) => (
                  <button
                    key={requirement}
                    type="button"
                    class="link-button mono"
                    onClick={() => onSelect(requirement)}
                  >
                    {requirement}
                  </button>
                ))}
              </dd>
            </div>
          ) : null}
          {metadata.conflictsWith.length > 0 ? (
            <div class="fact">
              <dt>Conflicts with</dt>
              <dd class="mono">{metadata.conflictsWith.join(", ")}</dd>
            </div>
          ) : null}
          {hasNeeds(metadata.needs) ? (
            <div class="fact">
              <dt>Needs</dt>
              <dd>
                {[
                  metadata.needs.network.length > 0
                    ? `network ${metadata.needs.network.join(", ")}`
                    : null,
                  metadata.needs.env.length > 0
                    ? `env ${metadata.needs.env.join(", ")}`
                    : null,
                  metadata.needs.bin.length > 0
                    ? `bin ${metadata.needs.bin.join(", ")}`
                    : null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <section class="reader-usage" aria-labelledby="usage-title">
        <h2 id="usage-title">
          {detail.usage.length === 0
            ? "Used by no registered project"
            : `Used by ${detail.usage.length} ${detail.usage.length === 1 ? "project" : "projects"}`}
        </h2>
        {detail.usage.length > 0 ? (
          <ul class="reader-list">
            {detail.usage.map((usage) => (
              <li key={`${usage.project}:${usage.scope}`}>
                <a
                  href={`#/status/${encodeURIComponent(usage.project)}`}
                  class="mono"
                >
                  {usage.display}
                </a>
                <span class="muted">
                  {" "}
                  · {usage.scope}
                  {usage.sourceCommitShort
                    ? ` · pinned ${usage.sourceCommitShort}`
                    : ""}
                  {usage.cliVersion ? ` · capshelf ${usage.cliVersion}` : ""}
                  {usage.current === true
                    ? " · current"
                    : usage.current === false
                      ? " · behind"
                      : ""}
                  {usage.keptLocal ? " · kept local" : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {detail.files.length > 0 ? (
        <section class="reader-files" aria-labelledby="files-title">
          <h2 id="files-title" class="visually-hidden">
            Files
          </h2>
          <div class="file-tabs" role="tablist" aria-label="Files">
            {detail.files.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                class={`tab${currentName === name ? " is-active" : ""}`}
                aria-selected={currentName === name}
                onClick={() => onFile(name)}
              >
                {name}
              </button>
            ))}
          </div>
          {current === null ? (
            <p class="muted">No file to show.</p>
          ) : current.binary ? (
            <p class="muted">
              <span class="mono">{current.name}</span> is a binary file (
              {current.size} bytes).
            </p>
          ) : current.text === null ? (
            <p class="muted">
              <span class="mono">{current.name}</span> is larger than 256 KiB (
              {current.size} bytes). Open it in the data repo.
            </p>
          ) : isMarkdown ? (
            <Markdown text={current.text} />
          ) : (
            <pre class="mono code-block">
              {current.text.split("\n").map((line, index) => (
                <span key={index} class="code-line">
                  {highlightLine(line, languageForPath(current.name))}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
        </section>
      ) : null}

      {detail.path ? (
        <p class="muted reader-path">
          Data repo path: <span class="mono">{detail.path}</span>
        </p>
      ) : null}
      {detail.metadata.warnings.length > 0 ? (
        <ul class="reader-warnings">
          {detail.metadata.warnings.map((warning) => (
            <li key={warning}>
              <Icon name="alert" label="Warning" /> {warning}
            </li>
          ))}
        </ul>
      ) : null}
      <p class="muted">
        Add it with <code>capshelf add {detail.ref}</code>
        {detail.lastCommit ? (
          <>
            {" "}
            · commit{" "}
            <span class="mono">{shortCommit(detail.lastCommit.sha)}</span>
          </>
        ) : null}
      </p>
    </article>
  );
}

function hasNeeds(needs: {
  network: string[];
  env: string[];
  bin: string[];
}): boolean {
  return (
    needs.network.length > 0 || needs.env.length > 0 || needs.bin.length > 0
  );
}
