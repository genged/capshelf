/**
 * The client's one door to the server. The access token arrives in the URL
 * `capshelf ui` prints, moves into session storage on the first load, and
 * rides every API call as a bearer header.
 */
import type { UiError } from "../shared/api-types";

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
    let body: UiError | null = null;
    try {
      body = (await response.json()) as UiError;
    } catch {
      body = null;
    }
    throw new ApiError(
      response.status,
      body?.error.message ?? `request failed with status ${response.status}`,
      body?.error.hint,
    );
  }
  return (await response.json()) as T;
}
