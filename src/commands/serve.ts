import type { Command } from "commander";
import type { Command as CmdType } from "commander";
import { join, normalize, resolve, sep } from "node:path";
import { projectRoot } from "../paths";
import { globalOpts } from "../cli";
import { PRODUCT_NAME } from "../identity";
import { defaultApiContext, handleApiRequest } from "../serve-api";
import { WEB_ASSETS } from "../web-embed";

// When the binary was compiled with embedded assets, serve those; otherwise
// (dev / `bun run`) fall back to web/dist on disk.
const EMBEDDED = Object.keys(WEB_ASSETS).length > 0;

interface ServeOptions {
  port: string;
  host: string;
  open: boolean;
}

// Built web assets live next to the source as ../web/dist. In a dev run
// (`bun run src/cli.ts serve`) this resolves into the repo; if the UI hasn't
// been built yet the server still boots and serves a hint page.
const WEB_DIR = resolve(import.meta.dir, "..", "..", "web", "dist");

export function registerServe(program: Command): void {
  program
    .command("serve")
    .description("start a local web UI + read-only API for this project")
    .option("-p, --port <port>", "port to listen on", "4717")
    .option("--host <host>", "host to bind", "127.0.0.1")
    .option("--no-open", "do not open the browser")
    .action(async (opts: ServeOptions, cmd: CmdType) => {
      const project = projectRoot();
      const ctx = defaultApiContext(globalOpts(cmd).data);
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid port "${opts.port}"`);
      }

      const server = Bun.serve({
        port,
        hostname: opts.host,
        development: false,
        async fetch(req) {
          const api = await handleApiRequest(req, ctx);
          if (api) return api;
          return serveStatic(req);
        },
      });

      const url = `http://${opts.host}:${server.port}`;
      console.log(`✓ ${PRODUCT_NAME} serve`);
      console.log(`  project   ${project}`);
      console.log(`  url       ${url}`);
      console.log(`  mode      read-only`);
      console.log(`  press Ctrl-C to stop`);

      if (opts.open) openBrowser(url);

      // Keep the process alive; Bun.serve runs until the process is killed.
      await new Promise<never>(() => {});
    });
}

async function serveStatic(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const rel = pathname === "/" ? "/index.html" : pathname;

  if (EMBEDDED) {
    // SPA fallback to index.html for unknown client-side routes.
    const asset = WEB_ASSETS[rel] ?? WEB_ASSETS["/index.html"];
    if (asset) {
      return new Response(Buffer.from(asset.base64, "base64"), {
        headers: { "content-type": asset.type },
      });
    }
  }

  // Resolve and confine to WEB_DIR to block path traversal. The trailing
  // separator on the boundary check stops a sibling like "<WEB_DIR>-evil"
  // from satisfying a bare startsWith().
  const target = normalize(join(WEB_DIR, rel));
  if (target === WEB_DIR || target.startsWith(WEB_DIR + sep)) {
    const file = Bun.file(target);
    if (await file.exists()) return new Response(file);
  }
  // SPA fallback to index.html for client-side routes.
  const index = Bun.file(join(WEB_DIR, "index.html"));
  if (await index.exists()) return new Response(index);
  return new Response(notBuiltPage(), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Opening the browser is best-effort; the URL is printed regardless.
  }
}

function notBuiltPage(): string {
  return `<!doctype html><meta charset="utf-8">
<title>${PRODUCT_NAME}</title>
<body style="font:14px ui-monospace,monospace;background:#161318;color:#f3eef2;padding:40px;line-height:1.6">
<h2 style="font-weight:650">${PRODUCT_NAME} serve</h2>
<p>The API is live at <code>/api/status</code>, <code>/api/catalog</code>, <code>/api/health</code>.</p>
<p>The web UI has not been built yet. From the repo root run:</p>
<pre style="background:#1d1922;border:1px solid #2f2935;border-radius:8px;padding:12px">bun run web:build</pre>
<p style="color:#a79faa">then reload this page.</p>
</body>`;
}
