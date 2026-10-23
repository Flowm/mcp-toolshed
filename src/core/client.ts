// A small JSON API client with the behaviour every platform needs: query building, rate-limit
// messages, one retry on transient failures, and error messages the model can act on.

import { env } from "cloudflare:workers";

import { ToolError } from "./tool.ts";

/** Query parameters for an API call; unset values are dropped and arrays are comma-joined. */
export type Params = Record<string, string | number | boolean | string[] | undefined | null>;

/** Calls an API endpoint and returns its payload. */
export type Get = <T = unknown>(path: string, params: Params) => Promise<T>;

/** A failed API call; its message names the API, the HTTP status and the endpoint. */
export class ApiError extends ToolError {}

/**
 * The User-Agent sent to every API. A deploy can set REPOSITORY_URL (CI passes the repository it runs in), so API
 * operators can see whose deployment is calling; forks then name themselves.
 */
export const userAgent = (repositoryUrl?: string) => (repositoryUrl ? `mcp-toolshed (+${repositoryUrl})` : "mcp-toolshed (Cloudflare Worker)");

/** What a parsed JSON body means: the payload, an error the API reports, or nothing recognisable. */
export type Unwrapped = { data: unknown } | { error: string } | undefined;

export interface JsonClientOptions {
  /** The API's name in error messages, e.g. "Arctic Shift". */
  name: string;
  baseUrl: string;
  /** Reads a parsed JSON body. By default the whole body is the payload. */
  unwrap?: (body: unknown) => Unwrapped;
  /** Whether a failed call is worth one retry. By default any 5xx, including Cloudflare's 520-524 edge errors. */
  retryable?: (status: number, detail: string) => boolean;
  /** Advice appended to an error message, e.g. how to narrow a query that timed out. */
  hint?: (detail: string) => string | undefined;
  /** Wait before the retry, 1s by default; tests set it to 0. */
  retryDelayMs?: number;
}

type Attempt = { ok: true; data: unknown } | { ok: false; error: ApiError; retryable: boolean };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createJsonClient({
  name,
  baseUrl,
  unwrap = (body) => ({ data: body }),
  retryable = (status) => status >= 500,
  hint = () => undefined,
  retryDelayMs = 1000,
}: JsonClientOptions): Get {
  async function attempt(url: URL): Promise<Attempt> {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": userAgent(env.REPOSITORY_URL) } });

    if (res.status === 429) {
      const reset = res.headers.get("X-RateLimit-Reset") ?? res.headers.get("Retry-After");
      return { ok: false, retryable: false, error: new ApiError(`Rate limited by ${name}${reset ? `; retry in ${reset}s` : ""}.`) };
    }

    const body = await res.text();
    let result: Unwrapped;
    let isJson = true;
    try {
      result = unwrap(JSON.parse(body));
    } catch {
      // Handled below: a non-JSON body is an error page or an outage.
      isJson = false;
    }
    if (res.ok && result && "data" in result) return { ok: true, data: result.data };

    let detail = `non-JSON response: ${body.slice(0, 300)}`;
    if (result && "error" in result) detail = result.error;
    else if (isJson) detail = `unexpected response: ${body.slice(0, 300) || "(empty)"}`;
    return {
      ok: false,
      retryable: retryable(res.status, detail),
      error: new ApiError(`${name} error (HTTP ${res.status}) for ${url.pathname}: ${detail}${hint(detail) ?? ""}`),
    };
  }

  return async <T>(path: string, params: Params): Promise<T> => {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }

    let result = await attempt(url);
    if (!result.ok && result.retryable) {
      await sleep(retryDelayMs);
      result = await attempt(url);
    }
    if (!result.ok) throw result.error;
    return result.data as T;
  };
}
