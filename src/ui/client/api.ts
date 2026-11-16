import { isJsonObject, isJsonString } from "../shared/json";
import type { JsonValue } from "../shared/json";

const TOKEN_KEY = "capshelf-ui-token";

export function bootstrapToken(): void {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("t");
  if (token === null) return;
  window.sessionStorage.setItem(TOKEN_KEY, token);
  params.delete("t");
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
}

export function hasToken(): boolean {
  return window.sessionStorage.getItem(TOKEN_KEY) !== null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly hint: string | undefined;

  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.hint = hint;
  }
}

interface ApiErrorEnvelope {
  message: string;
  hint: string | undefined;
}

function errorEnvelope(body: JsonValue): ApiErrorEnvelope | null {
  if (!isJsonObject(body)) return null;
  const error = body.error;
  if (!isJsonObject(error) || !isJsonString(error.message)) return null;
  const hint = error.hint;
  return {
    message: error.message,
    hint: isJsonString(hint) ? hint : undefined,
  };
}

export async function apiGet<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const token = window.sessionStorage.getItem(TOKEN_KEY) ?? "";
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiError(
      0,
      "the capshelf ui server did not answer",
      "run capshelf ui again and open the URL it prints",
    );
  }
  if (!response.ok) {
    let body: JsonValue | null = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const envelope = body === null ? null : errorEnvelope(body);
    throw new ApiError(
      response.status,
      envelope?.message ?? `request failed with status ${response.status}`,
      envelope?.hint,
    );
  }
  // SAFETY: /api routes in src/ui/api.ts return the type the caller names, and
  // server and client ship in one build.
  return (await response.json()) as T;
}
