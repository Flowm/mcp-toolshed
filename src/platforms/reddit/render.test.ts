import { describe, expect, it } from "vitest";

import { FRESHNESS_NOTE, renderComments, renderCounts, renderPosts, renderSubredditInfo, renderSubreddits, renderThread, renderTimeSeries } from "./render.ts";

const OLD = 1577799850; // 2019-12-31 13:44 UTC
const fresh = () => Math.floor(Date.now() / 1000) - 3600;

const post = {
  id: "ei30r4",
  title: "Chinese officials investigate pneumonia outbreak in Wuhan",
  author: "cc_hk",
  subreddit: "worldnews",
  score: 5,
  num_comments: 2,
  created_utc: OLD,
  url: "https://www.reuters.com/article/x",
  selftext: "",
  over_18: false,
  link_flair_text: null,
};

const comment = (id: string, score: number, body: string, replies: unknown[] = []) => ({
  kind: "t1",
  data: { id, author: `user_${id}`, score, body, created_utc: OLD, replies: replies.length ? { kind: "Listing", data: { children: replies } } : "" },
});
const more = (count: number, parent: string) => ({ kind: "more", data: { count, parent_id: parent, children: ["a", "b"] } });

describe("renderPosts", () => {
  it("shows the key fields, permalink and outbound link", () => {
    expect(renderPosts([post])).toBe(
      [
        "1 post:",
        "",
        "- **Chinese officials investigate pneumonia outbreak in Wuhan** · `ei30r4` · r/worldnews · u/cc_hk · 5 points · 2 comments · 2019-12-31 13:44 UTC",
        "  https://www.reddit.com/r/worldnews/comments/ei30r4/",
        "  Link: https://www.reuters.com/article/x",
      ].join("\n"),
    );
  });

  it("previews the first line of selftext and hides reddit self links", () => {
    const self = { ...post, url: "https://www.reddit.com/r/worldnews/comments/ei30r4/x/", selftext: "First line\nSecond line" };
    const text = renderPosts([self]);
    expect(text).toContain("\n  First line");
    expect(text).not.toContain("Second line");
    expect(text).not.toContain("Link:");
  });

  it("skips fields that were not requested", () => {
    expect(renderPosts([{ id: "abc", title: "T" }])).toBe("1 post:\n\n- **T** · `abc`");
  });

  it("adds the freshness note only when something is under 36h old", () => {
    expect(renderPosts([post])).not.toContain(FRESHNESS_NOTE);
    expect(renderPosts([post, { ...post, created_utc: fresh() }])).toContain(FRESHNESS_NOTE);
  });

  it("handles empty results", () => {
    expect(renderPosts([])).toBe("No posts matched.");
    expect(renderPosts(null)).toBe("No posts matched.");
  });
});

describe("renderComments", () => {
  it("shows the post, the parent for replies, a permalink and the indented body", () => {
    const text = renderComments([{ id: "c2", author: "bob", subreddit: "pics", score: 3, created_utc: OLD, body: "line 1\nline 2", link_id: "t3_p1", parent_id: "t1_c1" }]);
    expect(text).toBe(
      [
        "1 comment:",
        "",
        "- **u/bob** · r/pics · 3 points · 2019-12-31 13:44 UTC · `c2` · on post `p1` · reply to `c1`",
        "  https://www.reddit.com/r/pics/comments/p1/_/c2/",
        "  line 1",
        "  line 2",
      ].join("\n"),
    );
  });

  it("uses singular counts and keeps blank lines in bodies empty", () => {
    const text = renderComments([{ id: "c", author: "a", score: 1, body: "para 1\n\npara 2", link_id: "t3_p", parent_id: "t3_p" }]);
    expect(text).toContain("· 1 point ·");
    expect(text).toContain("  para 1\n\n  para 2");
  });

  it("renders deleted authors and clips long bodies", () => {
    const text = renderComments([{ id: "c", author: "[deleted]", body: "x".repeat(2000), link_id: "t3_p", parent_id: "t3_p" }]);
    expect(text).toContain("**u/[deleted]**");
    expect(text).not.toContain("reply to");
    expect(text).toContain(`${"x".repeat(1500)} … [truncated]`);
  });
});

describe("renderThread", () => {
  const tree = [comment("low", 1, "meh", [comment("child", 7, "reply\nmore", [more(8, "t1_child")])]), comment("high", 50, "best"), more(300, "t3_ei30r4")];

  it("renders the post header and an indented comment tree with expansion hints", () => {
    expect(renderThread(post, tree)).toBe(
      [
        "# Chinese officials investigate pneumonia outbreak in Wuhan",
        "",
        "`ei30r4` · r/worldnews · u/cc_hk · 5 points · 2 comments · 2019-12-31 13:44 UTC",
        "https://www.reddit.com/r/worldnews/comments/ei30r4/",
        "Link: https://www.reuters.com/article/x",
        "",
        "---",
        "",
        "- **u/user_low** · 1 point · 2019-12-31 13:44 UTC · `low`: meh",
        "  - **u/user_child** · 7 points · 2019-12-31 13:44 UTC · `child`: reply",
        "    more",
        "    - _[+8 more: get_thread with parent_id child]_",
        "- **u/user_high** · 50 points · 2019-12-31 13:44 UTC · `high`: best",
        "- _[+300 more: raise comment_limit]_",
      ].join("\n"),
    );
  });

  it("orders siblings by score with sort=top, keeping collapsed stubs last", () => {
    const lines = renderThread(post, tree, { sort: "top" }).split("\n");
    const firstComment = lines.findIndex((line) => line.startsWith("- "));
    expect(lines.slice(firstComment).filter((line) => line.startsWith("- "))).toEqual([
      "- **u/user_high** · 50 points · 2019-12-31 13:44 UTC · `high`: best",
      "- **u/user_low** · 1 point · 2019-12-31 13:44 UTC · `low`: meh",
      "- _[+300 more: raise comment_limit]_",
    ]);
  });

  it("omits the comment section when comments were not requested", () => {
    expect(renderThread(post, [], { includeComments: false })).not.toContain("---");
    expect(renderThread(post, [])).toContain("_No comments._");
  });

  it("adds the freshness note for a fresh post or comment", () => {
    expect(renderThread(post, tree)).not.toContain(FRESHNESS_NOTE);
    expect(renderThread({ ...post, created_utc: fresh() }, [])).toContain(FRESHNESS_NOTE);
    const freshComment = { kind: "t1", data: { id: "f", author: "a", score: 1, body: "b", created_utc: fresh() } };
    expect(renderThread(post, [freshComment])).toContain(FRESHNESS_NOTE);
  });
});

describe("other renderers", () => {
  it("renders subreddits", () => {
    const text = renderSubreddits([{ id: "2qh1i", display_name: "AskReddit", subscribers: 51551345, created_utc: 1201233135, over18: false, public_description: "Ask.\nMore" }]);
    expect(text).toBe("1 subreddit:\n\n- **r/AskReddit** · 51,551,345 subscribers · created 2008-01-25 · `2qh1i`\n  Ask.");
  });

  // Arctic Shift starts buckets at midnight in its own time zone (UTC+1 here), so they arrive an hour early in UTC.
  it.each([
    ["year", "2005-12-31T23:00:00.000Z", "2006"],
    ["quarter", "2006-03-31T22:00:00.000Z", "2006-Q2"],
    ["month", "2006-01-31T23:00:00.000Z", "2006-02"],
    ["1 week", "2023-12-31T23:00:00.000Z", "week of 2024-01-01"],
    ["day", "2024-03-09T23:00:00.000Z", "2024-03-10"],
    ["hour", "2024-03-10T13:00:00.000Z", "2024-03-10 13:00 UTC"],
  ])("labels %s buckets by the server-local date", (frequency, start, label) => {
    expect(renderCounts([{ created_utc: start, count: "1" }], { group: "created_utc", frequency })).toBe(`1 row:\n\n- ${label}: 1`);
  });

  it("shows a missing count as ?", () => {
    expect(renderCounts([{ key: "a" }, { key: "b", count: "n/a" }], { group: "author" })).toBe("2 rows:\n\n- u/a: ?\n- u/b: ?");
  });

  it("labels search aggregate keys by the grouping", () => {
    expect(renderCounts([{ key: "Goldeagle1123", count: "20" }], { group: "author" })).toBe("1 row:\n\n- u/Goldeagle1123: 20");
    expect(renderCounts([{ key: "pics", count: "3" }], { group: "subreddit" })).toBe("1 row:\n\n- r/pics: 3");
  });

  it("renders time series with dates and rounded values", () => {
    expect(
      renderTimeSeries([
        { date: 1514764800, value: 20050347 },
        { date: 1546300800, value: 23146686.441860463 },
      ]),
    ).toBe("2 data points:\n\n- 2018-01-01: 20,050,347\n- 2019-01-01: 23,146,686.44");
  });

  it("renders the subreddit info sections that were fetched", () => {
    const about = {
      title: "Ask anything",
      subscribers: 51551345,
      created_utc: 1201233135,
      subreddit_type: "public",
      retrieved_on: 1739565078,
      description: "Ask.\r\nMore",
      _meta: { num_posts: 2000, num_comments: 1 },
    };
    const rules = [{ short_name: "Rule 1", kind: "link", description: "Be clear\n* really" }];
    expect(renderSubredditInfo("AskReddit", { about, rules, wiki: ["/r/askreddit/wiki/faq"] })).toBe(
      "# r/AskReddit\n\n" +
        "## About\n\n_Ask anything_\n\n51,551,345 subscribers · created 2008-01-25 · 2,000 posts archived · 1 comment archived · details as of 2025-02-14\n\nAsk.\nMore\n\n" +
        "## Rules\n\n1. **Rule 1** (applies to: link)\n   Be clear\n   * really\n\n" +
        "## Wiki\n\n1 page (read them with wiki_pages):\n\n- /r/askreddit/wiki/faq",
    );
    expect(renderSubredditInfo("nope", { about: null, rules: [], wiki: [] })).toBe(
      "# r/nope\n\n## About\n\n_Not in the archive. Check the name, or find it with search_subreddits._\n\n## Rules\n\n_No rules found._\n\n## Wiki\n\n_No wiki pages found._",
    );
  });

  it("renders wiki pages read, noting missing ones first", () => {
    const pages = [{ path: "/r/travel/wiki/faq", content: "Hello\r\nWorld" }];
    expect(renderSubredditInfo("travel", { wiki: pages }, ["/r/Travel/wiki/FAQ", "/r/travel/wiki/nope"])).toBe(
      "# r/travel\n\n_Not found: /r/travel/wiki/nope_\n\n## /r/travel/wiki/faq\n\nHello\nWorld",
    );
  });
});
