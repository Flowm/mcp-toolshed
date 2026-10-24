import { createJsonClient, type JsonClientOptions, type Params, type Unwrapped } from "../../core/client.ts";

export const BASE_URL = "https://arctic-shift.photon-reddit.com";

const TIMEOUT_PATTERN = /time(d)? ?out|slow down/i;

/**
 * How to narrow a query that timed out, naming only filters it does not set yet. Comment body search across a whole
 * subreddit times out even over a week, so it points at post search, which finishes for the same subreddit and range.
 */
function narrowingHint({ author, subreddit, after, before, limit, body, link_id, parent_id }: Params): string {
  if (body && !author && !link_id && !parent_id) {
    return (
      "Comment body search across a whole subreddit often times out, even over a short date range. " +
      "Find threads with search_posts query instead and read their comments with get_thread, or add author or link_id to body search."
    );
  }
  const steps = [];
  if (!author && !subreddit) steps.push("add subreddit or author");
  if (after && before) steps.push("shorten the after/before range");
  else if (after || before) steps.push(`add ${after ? "before" : "after"} to shorten the date range`);
  else steps.push("add an after/before date range");
  if (limit === "auto" || (typeof limit === "number" && limit > 25)) steps.push("a lower limit");
  return `Try narrowing the query: ${steps.join(", ")}.`;
}

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
  hint: (detail, params) => (TIMEOUT_PATTERN.test(detail) ? narrowingHint(params) : undefined),
};

/** Calls an Arctic Shift API endpoint and returns its `data` payload. Retries once on transient failures. */
export const callApi = createJsonClient(arcticShiftOptions);
