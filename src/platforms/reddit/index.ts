import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Params } from "../../core/client.ts";
import { flag, numeric } from "../../core/input.ts";
import { asList, type Thing } from "../../core/markdown.ts";
import { DEFAULT_MAX_CHARS, fieldsFor, limitChars, type Output, outputSettings, type Render, renderJson, respond } from "../../core/output.ts";
import type { Platform } from "../../core/platform.ts";
import { apiParams, fetchAndRender, InputError, onlyWith, readOnly, toolResult } from "../../core/tool.ts";
import { BASE_URL, callApi } from "./api.ts";
import {
  FRESHNESS,
  renderComments,
  renderCounts,
  renderPosts,
  renderSubredditInfo,
  renderSubreddits,
  renderThread,
  renderTimeSeries,
  SUBREDDIT_SECTIONS,
  type SubredditInfo,
  type SubredditSection,
} from "./render.ts";
import { resolveId, resolveTarget } from "./targets.ts";

// Fields the markdown renderers use; requested by default so responses stay small and fast.
const POST_FIELDS = ["id", "title", "author", "subreddit", "score", "num_comments", "created_utc", "url", "selftext", "over_18", "link_flair_text"];
const COMMENT_FIELDS = ["id", "author", "subreddit", "score", "created_utc", "body", "link_id", "parent_id"];
const SUBREDDIT_FIELDS = ["id", "display_name", "subscribers", "created_utc", "over18", "public_description"];

const date = z.string().describe("Epoch seconds/ms, ISO 8601 (e.g. 2020-01-01), or offset from now (e.g. 1year, 3m, 2d, 1hour)");
const postRef = z.string().describe("Post ID (abc123, t3_abc123) or Reddit URL");
const commentRef = z.string().describe("Comment ID (abc123, t1_abc123) or Reddit comment URL");
const fields = z.array(z.string()).optional().describe("Only fetch these fields. Markdown output requests the fields it shows by default; set this mainly with format=json.");

const output = outputSettings;

// Searches of several subreddits run one per subreddit; Arctic Shift has no multi-subreddit filter.
const MAX_SUBREDDITS = 5;
// Arctic Shift throttles bursts of heavy queries, so a fan-out runs this many searches at a time.
const FAN_OUT_CONCURRENCY = 2;
// rank_by ranks Arctic Shift's largest listing page per subreddit; "auto" is not allowed with keyword search.
const RANK_WINDOW = 100;
const RANK_FIELDS = { comments: "num_comments", score: "score" } as const;

// Filters shared by post and comment search.
const commonFilters = {
  author: z.string().optional().describe("Username (u/ prefix optional)"),
  subreddit: z
    .union([z.string(), z.array(z.string()).min(1).max(MAX_SUBREDDITS)])
    .optional()
    .describe(`Subreddit name (r/ prefix optional), or up to ${MAX_SUBREDDITS} names to search each and merge the listings`),
  author_flair_text: z.string().optional().describe("Keyword search on author flair"),
  after: date.optional().describe("Only things created after this date"),
  before: date.optional().describe("Only things created before this date"),
};

const postFilters = {
  ...commonFilters,
  crosspost_parent_id: postRef.optional().describe("Only crossposts of this post (ID or URL)"),
  over_18: flag().optional(),
  spoiler: flag().optional(),
  title: z.string().optional().describe("Keyword search in title. Requires author or subreddit."),
  selftext: z.string().optional().describe("Keyword search in body text. Requires author or subreddit."),
  link_flair_text: z.string().optional().describe("Keyword search on post flair"),
  query: z.string().optional().describe("Keyword search in title and selftext. Requires author or subreddit."),
  url: z.string().optional().describe("Prefix match on the linked URL"),
  url_exact: flag().optional().describe("Only exact matches for url"),
  rank_by: z
    .enum(["comments", "score"])
    .optional()
    .describe(`Listing: most comments or highest score first, among the ${RANK_WINDOW} newest matches per subreddit (oldest with sort=asc)`),
};

const commentFilters = {
  ...commonFilters,
  body: z.string().optional().describe("Full-text search in comment body (websearch syntax). Requires author, subreddit, link_id or parent_id."),
  link_id: postRef.optional().describe("Only comments under this post (ID or URL)"),
  parent_id: z.string().optional().describe("Only direct replies to this comment (ID or URL); empty string for top-level comments only"),
};

const searchOptionsSchema = z.object({
  group_by: z
    .enum(["created_utc", "author", "subreddit"])
    .optional()
    .describe("Count matches per date bucket, author or subreddit instead of listing them. Very active users or subreddits may time out."),
  frequency: z.string().optional().describe("Bucket size, required with group_by=created_utc (year, month, week, day, hour); that grouping also needs after or before"),
  min_count: numeric(z.number().int().min(0)).optional().describe("With group_by=author/subreddit: skip groups with fewer matches"),
  limit: z
    .union([numeric(z.number().int().min(1)), z.literal("auto")])
    .optional()
    .describe('Listing: 1-100 (default 25), or "auto" for 100-1000 depending on server load. With group_by: max groups (default all).'),
  sort: z.enum(["asc", "desc"]).optional().describe("Listing: by creation date (search_posts can rank_by instead). With group_by: by count, or by date for created_utc."),
  fields,
  ...output,
});
type SearchOptions = z.infer<typeof searchOptionsSchema> & { rank_by?: keyof typeof RANK_FIELDS };
const searchOptions = searchOptionsSchema.shape;

/** Handler for a tool that forwards its arguments to one Arctic Shift endpoint. */
const forward = (path: string, render: Render) => (args: Output & Params) => toolResult(() => fetchAndRender(callApi, path, args, render));

async function resolvePostFilters<T extends { crosspost_parent_id?: string }>(filters: T): Promise<T> {
  return { ...filters, crosspost_parent_id: filters.crosspost_parent_id ? await resolveId(filters.crosspost_parent_id, "t3") : undefined };
}

async function resolveCommentFilters<T extends { link_id?: string; parent_id?: string }>(filters: T): Promise<T> {
  return {
    ...filters,
    link_id: filters.link_id ? await resolveId(filters.link_id, "t3") : undefined,
    // An empty parent_id is meaningful: top-level comments only.
    parent_id: filters.parent_id ? await resolveId(filters.parent_id, "t1") : filters.parent_id,
  };
}

/**
 * Runs `search` for each subreddit, FAN_OUT_CONCURRENCY at a time. A subreddit that fails becomes a note and the
 * others' results are kept; when every search fails, the first error is thrown.
 */
async function eachSubreddit(subreddits: (string | undefined)[], search: (subreddit?: string) => Promise<unknown>): Promise<{ results: unknown[]; notes: string[] }> {
  // Searches share FAN_OUT_CONCURRENCY lanes; each lane starts its next search when its last one settles.
  const lanes: Promise<unknown>[] = Array.from({ length: FAN_OUT_CONCURRENCY }, () => Promise.resolve());
  const runs = subreddits.map((name, i) => {
    const run = lanes[i % FAN_OUT_CONCURRENCY]!.then(() => search(name));
    lanes[i % FAN_OUT_CONCURRENCY] = run.catch(() => undefined);
    return run;
  });
  const settled = await Promise.allSettled(runs);
  const failures = settled.flatMap((result, i) => (result.status === "rejected" ? [{ subreddit: subreddits[i], error: result.reason as unknown }] : []));
  if (failures.length === settled.length) throw failures[0]?.error;
  return {
    results: settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    notes: failures.map(({ subreddit, error }) => `_r/${subreddit} is left out: ${error instanceof Error ? error.message : String(error)}_`),
  };
}

const byDate = (sort: unknown) => (a: Thing, b: Thing) => (sort === "asc" ? 1 : -1) * (Number(a.created_utc) - Number(b.created_utc));

/** Lists matches from `<path>`, or counts them per group via `<path>/aggregate` when group_by is set. */
async function searchOrCount(path: string, options: SearchOptions & { subreddit?: string | string[] } & Params, defaults: string[], render: Render): Promise<string> {
  const { fields: requested, group_by, frequency, min_count, rank_by, subreddit, ...rest } = options;
  const filters = apiParams(rest);
  const subreddits = Array.isArray(subreddit) ? [...new Set(subreddit)] : [subreddit];
  if (!group_by) {
    onlyWith({ frequency, min_count }, ["frequency", "min_count"], false, "group_by");
    if (typeof filters.limit === "number" && filters.limit > 100) {
      throw new InputError('limit must be 1-100 (or "auto") when listing results; larger limits only apply with group_by.');
    }
    if (rank_by && filters.limit === "auto") throw new InputError(`limit "auto" does not apply with rank_by, which ranks the ${RANK_WINDOW} newest matches.`);
    // Arctic Shift lists 25 by default; merging subreddits and ranking trim to the same.
    const limit = options.limit ?? 25;
    // Merging by date and ranking need their fields even when the caller narrowed fields.
    const fetched = fieldsFor(options.format, requested, defaults);
    const needed = [...(subreddits.length > 1 ? ["created_utc"] : []), ...(rank_by ? [RANK_FIELDS[rank_by]] : [])];
    const { results, notes } = await eachSubreddit(subreddits, (name) =>
      callApi(path, { ...filters, subreddit: name, limit: rank_by ? RANK_WINDOW : options.limit, fields: fetched && [...new Set([...fetched, ...needed])] }),
    );
    let rows = results.flatMap(asList);
    if (subreddits.length > 1) rows.sort(byDate(filters.sort));
    if (rank_by && rows.length > 0) {
      const key = RANK_FIELDS[rank_by];
      // A stable sort, so ties keep their date order.
      rows.sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0));
      const windowFull = results.some((result) => asList(result).length === RANK_WINDOW);
      const scope = windowFull
        ? `the ${RANK_WINDOW} ${filters.sort === "asc" ? "oldest" : "newest"} matches${subreddits.length > 1 ? " in each subreddit" : ""}; narrow after/before to rank another period`
        : `all ${rows.length} matches`;
      notes.push(`_Ranked by ${rank_by} among ${scope}._`);
    }
    if (limit !== "auto") rows = rows.slice(0, limit);
    return respond(rows, options, (data) => [...notes, render(data)].join("\n\n"));
  }
  onlyWith({ rank_by }, ["rank_by"], false, "a listing, without group_by");
  if (subreddits.length > 1) throw new InputError("Several subreddits only apply when listing; with group_by, count one subreddit per call.");
  onlyWith({ frequency }, ["frequency"], group_by === "created_utc", "group_by=created_utc");
  onlyWith({ min_count }, ["min_count"], group_by !== "created_utc", "group_by=author or group_by=subreddit");
  if (filters.limit === "auto") throw new InputError('limit "auto" does not apply with group_by; omit limit to get all groups.');
  if (group_by === "created_utc" && !frequency) throw new InputError("group_by=created_utc needs frequency (e.g. year, month, day).");
  const data = await callApi(`${path}/aggregate`, { ...filters, subreddit: subreddits[0], aggregate: group_by, frequency, min_count });
  return respond(data, options, (rows) => renderCounts(rows, { group: group_by, frequency }));
}

/** A wiki page as Arctic Shift names it, /r/<subreddit>/wiki/<page>, from a page name, path or URL. */
function wikiPath(subreddit: string, page: string): string {
  const path = /\/r\/[^/]+\/wiki\/[^?#]+/i.exec(page)?.[0] ?? `/r/${subreddit}/wiki/${page.replace(/^\/*(?:wiki\/)?/i, "")}`;
  return path.replace(/\/+$/, "");
}

function registerTools(server: McpServer): void {
  server.registerTool(
    "get_thread",
    {
      title: "Read a Reddit thread",
      description:
        "Read a Reddit post and its comment tree from a Reddit URL, share link, redd.it link, or post/comment ID. " +
        "A comment URL or ID focuses on that comment's subtree. Collapsed branches show as [+N more] with how to expand them.",
      inputSchema: z.object({
        url_or_id: z.string().describe("Reddit post or comment URL, share link (/r/<sub>/s/<code>), redd.it link, or ID (bare = post, t3_ = post, t1_ = comment)"),
        comment_limit: numeric(z.number().int().min(0).max(25000)).optional().describe("Max comments to fetch (default 100). 0 returns the post only."),
        parent_id: commentRef.optional().describe("Only return the subtree of this comment (ID or URL)"),
        sort: z.enum(["tree", "top"]).optional().describe("tree (default): Reddit's order. top: highest score first at each level."),
        start_depth: numeric(z.number().int().min(0)).optional().describe("Reply levels to expand before collapsing (default 4)"),
        start_breadth: numeric(z.number().int().min(0)).optional().describe("Replies per level to expand before collapsing (default 4)"),
        ...output,
      }),
      annotations: readOnly,
    },
    ({ url_or_id, comment_limit = 100, parent_id, sort = "tree", start_depth, start_breadth, format, max_chars = DEFAULT_MAX_CHARS }) =>
      toolResult(async () => {
        const target = await resolveTarget(url_or_id, "t3");
        let postId = target.postId;
        if (!postId) {
          const [comment] = (await callApi<{ link_id?: string }[] | null>("/api/comments/ids", { ids: target.commentId, fields: "link_id" })) ?? [];
          if (!comment?.link_id) throw new InputError(`Comment ${target.commentId} is not in the Arctic Shift archive.`);
          postId = comment.link_id;
        }
        const focus = parent_id ? await resolveId(parent_id, "t1") : target.commentId;

        const [posts, tree] = await Promise.all([
          callApi<Record<string, unknown>[] | null>("/api/posts/ids", { ids: postId, fields: fieldsFor(format, undefined, POST_FIELDS) }),
          comment_limit > 0 ? callApi("/api/comments/tree", { link_id: postId, parent_id: focus, limit: comment_limit, start_depth, start_breadth }) : [],
        ]);
        const post = posts?.[0];
        if (!post) {
          throw new InputError(`Post ${postId} is not in the Arctic Shift archive. Very new posts take a few minutes to appear; deleted posts may never appear.`);
        }

        if (format === "json") return renderJson({ post, comments: tree }, max_chars);
        return limitChars(renderThread(post, tree, { sort, includeComments: comment_limit > 0 }), max_chars);
      }),
  );

  server.registerTool(
    "search_posts",
    {
      title: "Search Reddit posts",
      description:
        "Search archived Reddit posts by author, subreddit, date range, keywords, flair or linked URL, sorted by date. " +
        "Keyword filters (title/selftext/query) need author or subreddit set. " +
        "For reviews or opinions, search the likely subreddits together and set rank_by=comments to find the most discussed threads, then read them with get_thread. " +
        "Set group_by to count matches per author, subreddit or date bucket instead (e.g. top posters in a subreddit, a user's posts per year).",
      inputSchema: z.object({ ...postFilters, ...searchOptions }),
      annotations: readOnly,
    },
    (args) => toolResult(async () => searchOrCount("/api/posts/search", await resolvePostFilters(args), POST_FIELDS, renderPosts)),
  );

  server.registerTool(
    "search_comments",
    {
      title: "Search Reddit comments",
      description:
        "Search archived Reddit comments by author, subreddit, post (link_id), parent comment, date range or body text, sorted by date. " +
        "With only author set this is the user's comment history. body search needs author, subreddit, link_id or parent_id. " +
        "Set group_by to count matches per author, subreddit or date bucket instead (e.g. most active commenters on a post, a user's comments per month). " +
        "To read a whole discussion use get_thread.",
      inputSchema: z.object({ ...commentFilters, ...searchOptions }),
      annotations: readOnly,
    },
    (args) => toolResult(async () => searchOrCount("/api/comments/search", await resolveCommentFilters(args), COMMENT_FIELDS, renderComments)),
  );

  server.registerTool(
    "search_subreddits",
    {
      title: "Search subreddits",
      description: "Find subreddits by name, name prefix, creation date, subscriber count or NSFW flag. Subreddit data is refreshed infrequently.",
      inputSchema: z.object({
        subreddit: z.string().optional(),
        subreddit_prefix: z.string().optional(),
        after: date.optional().describe("Subreddit created after"),
        before: date.optional().describe("Subreddit created before"),
        min_subscribers: numeric(z.number().int()).optional(),
        max_subscribers: numeric(z.number().int()).optional(),
        over18: flag().optional(),
        limit: numeric(z.number().int().min(1).max(1000)).optional().describe("Default 25"),
        sort: z.enum(["asc", "desc"]).optional().describe("Default desc"),
        sort_type: z.enum(["created_utc", "subscribers", "subreddit"]).optional().describe("Default subscribers"),
        fields,
        ...output,
      }),
      annotations: readOnly,
    },
    ({ fields: requested, ...args }) =>
      toolResult(() => fetchAndRender(callApi, "/api/subreddits/search", { ...args, fields: fieldsFor(args.format, requested, SUBREDDIT_FIELDS) }, renderSubreddits)),
  );

  server.registerTool(
    "get_subreddit_info",
    {
      title: "Get subreddit info",
      description:
        "Get a subreddit's description and stats (about), its rules and its wiki, in one call; include picks the sections. " +
        "The wiki section lists the wiki pages; set wiki_pages to read pages instead, by name (faq, guides/glossary), path or URL.",
      inputSchema: z.object({
        subreddit: z.string().describe("Subreddit name (r/ prefix optional)"),
        include: z.array(z.enum(SUBREDDIT_SECTIONS)).min(1).optional().describe("Sections to return. Default: all, or only wiki when wiki_pages is set."),
        wiki_pages: z.array(z.string()).min(1).max(100).optional().describe("Wiki pages to read, e.g. faq or /r/travel/wiki/faq"),
        ...output,
      }),
      annotations: readOnly,
    },
    ({ subreddit, include, wiki_pages, ...settings }) =>
      toolResult(async () => {
        onlyWith({ wiki_pages }, ["wiki_pages"], !include || include.includes("wiki"), "wiki in include");
        // The rules and wiki endpoints return nothing for a name with an r/ prefix.
        const name = subreddit.replace(/^\/?r\//i, "");
        const paths = wiki_pages?.map((page) => wikiPath(name, page));
        const fetchSection: Record<SubredditSection, () => Promise<unknown>> = {
          about: async () => asList(await callApi("/api/subreddits/search", { subreddit: name }))[0] ?? null,
          rules: async () => asList(await callApi("/api/subreddits/rules", { subreddits: name }))[0]?.rules ?? [],
          wiki: () => (paths ? callApi("/api/subreddits/wikis", { paths }) : callApi("/api/subreddits/wikis/list", { subreddit: name })),
        };
        const sections = new Set(include ?? (paths ? ["wiki" as const] : SUBREDDIT_SECTIONS));
        const data: SubredditInfo = Object.fromEntries(await Promise.all([...sections].map(async (section) => [section, await fetchSection[section]()])));
        return respond(data, settings, () => renderSubredditInfo(name, data, paths));
      }),
  );

  server.registerTool(
    "get_time_series",
    {
      title: "Get time series",
      description:
        "Activity over time. Keys: global/posts/count, global/comments/count, global/{posts,comments}/sum_score, " +
        "r/<subreddit>/posts/count, r/<subreddit>/comments/count, r/<subreddit>/{posts,comments}/sum_score, r/<subreddit>/subscribers.",
      inputSchema: z.object({
        key: z.string().describe("e.g. r/askreddit/subscribers"),
        precision: z.enum(["year", "quarter", "month", "week", "day", "hour", "minute"]),
        after: date.optional(),
        before: date.optional(),
        ...output,
      }),
      annotations: readOnly,
    },
    forward("/api/time_series", renderTimeSeries),
  );
}

export const reddit: Platform = {
  id: "reddit",
  name: "arctic-shift",
  version: "1.0.0",
  description: `Query archived Reddit posts, comments and subreddits via the Arctic Shift API (${BASE_URL}).`,
  instructions:
    "Read-only access to the Arctic Shift archive of Reddit. For any Reddit link, start with get_thread. " +
    "Results are compact markdown by default; pass format=json for raw records. " +
    "For most active authors or subreddits, set group_by on search_posts/search_comments. " +
    FRESHNESS,
  registerTools,
};
