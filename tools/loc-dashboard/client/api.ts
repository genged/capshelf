/** The client's one door to `serve.ts`. Local only, so no token rides along. */
import type { ApiErrorBody } from "../shared/types";

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
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new ApiError(
      0,
      "the dashboard server did not answer",
      "run bun run loc-dashboard again and open the URL it prints",
    );
  }
  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      // SAFETY: serve.ts answers every non-2xx status with an ApiErrorBody
      // envelope; a body of another shape falls through to the status text.
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
    throw new ApiError(
      response.status,
      body?.error.message ?? `request failed with status ${response.status}`,
      body?.error.hint,
    );
  }
  // SAFETY: the only server is serve.ts in this directory, and each route
  // writes the type its caller names from shared/types.ts.
  return (await response.json()) as T;
}
