/**
 * Security: bind 127.0.0.1 only, require the bearer token on /api, check the
 * Host header, never cache responses, and serve only GET and HEAD. Every
 * handler in `api.ts` must also only read, since the method check alone does
 * not stop a write.
 */
import { CliError, NotFoundError, PreconditionError } from "../errors";
import { UI_APP_CSS, UI_APP_JS, UI_INDEX_HTML, UI_LOGO_PATH } from "./assets";
import { createUiApi } from "./api";
import type { UiApi, UiContext } from "./api";
import type { UiError } from "./shared/api-types";

type UiPayload = Awaited<ReturnType<UiApi[keyof UiApi]>>;

export interface UiServerOptions extends UiContext {
  port?: number;
  token: string;
  concurrency?: number;
}

export interface UiServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

const HOSTNAME = "127.0.0.1";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const satisfies Record<string, string>;

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

  async function route(url: URL): Promise<UiPayload> {
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
        const snapshot = url.searchParams.get("snapshot") ?? undefined;
        return await api.projectDiff(
          param("project"),
          param("item"),
          view,
          snapshot,
        );
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
 * Rejects unknown Host headers to block DNS rebinding, where another origin's
 * name resolves to 127.0.0.1.
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

function json(value: UiPayload | UiError, status = 200): Response {
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

function errorFrom(cause: unknown): Response {
  if (cause instanceof NotFoundError) {
    return json(envelope(cause), 404);
  }
  if (cause instanceof CliError) {
    return json(envelope(cause), 400);
  }
  const message = cause instanceof Error ? cause.message : String(cause);
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
 * Status reports spawn many git processes, so cap concurrent reports to avoid
 * hundreds at once.
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
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
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
