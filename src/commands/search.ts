import type { Command } from "commander";
import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { homeRelative, projectRoot, resolveDataRepo } from "../paths";
import { loadManifest } from "../manifest";
import {
  ITEM_KINDS,
  canonicalItemRelPaths,
  isFragmentItemKind,
  itemRepoRelPath,
  listMasterItems,
  shaOfGitVisibleItem,
} from "../master";
import type { ItemKind, MasterItem } from "../master";
import { SYSTEM_ITEMS, shaOfSystemItem } from "../bundled";
import type { SystemItem } from "../bundled";
import { assertIsGitRepo, gitVisibleFilesUnderPath } from "../git";
import { globalOpts } from "../cli";
import { shaOfFragmentItem } from "../fragments";
import {
  loadDataItemMetadata,
  loadSystemItemMetadata,
  metadataLineSuffix,
  printMetadataWarnings,
} from "../metadata";
import type { ItemMetadata } from "../metadata";
import {
  MAX_SEARCHABLE_CONTENT_BYTES,
  compareResults,
  isSearchableContent,
  matchAnnotations,
  matchItem,
  splitTerms,
} from "../search-core";
import type { SearchContentFile, SearchMatch } from "../search-core";
import { listBundles, memberCountSummary, memberRef } from "../bundles";
import type { Bundle } from "../bundles";
import { truncatedDescription } from "../metadata";

interface SearchOptions {
  json?: boolean;
  kind?: string;
}

interface SearchResult {
  source: "data" | "system";
  kind: ItemKind;
  name: string;
  sha: string;
  score: number;
  meta: ItemMetadata;
  matches: SearchMatch[];
}

interface BundleSearchResult {
  bundle: Bundle;
  score: number;
  matches: SearchMatch[];
}

export function registerSearch(program: Command): void {
  program
    .command("search <query...>")
    .description(
      "search available items (data repo + system) by name, tags, description, and content",
    )
    .option(
      "-k, --kind <kind>",
      "filter by kind (skills|settings|mcp|codex-config)",
    )
    .option("--json", "output JSON")
    .action(async (queryParts: string[], opts: SearchOptions, cmd: Command) => {
      if (opts.kind && !ITEM_KINDS.includes(opts.kind as ItemKind)) {
        throw new Error(
          `invalid kind "${opts.kind}"; must be one of ${ITEM_KINDS.join(", ")}`,
        );
      }
      const kind = opts.kind as ItemKind | undefined;
      const query = queryParts.join(" ");
      const terms = splitTerms(query);

      const project = projectRoot();
      const manifest = await loadManifest(project);
      const dataRepo = await resolveDataRepo({
        override: globalOpts(cmd).data,
        manifest,
        project,
      });
      await assertIsGitRepo(dataRepo);

      const results: SearchResult[] = [];
      for (const item of SYSTEM_ITEMS.filter((s) => !kind || s.kind === kind)) {
        const meta = loadSystemItemMetadata(item);
        printMetadataWarnings(meta);
        const score = matchItem(terms, {
          name: `${item.kind}/${item.name}`,
          tags: meta.tags,
          ...(meta.description !== undefined && {
            description: meta.description,
          }),
          files: systemContentFiles(item),
        });
        if (!score) continue;
        results.push({
          source: "system",
          kind: item.kind,
          name: item.name,
          sha: await shaOfSystemItem(item),
          meta,
          ...score,
        });
      }
      for (const item of await listMasterItems(dataRepo, kind)) {
        const meta = await loadDataItemMetadata(item);
        printMetadataWarnings(meta);
        const score = matchItem(terms, {
          name: `${item.kind}/${item.name}`,
          tags: meta.tags,
          ...(meta.description !== undefined && {
            description: meta.description,
          }),
          files: await dataContentFiles(dataRepo, item),
        });
        if (!score) continue;
        results.push({
          source: "data",
          kind: item.kind,
          name: item.name,
          sha: isFragmentItemKind(item.kind)
            ? await shaOfFragmentItem(dataRepo, item.kind, item.name)
            : await shaOfGitVisibleItem(dataRepo, item.repoRelPath),
          meta,
          ...score,
        });
      }
      results.sort((a, b) =>
        compareResults(
          { score: a.score, name: `${a.kind}/${a.name}` },
          { score: b.score, name: `${b.kind}/${b.name}` },
        ),
      );

      // Bundles score with the same weights: name 8 / tags 4 / description 2,
      // and member refs as the content field (weight 1) via a synthetic
      // SearchableItem — `search postgres` surfaces the bundle delivering
      // mcp/postgres-local. Suppressed under --kind (bundles are not a kind);
      // malformed bundles are excluded (read path warns).
      const bundleResults: BundleSearchResult[] = [];
      if (!kind) {
        const listing = await listBundles(dataRepo);
        for (const warning of listing.warnings) console.error(`⚠ ${warning}`);
        for (const bundle of listing.bundles) {
          for (const warning of new Set(bundle.warnings)) {
            console.error(`⚠ ${warning}`);
          }
          if (bundle.malformed) continue;
          const score = matchItem(terms, {
            name: `bundles/${bundle.name}`,
            tags: bundle.tags,
            ...(bundle.description !== undefined && {
              description: bundle.description,
            }),
            files: [
              {
                relPath: "members",
                content: bundle.members.map(memberRef).join(" "),
              },
            ],
          });
          if (!score) continue;
          bundleResults.push({ bundle, ...score });
        }
        bundleResults.sort((a, b) =>
          compareResults(
            { score: a.score, name: `bundles/${a.bundle.name}` },
            { score: b.score, name: `bundles/${b.bundle.name}` },
          ),
        );
      }

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              query,
              dataRepo,
              results: results.map((result) => ({
                source: result.source,
                kind: result.kind,
                name: result.name,
                sha: result.sha,
                score: result.score,
                ...(result.meta.description !== undefined && {
                  description: result.meta.description,
                }),
                ...(result.meta.tags.length > 0 && { tags: result.meta.tags }),
                matches: result.matches.map((match) => ({
                  term: match.term,
                  field: match.field,
                  ...(match.file !== undefined && { file: match.file }),
                })),
              })),
              // Append-only: `results` stays items-only (no new `source`
              // enum value); bundles ride a sibling top-level key.
              ...(bundleResults.length > 0 && {
                bundles: bundleResults.map((result) => ({
                  name: result.bundle.name,
                  score: result.score,
                  ...(result.bundle.description !== undefined && {
                    description: result.bundle.description,
                  }),
                  ...(result.bundle.tags.length > 0 && {
                    tags: result.bundle.tags,
                  }),
                  members: result.bundle.members.map(memberRef),
                  matches: result.matches.map((match) => ({
                    term: match.term,
                    field: match.field,
                  })),
                })),
              }),
            },
            null,
            2,
          ),
        );
        return;
      }

      // Zero matches exit 0: search is a query, not a lookup — an empty
      // shelf-section is a valid answer.
      const total = results.length + bundleResults.length;
      if (total === 0) {
        console.log("(no matches)");
        return;
      }
      const plural = total === 1 ? "match" : "matches";
      console.log(`${total} ${plural} in ${homeRelative(dataRepo)} (+ system)`);
      console.log("");
      // One ranked list: bundles interleave with items by score, name as the
      // deterministic tie-break.
      const rows: Array<
        | { type: "item"; score: number; name: string; item: SearchResult }
        | {
            type: "bundle";
            score: number;
            name: string;
            result: BundleSearchResult;
          }
      > = [
        ...results.map((item) => ({
          type: "item" as const,
          score: item.score,
          name: `${item.kind}/${item.name}`,
          item,
        })),
        ...bundleResults.map((result) => ({
          type: "bundle" as const,
          score: result.score,
          name: `bundles/${result.bundle.name}`,
          result,
        })),
      ].sort(compareResults);
      for (const row of rows) {
        if (row.type === "item") {
          const result = row.item;
          console.log(
            `  ${row.name.padEnd(33)} ${result.source.padEnd(6)}  matched: ${matchAnnotations(result.matches).join(", ")}`,
          );
          const suffix = metadataLineSuffix(result.meta);
          if (suffix) console.log(`    ${suffix.trimStart()}`);
          continue;
        }
        const { bundle, matches } = row.result;
        console.log(
          `  ${row.name.padEnd(33)} bundle  matched: ${matchAnnotations(matches).join(", ")}`,
        );
        const detail = [
          ...(bundle.description !== undefined
            ? [truncatedDescription(bundle.description)]
            : []),
          ...(bundle.members.length > 0 ? [memberCountSummary(bundle)] : []),
        ].join("  ");
        if (detail) console.log(`    ${detail}`);
      }
    });
}

function systemContentFiles(item: SystemItem): SearchContentFile[] {
  return item.files
    .filter((file) =>
      isSearchableContent(file.relPath, Buffer.from(file.content, "utf-8")),
    )
    .map((file) => ({ relPath: file.relPath, content: file.content }));
}

/**
 * Content files for a data item, read from the data repo working tree.
 * Fragments search only their canonical source files — never the installed
 * merged outputs, which would attribute other fragments' text to this one.
 */
async function dataContentFiles(
  dataRepo: string,
  item: MasterItem,
): Promise<SearchContentFile[]> {
  const itemRoot = itemRepoRelPath(item.kind, item.name);
  const relPaths = isFragmentItemKind(item.kind)
    ? (await canonicalItemRelPaths(dataRepo, item.kind, item.name)).map(
        (repoRel) => posix.relative(itemRoot, repoRel),
      )
    : await gitVisibleFilesUnderPath(dataRepo, itemRoot);

  const out: SearchContentFile[] = [];
  for (const relPath of relPaths) {
    const abs = join(dataRepo, ...itemRoot.split("/"), ...relPath.split("/"));
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile() || info.size > MAX_SEARCHABLE_CONTENT_BYTES) continue;
    const content = await readFile(abs);
    if (!isSearchableContent(relPath, content)) continue;
    out.push({ relPath, content: content.toString("utf-8") });
  }
  return out;
}
