import { createJsonClient, type JsonClientOptions, type Unwrapped } from "../../core/client.ts";

export const BASE_URL = "https://arctic-shift.photon-reddit.com";

const TIMEOUT_PATTERN = /time(d)? ?out|slow down/i;
const NARROWING_HINT = " Try narrowing the query: add subreddit or author, an after/before date range, or a lower limit.";

// Arctic Shift wraps payloads as {"data": ...} and reports failures as {"error": "..."}, even with HTTP 200.
function unwrap(body: unknown): Unwrapped {
  if (typeof body !== "object" || body === null) return undefined;
  const { data, error } = body as { data?: unknown; error?: unknown };
  return error ? { error: String(error) } : { data };
}

export const arcticShiftOptions: JsonClientOptions = {
  name: "Arctic Shift",
  baseUrl: BASE_URL,
  unwrap,
  // A 422 is usually a query that timed out on a cold planner, not a bad query; like a timeout
  // reported with any status, and any 5xx, it often succeeds on a second try.
  retryable: (status, detail) => status === 422 || status >= 500 || TIMEOUT_PATTERN.test(detail),
  hint: (detail) => (TIMEOUT_PATTERN.test(detail) ? NARROWING_HINT : undefined),
};

/** Calls an Arctic Shift API endpoint and returns its `data` payload. Retries once on transient failures. */
export const callApi = createJsonClient(arcticShiftOptions);
