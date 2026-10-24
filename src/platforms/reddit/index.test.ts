import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeParams, rpc as rpcWorker } from "../../test/helpers.ts";

const rpc = (method: string, params?: unknown) => rpcWorker("/reddit/mcp", method, params);

const callTool = async (name: string, args: Record<string, unknown>) => {
  const result = await rpc("tools/call", { name, arguments: args });
  return { text: result.content[0].text as string, isError: result.isError === true };
};

/** Answers each Arctic Shift path with its `data` payload and records the requested URLs. */
const stubApi = (routes: Record<string, unknown> = {}) => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const { pathname } = new URL(String(input));
    return new Response(JSON.stringify({ data: pathname in routes ? routes[pathname] : [] }));
  });
  return {
    fetch,
    requests: () =>
      fetch.mock.calls.map(([input]) => {
        const url = new URL(String(input));
        return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
      }),
  };
};

const OLD = 1577799850;
const POST = {
  id: "7cff0b",
  title: "Seriously? I paid 80$ to have Vader locked?",
  author: "MBMMaverick",
  subreddit: "StarWarsBattlefront",
  score: 3000,
  num_comments: 4,
  created_utc: OLD,
};
const TREE = [
  { kind: "t1", data: { id: "dppum98", author: "EACommunityTeam", score: -667000, body: "The intent is to provide players with a sense of pride", created_utc: OLD, replies: "" } },
];
const POST_FIELDS = "id,title,author,subreddit,score,num_comments,created_utc,url,selftext,over_18,link_flair_text";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP server", () => {
  it("lists every tool as read-only, each with format and max_chars", async () => {
    const { tools } = await rpc("tools/list");
    expect(tools.map((t: { name: string }) => t.name).toSorted()).toEqual([
      "get_subreddit_info",
      "get_thread",
      "get_time_series",
      "search_comments",
      "search_posts",
      "search_subreddits",
    ]);
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(Object.keys(tool.inputSchema.properties)).toEqual(expect.arrayContaining(["format", "max_chars"]));
    }
  });

  it("sends usage instructions on initialize", async () => {
    const result = await rpc("initialize", initializeParams);
    expect(result.instructions).toContain("start with get_thread");
  });

  it("searches posts with the markdown fields by default and renders markdown", async () => {
    const api = stubApi({ "/api/posts/search": [POST] });
    const { text } = await callTool("search_posts", { subreddit: "StarWarsBattlefront", title: "vader", limit: 2 });
    expect(text).toContain("- **Seriously? I paid 80$ to have Vader locked?** · `7cff0b` · r/StarWarsBattlefront");
    expect(api.requests()).toEqual([{ path: "/api/posts/search", params: { subreddit: "StarWarsBattlefront", title: "vader", limit: "2", fields: POST_FIELDS } }]);
  });

  it("returns raw records with format=json, only fetching requested fields", async () => {
    const api = stubApi({ "/api/posts/search": [POST] });
    const { text } = await callTool("search_posts", { author: "MBMMaverick", format: "json" });
    expect(JSON.parse(text)).toEqual([POST]);
    expect(api.requests()[0]?.params).toEqual({ author: "MBMMaverick" });
  });

  it("truncates output to max_chars", async () => {
    stubApi({ "/api/posts/search": Array.from({ length: 50 }, (_, i) => ({ ...POST, id: `p${i}` })) });
    const { text } = await callTool("search_posts", { subreddit: "x", max_chars: 1000 });
    expect(text).toHaveLength(1000);
    expect(text).toContain("output truncated at 1000 characters");
  });

  it("accepts URLs for comment search filters", async () => {
    const api = stubApi();
    await callTool("search_comments", { link_id: "https://www.reddit.com/r/x/comments/7cff0b/title/", parent_id: "dppum98" });
    expect(api.requests()[0]?.params).toMatchObject({ link_id: "t3_7cff0b", parent_id: "t1_dppum98" });
  });

  it("keeps an empty parent_id to select top-level comments", async () => {
    const api = stubApi();
    await callTool("search_comments", { link_id: "7cff0b", parent_id: "" });
    expect(api.requests()[0]?.params).toMatchObject({ link_id: "t3_7cff0b", parent_id: "" });
  });

  it.each([
    [
      "get_subreddit_info",
      { subreddit: "r/travel", wiki_pages: ["faq", "/wiki/visa/", "https://www.reddit.com/r/solotravel/wiki/index"] },
      "/api/subreddits/wikis",
      { paths: "/r/travel/wiki/faq,/r/travel/wiki/visa,/r/solotravel/wiki/index" },
    ],
  ])("routes %s to the matching endpoint", async (name, args, path, params) => {
    const api = stubApi();
    const { isError } = await callTool(name, args);
    expect(isError).toBe(false);
    expect(api.requests()).toEqual([{ path, params }]);
  });

  it("counts matches per group with group_by, without listing fields", async () => {
    const api = stubApi({ "/api/posts/search/aggregate": [{ key: "spez", count: "12" }] });
    const { text } = await callTool("search_posts", { subreddit: "announcements", group_by: "author", min_count: 2, limit: 500 });
    expect(text).toBe("1 row:\n\n- u/spez: 12");
    expect(api.requests()).toEqual([{ path: "/api/posts/search/aggregate", params: { subreddit: "announcements", aggregate: "author", min_count: "2", limit: "500" } }]);
  });

  it("groups comments by date bucket, resolving post URLs", async () => {
    const api = stubApi();
    await callTool("search_comments", { link_id: "https://redd.it/7cff0b", group_by: "created_utc", frequency: "day" });
    expect(api.requests()).toEqual([{ path: "/api/comments/search/aggregate", params: { link_id: "t3_7cff0b", aggregate: "created_utc", frequency: "day" } }]);
  });

  it.each([
    [{ subreddit: "x", frequency: "day", min_count: 2 }, "frequency and min_count only apply with group_by."],
    [{ subreddit: "x", group_by: "author", frequency: "day" }, "frequency only applies with group_by=created_utc."],
    [{ subreddit: "x", group_by: "created_utc", frequency: "day", after: "1y", min_count: 2 }, "min_count only applies with group_by=author or group_by=subreddit."],
    [{ subreddit: "x", limit: 500 }, "limit must be 1-100"],
    [{ subreddit: "x", group_by: "author", limit: "auto" }, 'limit "auto" does not apply with group_by'],
    [{ subreddit: "x", group_by: "created_utc" }, "group_by=created_utc needs frequency"],
  ])("rejects inconsistent search options %j before calling the API", async (args, message) => {
    const api = stubApi();
    const result = await callTool("search_posts", args);
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining(message) });
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("gets a subreddit's about, rules and wiki page list in one call", async () => {
    const api = stubApi({
      "/api/subreddits/search": [{ display_name: "travel", subscribers: 2 }],
      "/api/subreddits/rules": [{ subreddit: "travel", rules: [{ short_name: "Be kind" }] }],
      "/api/subreddits/wikis/list": ["/r/travel/wiki/faq"],
    });
    const { text } = await callTool("get_subreddit_info", { subreddit: "r/travel" });
    expect(text).toBe("# r/travel\n\n## About\n\n2 subscribers\n\n## Rules\n\n1. **Be kind**\n\n## Wiki\n\n1 page (read them with wiki_pages):\n\n- /r/travel/wiki/faq");
    expect(api.requests()).toEqual([
      { path: "/api/subreddits/search", params: { subreddit: "travel" } },
      { path: "/api/subreddits/rules", params: { subreddits: "travel" } },
      { path: "/api/subreddits/wikis/list", params: { subreddit: "travel" } },
    ]);
  });

  it("returns only the subreddit sections in include, as JSON keyed by section", async () => {
    const api = stubApi({ "/api/subreddits/rules": [{ subreddit: "travel", rules: [{ short_name: "Be kind" }] }] });
    const { text } = await callTool("get_subreddit_info", { subreddit: "travel", include: ["rules"], format: "json" });
    expect(JSON.parse(text)).toEqual({ rules: [{ short_name: "Be kind" }] });
    expect(api.requests().map((request) => request.path)).toEqual(["/api/subreddits/rules"]);
  });

  it("rejects wiki_pages when include leaves out the wiki", async () => {
    const api = stubApi();
    const result = await callTool("get_subreddit_info", { subreddit: "travel", include: ["rules"], wiki_pages: ["faq"] });
    expect(result).toEqual({ isError: true, text: "wiki_pages only applies with wiki in include." });
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("returns API failures as tool errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"error":"key is not a valid value"}', { status: 400 }));
    const result = await callTool("get_time_series", { key: "nope", precision: "year" });
    expect(result).toEqual({ isError: true, text: "Arctic Shift error (HTTP 400) for /api/time_series: key is not a valid value" });
  });

  it("returns unreadable IDs as tool errors without calling the API", async () => {
    const api = stubApi();
    const result = await callTool("search_comments", { link_id: "https://example.com/x" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("example.com is not a Reddit URL");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("accepts numbers and booleans sent as strings", async () => {
    const api = stubApi();
    const result = await callTool("search_posts", { subreddit: "espresso", query: "Profitec Go", limit: "25", max_chars: "15000", over_18: "false" });
    expect(result.isError).toBe(false);
    expect(api.requests()).toEqual([{ path: "/api/posts/search", params: expect.objectContaining({ limit: "25", over_18: "false" }) }]);
  });

  it("rejects out-of-range arguments before calling the API", async () => {
    const api = stubApi();
    const result = await callTool("search_posts", { limit: 0 });
    expect(result.isError).toBe(true);
    expect(api.fetch).not.toHaveBeenCalled();
  });
});

describe("get_thread", () => {
  it("reads a post URL as post plus comment tree", async () => {
    const api = stubApi({ "/api/posts/ids": [POST], "/api/comments/tree": TREE });
    const { text } = await callTool("get_thread", { url_or_id: "https://www.reddit.com/r/StarWarsBattlefront/comments/7cff0b/seriously/" });
    expect(text).toContain("# Seriously? I paid 80$ to have Vader locked?");
    expect(text).toContain("- **u/EACommunityTeam** · -667,000 points · 2019-12-31 13:44 UTC · `dppum98`: The intent is to provide players");
    expect(api.requests()).toEqual([
      { path: "/api/posts/ids", params: { ids: "t3_7cff0b", fields: POST_FIELDS } },
      { path: "/api/comments/tree", params: { link_id: "t3_7cff0b", limit: "100" } },
    ]);
  });

  it("focuses on the comment in a comment URL", async () => {
    const api = stubApi({ "/api/posts/ids": [POST], "/api/comments/tree": TREE });
    await callTool("get_thread", { url_or_id: "https://www.reddit.com/r/x/comments/7cff0b/seriously/dppum98/", comment_limit: 20 });
    expect(api.requests()[1]).toEqual({ path: "/api/comments/tree", params: { link_id: "t3_7cff0b", parent_id: "t1_dppum98", limit: "20" } });
  });

  it("looks up the post of a bare comment ID", async () => {
    const api = stubApi({ "/api/comments/ids": [{ link_id: "t3_7cff0b" }], "/api/posts/ids": [POST], "/api/comments/tree": TREE });
    await callTool("get_thread", { url_or_id: "t1_dppum98" });
    expect(api.requests().map((r) => r.path)).toEqual(["/api/comments/ids", "/api/posts/ids", "/api/comments/tree"]);
    expect(api.requests()[2]?.params).toMatchObject({ link_id: "t3_7cff0b", parent_id: "t1_dppum98" });
  });

  it("returns only the post with comment_limit 0", async () => {
    const api = stubApi({ "/api/posts/ids": [POST] });
    const { text } = await callTool("get_thread", { url_or_id: "7cff0b", comment_limit: 0 });
    expect(text).not.toContain("---");
    expect(api.requests().map((r) => r.path)).toEqual(["/api/posts/ids"]);
  });

  it("returns post and comments as JSON with format=json", async () => {
    stubApi({ "/api/posts/ids": [POST], "/api/comments/tree": TREE });
    const { text } = await callTool("get_thread", { url_or_id: "7cff0b", format: "json" });
    expect(JSON.parse(text)).toEqual({ post: POST, comments: TREE });
  });

  it("reports posts missing from the archive", async () => {
    stubApi();
    const result = await callTool("get_thread", { url_or_id: "zzzzzz" });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining("Post t3_zzzzzz is not in the Arctic Shift archive") });
  });
});
