import { afterEach, describe, expect, it, vi } from "vitest";

import { createJsonClient } from "../../core/client.ts";
import { respond, stubFetch } from "../../test/helpers.ts";
import { arcticShiftOptions } from "./api.ts";

const callApi = createJsonClient({ ...arcticShiftOptions, retryDelayMs: 0 });
const timeout = () => respond('{"data":null,"error":"Timeout. Maybe slow down a bit"}', { status: 422 });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Arctic Shift client", () => {
  it("calls the Arctic Shift API and returns the data payload", async () => {
    const fetch = stubFetch(respond('{"data":[{"id":"x"}]}'));
    await expect(callApi("/api/posts/ids", { ids: ["a", "b"] })).resolves.toEqual([{ id: "x" }]);
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe("https://arctic-shift.photon-reddit.com/api/posts/ids");
  });

  it("reports rate limiting by name", async () => {
    stubFetch(respond("", { status: 429, headers: { "X-RateLimit-Reset": "12" } }));
    await expect(callApi("/api/posts/search", {})).rejects.toThrow("Rate limited by Arctic Shift; retry in 12s.");
  });

  it("does not retry client errors and includes the API's message", async () => {
    const fetch = stubFetch(respond('{"data":null,"error":"key is not a valid value"}', { status: 400 }));
    await expect(callApi("/api/time_series", { key: "x" })).rejects.toThrow("Arctic Shift error (HTTP 400) for /api/time_series: key is not a valid value");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([422, 500, 503, 520, 524])("retries once after HTTP %i", async (status) => {
    const fetch = stubFetch(respond('{"data":null,"error":"boom"}', { status }), respond('{"data":[1]}'));
    await expect(callApi("/api/posts/search", {})).resolves.toEqual([1]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second failure and suggests narrowing a timed-out query", async () => {
    const fetch = stubFetch(timeout(), timeout());
    await expect(callApi("/api/posts/search/aggregate", {})).rejects.toThrow(/HTTP 422.*Timeout\. Maybe slow down a bit Try narrowing the query/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats an error field in a 200 response as a failure, retrying timeouts", async () => {
    const fetch = stubFetch(respond('{"error":"Query timed out"}'), respond('{"error":"Query timed out"}'));
    await expect(callApi("/api/comments/search", {})).rejects.toThrow(/HTTP 200.*Query timed out Try narrowing/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports JSON bodies that are not an API response", async () => {
    stubFetch(respond("null"));
    await expect(callApi("/api/posts/search", {})).rejects.toThrow("(HTTP 200) for /api/posts/search: unexpected response: null");
  });

  it("reports non-JSON bodies", async () => {
    stubFetch(respond("<html>Bad gateway</html>", { status: 502 }), respond("<html>Bad gateway</html>", { status: 502 }));
    await expect(callApi("/api/posts/search", {})).rejects.toThrow("(HTTP 502) for /api/posts/search: non-JSON response: <html>Bad gateway</html>");
  });
});
