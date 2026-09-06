/**
 * The localhost server behind `capshelf ui`.
 *
 * It binds 127.0.0.1 only. Every `/api/` request must carry the bearer token
 * the command printed in its URL, the `Host` header must name this server,
 * no response is cacheable, and nothing here writes: the API is GET only and
 * every handler in `api.ts` reads.
 */
import { CliError, NotFoundError, PreconditionError } from "../errors";
import { UI_APP_CSS, UI_APP_JS, UI_INDEX_HTML, UI_LOGO_PATH } from "./assets";
import { createUiApi } from "./api";
import type { UiContext } from "./api";
import type { UiError } from "./shared/api-types";

export interface UiServerOptions extends UiContext {
  /** 0 or undefined picks a free port. */
  port?: number;
  token: string;
  /** How many project status reports may run at once. */
  concurrency?: number;
}

export interface UiServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

const HOSTNAME = "127.0.0.1";

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function startUiServer(options: UiServerOptions): UiServer {
  const api = createUiApi(options);
  const gate = createGate(options.concurrency ?? 3);
  const server = Bun.serve({
    hostname: HOSTNAME,
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!hostAllowed(request.headers.get("host"), listeningPort())) {
        return errorResponse(403, "request host is not this server");
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return errorResponse(
          405,
          "the web UI is read-only; only GET is served",
        );
      }
      if (url.pathname.startsWith("/api/")) {
        if (
          !tokenAllowed(request.headers.get("authorization"), options.token)
        ) {
          return errorResponse(
            401,
            "missing or wrong access token; open the URL capshelf ui printed",
          );
        }
        try {
          return json(await route(url));
        } catch (error) {
          return errorFrom(error);
        }
      }
      return staticResponse(url.pathname);
    },
  });

  async function route(url: URL): Promise<unknown> {
    const param = (name: string): string => {
      const value = url.searchParams.get(name);
      if (value === null || value.length === 0) {
        throw new PreconditionError(`query parameter ${name} is required`);
      }
      return value;
    };
    switch (url.pathname) {
      case "/api/overview":
        return await api.overview();
      case "/api/project/status":
        return await gate.run(() => api.projectStatus(param("project")));
      case "/api/project/diff": {
        const view = param("view");
        if (view !== "installed" && view !== "upstream") {
          throw new PreconditionError(
            `invalid view ${view}; expected installed or upstream`,
          );
        }
        return await api.projectDiff(param("project"), param("item"), view);
      }
      case "/api/shelf":
        return await gate.run(() => api.shelf(param("repo")));
      case "/api/shelf/item":
        return await api.shelfItem(
          param("repo"),
          param("ref"),
          url.searchParams.get("file") ?? undefined,
        );
      default:
        throw new NotFoundError(`no API route at ${url.pathname}`);
    }
  }

  function listeningPort(): number {
    const port = server.port;
    if (port === undefined) throw new Error("the UI server has no port");
    return port;
  }

  return {
    url: `http://${HOSTNAME}:${listeningPort()}`,
    port: listeningPort(),
    async stop() {
      await server.stop(true);
    },
  };
}

function staticResponse(pathname: string): Response {
  switch (pathname) {
    case "/":
    case "/index.html":
      return new Response(UI_INDEX_HTML, {
        headers: {
          ...BASE_HEADERS,
          "Content-Type": "text/html; charset=utf-8",
        },
      });
    case "/app.js":
      return new Response(UI_APP_JS, {
        headers: {
          ...BASE_HEADERS,
          "Content-Type": "text/javascript; charset=utf-8",
        },
      });
    case "/app.css":
      return new Response(UI_APP_CSS, {
        headers: { ...BASE_HEADERS, "Content-Type": "text/css; charset=utf-8" },
      });
    case "/logo.png":
      return new Response(Bun.file(UI_LOGO_PATH), {
        headers: { ...BASE_HEADERS, "Content-Type": "image/png" },
      });
    default:
      return errorResponse(404, `nothing is served at ${pathname}`);
  }
}

/**
 * The browser sends the host it connected to. A page on another origin that
 * tricks a resolver into pointing a name at 127.0.0.1 sends that name here,
 * and is refused.
 */
export function hostAllowed(host: string | null, port: number): boolean {
  if (host === null) return false;
  return (
    host === `${HOSTNAME}:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}`
  );
}

export function tokenAllowed(
  authorization: string | null,
  token: string,
): boolean {
  if (authorization === null) return false;
  const match = /^Bearer\s+(\S+)$/.exec(authorization);
  if (!match) return false;
  return timingSafeEqual(match[1] ?? "", token);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(
  status: number,
  message: string,
  hint?: string,
): Response {
  const body: UiError = { error: { message, ...(hint && { hint }) } };
  return json(body, status);
}

function errorFrom(error: unknown): Response {
  if (error instanceof NotFoundError) {
    return json(envelope(error), 404);
  }
  if (error instanceof CliError) {
    return json(envelope(error), 400);
  }
  const message = error instanceof Error ? error.message : String(error);
  return errorResponse(500, message);
}

function envelope(error: CliError): UiError {
  return {
    error: {
      message: error.message,
      ...(error.hint && { hint: error.hint }),
      exitCode: error.exitCode,
    },
  };
}

interface Gate {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * A status report spawns many git processes. Twenty projects refreshed at
 * once would spawn hundreds, so at most `limit` reports run together and the
 * rest wait their turn.
 */
function createGate(limit: number): Gate {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      active += 1;
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}
