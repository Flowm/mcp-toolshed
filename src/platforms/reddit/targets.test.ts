import { afterEach, describe, expect, it, vi } from "vitest";

import { InputError } from "../../core/tool.ts";
import { resolveId, resolveIds, resolveTarget } from "./targets.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const stubShortLinks = (links: { original_path: string; resolved_path: string }[]) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: links })));

describe("resolveTarget", () => {
  it.each([
    ["ei30r4", { postId: "t3_ei30r4" }],
    ["T3_EI30R4", { postId: "t3_ei30r4" }],
    ["t1_dppum98", { commentId: "t1_dppum98" }],
    ["https://www.reddit.com/r/worldnews/comments/ei30r4/chinese_officials/", { postId: "t3_ei30r4" }],
    ["https://old.reddit.com/r/worldnews/comments/ei30r4/", { postId: "t3_ei30r4" }],
    ["www.reddit.com/r/worldnews/comments/ei30r4/title/?utm_source=share#top", { postId: "t3_ei30r4" }],
    ["https://www.reddit.com/r/x/comments/7cff0b/title/dppum98/", { postId: "t3_7cff0b", commentId: "t1_dppum98" }],
    ["https://www.reddit.com/comments/7cff0b", { postId: "t3_7cff0b" }],
    ["/r/x/comments/7cff0b/_/dppum98", { postId: "t3_7cff0b", commentId: "t1_dppum98" }],
    ["https://redd.it/ei30r4", { postId: "t3_ei30r4" }],
  ])("parses %s", async (input, expected) => {
    await expect(resolveTarget(input, "t3")).resolves.toEqual(expected);
  });

  it("reads a bare ID as the requested kind", async () => {
    await expect(resolveTarget("dppum98", "t1")).resolves.toEqual({ commentId: "t1_dppum98" });
  });

  it.each(["https://example.com/r/x/comments/abc/", "https://www.reddit.com/r/worldnews/", "not an id!", ""])("rejects %j", async (input) => {
    await expect(resolveTarget(input, "t3")).rejects.toThrow(InputError);
  });

  it("resolves share links through Arctic Shift", async () => {
    const fetch = stubShortLinks([{ original_path: "/r/running/s/3TzXiyxaMD", resolved_path: "/r/running/comments/17snc7d/achievements/k8so54m?share_id=x" }]);
    await expect(resolveTarget("https://www.reddit.com/r/running/s/3TzXiyxaMD", "t3")).resolves.toEqual({ postId: "t3_17snc7d", commentId: "t1_k8so54m" });
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/short_links");
    expect(url.searchParams.get("paths")).toBe("/r/running/s/3TzXiyxaMD");
  });

  it("explains share links Arctic Shift has not archived", async () => {
    stubShortLinks([]);
    await expect(resolveTarget("/r/running/s/unknown1", "t3")).rejects.toThrow("has not archived the share link /r/running/s/unknown1");
  });
});

describe("resolveIds", () => {
  it("normalizes IDs and URLs, resolving all share links in one request", async () => {
    const fetch = stubShortLinks([
      { original_path: "/r/a/s/one", resolved_path: "/r/a/comments/p1/t/" },
      { original_path: "/u/b/s/two", resolved_path: "/r/b/comments/p2/t/c2/" },
    ]);
    await expect(resolveIds(["abc", "t3_def", "/r/a/s/one", "https://reddit.com/u/b/s/two", "https://www.reddit.com/r/x/comments/ghi/t/c1/"], "t3")).resolves.toEqual([
      "t3_abc",
      "t3_def",
      "t3_p1",
      "t3_p2",
      "t3_ghi",
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects references of the wrong kind", async () => {
    await expect(resolveId("t1_abc", "t3")).rejects.toThrow('"t1_abc" does not identify a post');
    await expect(resolveId("https://www.reddit.com/r/x/comments/abc/", "t1")).rejects.toThrow("does not identify a comment");
  });
});
