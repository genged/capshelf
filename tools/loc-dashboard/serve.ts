#!/usr/bin/env bun
/**
 * The localhost server behind the LOC dashboard, a helper that is not part
 * of the capshelf release. It binds 127.0.0.1, bundles the client into
 * memory at start, reads git through `collect.ts`, and writes nothing.
 *
 *   bun run tools/loc-dashboard/serve.ts [--repo <path>] [--branch <name>]
 *                                       [--port <n>] [--no-measure]
 *
 * Measures (test coverage and Oxlint) run once at start unless the store
 * already holds a run for the current clean HEAD or `--no-measure` is set.
 * `POST /api/measures/run` starts another run.
 */
import { join } from "node:path";
import { GitError, LocCollector } from "./collect";
import { Measures } from "./measures";
import type {
  ApiErrorBody,
  LocBreakdown,
  LocHistory,
  MeasuresState,
} from "./shared/types";

const HOSTNAME = "127.0.0.1";
const ROOT = join(import.meta.dir, "..", "..");
const LOGO = join(ROOT, "docs", "logo.png");

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Lines of code · Capshelf</title>
<link rel="icon" href="/logo.png">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`;

interface Options {
  repo: string;
  branch: string | undefined;
  port: number;
  measure: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    repo: process.cwd(),
    branch: undefined,
    port: 0,
    measure: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--repo" && value !== undefined) {
      options.repo = value;
      index += 1;
    } else if (arg === "--branch" && value !== undefined) {
      options.branch = value;
      index += 1;
    } else if (arg === "--port" && value !== undefined) {
      options.port = Number(value);
      index += 1;
    } else if (arg === "--no-measure") {
      options.measure = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: bun run tools/loc-dashboard/serve.ts [--repo <path>] [--branch <name>] [--port <n>] [--no-measure]",
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

interface Bundle {
  js: string;
  css: string;
}

async function buildClient(): Promise<Bundle> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "client", "app.tsx")],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    throw new Error("the client bundle failed to build");
  }
  let js = "";
  let css = "";
  for (const output of result.outputs) {
    if (output.path.endsWith(".css")) css += await output.text();
    else if (output.path.endsWith(".js")) js += await output.text();
  }
  return { js, css };
}

type ApiBody = LocHistory | LocBreakdown | MeasuresState | ApiErrorBody;

function json(value: ApiBody, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function fail(status: number, message: string, hint?: string): Response {
  const body: ApiErrorBody = { error: { message, ...(hint && { hint }) } };
  return json(body, status);
}

function text(body: string, type: string): Response {
  return new Response(body, {
    headers: { ...HEADERS, "Content-Type": `${type}; charset=utf-8` },
  });
}

export function hostAllowed(host: string | null, port: number): boolean {
  return (
    host === `${HOSTNAME}:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}`
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let collector: LocCollector;
  try {
    collector = await LocCollector.open(options.repo, options.branch);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const bundle = await buildClient();

  // One git read at a time; the browser's refresh and breakdown calls queue
  // behind the first full read, which starts before the URL prints.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };
  const measures = new Measures(collector.repo);
  await measures.load();
  const startMeasures = (): void => {
    console.error("measuring test coverage and oxlint…");
    void measures.start().then(
      () => console.error("measures recorded"),
      (error: Error) => console.error(`measures failed: ${error.message}`),
    );
  };
  if (options.measure) {
    void measures.isCurrent().then((current) => {
      if (current) console.error("measures are current for HEAD; skipping");
      else startMeasures();
    });
  }
  const started = performance.now();
  void serial(() => collector.history()).then(
    (history) =>
      console.error(
        `read ${history.commits.length} commits on ${collector.branch} in ${Math.round(performance.now() - started)} ms`,
      ),
    (error: Error) => console.error(error.message),
  );

  const server = Bun.serve({
    hostname: HOSTNAME,
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (!hostAllowed(request.headers.get("host"), server.port ?? 0)) {
        return fail(403, "request host is not this server");
      }
      if (request.method === "POST" && url.pathname === "/api/measures/run") {
        if (!measures.state().running) startMeasures();
        return json(measures.state(), 202);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return fail(405, "only GET is served, except POST /api/measures/run");
      }
      try {
        switch (url.pathname) {
          case "/":
          case "/index.html":
            return text(INDEX_HTML, "text/html");
          case "/app.js":
            return text(bundle.js, "text/javascript");
          case "/app.css":
            return text(bundle.css, "text/css");
          case "/logo.png":
            return new Response(Bun.file(LOGO), {
              headers: { ...HEADERS, "Content-Type": "image/png" },
            });
          case "/api/history":
            return json(await serial(() => collector.history()));
          case "/api/measures":
            return json(measures.state());
          case "/api/breakdown": {
            const sha = url.searchParams.get("sha");
            if (sha === null || !/^[0-9a-f]{7,40}$/.test(sha)) {
              return fail(400, "query parameter sha must be a commit id");
            }
            return json(await serial(() => collector.breakdown(sha)));
          }
          default:
            return fail(404, `nothing is served at ${url.pathname}`);
        }
      } catch (error) {
        if (error instanceof GitError) return fail(500, error.message);
        return fail(
          500,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });
  console.log(`http://${HOSTNAME}:${server.port}/`);
}

if (import.meta.main) await main();
