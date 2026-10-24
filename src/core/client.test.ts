import { afterEach, describe, expect, it, vi } from "vitest";

import { respond, stubFetch } from "../test/helpers.ts";
import { ApiError, createJsonClient, userAgent } from "./client.ts";
import { ToolError } from "./tool.ts";

const client = (options: Partial<Parameters<typeof createJsonClient>[0]> = {}) =>
  createJsonClient({ name: "Example", baseUrl: "https://api.example.test", retryDelayMs: 0, ...options });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createJsonClient", () => {
  it("builds the URL, joins arrays, drops unset params and identifies itself", async () => {
    const fetch = stubFetch(respond('{"ok":true}'));
    await expect(client()("/v1/items", { ids: ["a", "b"], flag: false, n: 5, none: undefined, empty: null })).resolves.toEqual({ ok: true });
    const [input, init] = fetch.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("https://api.example.test/v1/items");
    expect(Object.fromEntries(url.searchParams)).toEqual({ ids: "a,b", flag: "false", n: "5" });
    // The test Worker sets no REPOSITORY_URL.
    expect(new Headers(init?.headers).get("User-Agent")).toBe("mcp-toolshed (Cloudflare Worker)");
  });

  it("names the deploying repository in the User-Agent when one is set", () => {
    expect(userAgent("https://github.com/someone/mcp-toolshed")).toBe("mcp-toolshed (+https://github.com/someone/mcp-toolshed)");
    expect(userAgent("")).toBe("mcp-toolshed (Cloudflare Worker)");
  });

  it("returns whatever unwrap extracts", async () => {
    stubFetch(respond('{"hits":[1,2]}'));
    const get = client({ unwrap: (body) => ({ data: (body as { hits: unknown }).hits }) });
    await expect(get("/search", {})).resolves.toEqual([1, 2]);
  });

  it("names the API, status and endpoint in errors, as a ToolError", async () => {
    stubFetch(respond('{"message":"bad"}', { status: 400 }));
    const get = client({ unwrap: (body) => ({ error: (body as { message: string }).message }) });
    const error = await get("/v1/items", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as Error).message).toBe("Example error (HTTP 400) for /v1/items: bad");
  });

  it.each([
    ["X-RateLimit-Reset", "12"],
    ["Retry-After", "30"],
  ])("reports rate limiting with the %s delay, without retrying", async (header, seconds) => {
    const fetch = stubFetch(respond("", { status: 429, headers: { [header]: seconds } }));
    await expect(client()("/x", {})).rejects.toThrow(`Rate limited by Example; retry in ${seconds}s.`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx once by default, but not a 4xx", async () => {
    const retried = stubFetch(respond("oops", { status: 503 }), respond("[1]"));
    await expect(client()("/x", {})).resolves.toEqual([1]);
    expect(retried).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
    const notRetried = stubFetch(respond('"nope"', { status: 404 }));
    await expect(client()("/x", {})).rejects.toThrow("Example error (HTTP 404) for /x: unexpected response");
    expect(notRetried).toHaveBeenCalledTimes(1);
  });

  it("uses the API's retry rule and hint", async () => {
    const fetch = stubFetch(respond("slow", { status: 408 }), respond("slow", { status: 408 }));
    const get = client({ retryable: (status) => status === 408, hint: (detail) => (detail.includes("slow") ? "Try later." : undefined) });
    await expect(get("/x", {})).rejects.toThrow("Example error (HTTP 408) for /x: non-JSON response: slow. Try later.");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports bodies unwrap does not recognise, even with HTTP 200", async () => {
    stubFetch(respond("null"));
    await expect(client({ unwrap: () => undefined })("/x", {})).rejects.toThrow("(HTTP 200) for /x: unexpected response: null");
  });
});
