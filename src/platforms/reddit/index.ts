import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Params } from "../../core/client.ts";
import { flag, numeric } from "../../core/input.ts";
import { DEFAULT_MAX_CHARS, fieldsFor, limitChars, type Output, outputSettings, type Render, renderJson, respond } from "../../core/output.ts";
import type { Platform } from "../../core/platform.ts";
import { apiParams, fetchAndRender, InputError, onlyWith, readOnly, toolResult } from "../../core/tool.ts";
import { BASE_URL, callApi } from "./api.ts";
import {
  FRESHNESS,
  renderComments,
  renderCounts,
  renderInteractionList,
  renderPosts,
  renderRules,
  renderSubreddits,
  renderThread,
  renderTimeSeries,
  renderUsers,
  renderWikiPaths,
  renderWikis,
} from "./render.ts";
import { type Kind, resolveId, resolveIds, resolveTarget } from "./targets.ts";

// Fields the markdown renderers use; requested by default so responses stay small and fast.
const POST_FIELDS = ["id", "title", "author", "subreddit", "score", "num_comments", "created_utc", "url", "selftext", "over_18", "link_flair_text"];
const COMMENT_FIELDS = ["id", "author", "subreddit", "score", "created_utc", "body", "link_id", "parent_id"];
const SUBREDDIT_FIELDS = ["id", "display_name", "subscribers", "created_utc", "over18", "public_description"];

const date = z.string().describe("Epoch seconds/ms, ISO 8601 (e.g. 2020-01-01), or offset from now (e.g. 1year, 3m, 2d, 1hour)");
const postRef = z.string().describe("Post ID (abc123, t3_abc123) or Reddit URL");
const commentRef = z.string().describe("Comment ID (abc123, t1_abc123) or Reddit comment URL");
const fields = z.array(z.string()).optional().describe("Only fetch these fields. Markdown output requests the fields it shows by default; set this mainly with format=json.");

const output = outputSettings;

// Filters shared by post and comment search.
const commonFilters = {
  author: z.string().optional().describe("Username (u/ prefix optional)"),
  subreddit: z.string().optional().describe("Subreddit name (r/ prefix optional)"),
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
  sort: z.enum(["asc", "desc"]).optional().describe("Listing: by creation date, the only order the API supports. With group_by: by count, or by date for created_utc."),
  fields,
  ...output,
});
type SearchOptions = z.infer<typeof searchOptionsSchema>;
const searchOptions = searchOptionsSchema.shape;

// get_by_ids: the ID kind each lookup resolves URLs to (subreddit IDs are plain), its default fields and renderer.
const ID_LOOKUPS: Record<"posts" | "comments" | "subreddits", { kind?: Kind; defaults: string[]; render: Render }> = {
  posts: { kind: "t3", defaults: POST_FIELDS, render: renderPosts },
  comments: { kind: "t1", defaults: COMMENT_FIELDS, render: renderComments },
  subreddits: { defaults: SUBREDDIT_FIELDS, render: renderSubreddits },
};

const INTERACTION_ENDPOINTS: Record<"users" | "users_list" | "subreddits", { path: string; render: Render }> = {
  users: { path: "/api/users/interactions/users", render: renderCounts },
  users_list: { path: "/api/users/interactions/users/list", render: renderInteractionList },
  subreddits: { path: "/api/users/interactions/subreddits", render: renderCounts },
};

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

/** Lists matches from `<path>`, or counts them per group via `<path>/aggregate` when group_by is set. */
async function searchOrCount(path: string, options: SearchOptions & Params, defaults: string[], render: Render): Promise<string> {
  const { fields: requested, group_by, frequency, min_count, ...rest } = options;
  const filters = apiParams(rest);
  if (!group_by) {
    onlyWith({ frequency, min_count }, ["frequency", "min_count"], false, "group_by");
    if (typeof filters.limit === "number" && filters.limit > 100) {
      throw new InputError('limit must be 1-100 (or "auto") when listing results; larger limits only apply with group_by.');
    }
    const data = await callApi(path, { ...filters, fields: fieldsFor(options.format, requested, defaults) });
    return respond(data, options, render);
  }
  onlyWith({ frequency }, ["frequency"], group_by === "created_utc", "group_by=created_utc");
  onlyWith({ min_count }, ["min_count"], group_by !== "created_utc", "group_by=author or group_by=subreddit");
  if (filters.limit === "auto") throw new InputError('limit "auto" does not apply with group_by; omit limit to get all groups.');
  if (group_by === "created_utc" && !frequency) throw new InputError("group_by=created_utc needs frequency (e.g. year, month, day).");
  const data = await callApi(`${path}/aggregate`, { ...filters, aggregate: group_by, frequency, min_count });
  return respond(data, options, (rows) => renderCounts(rows, { group: group_by, frequency }));
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
    "get_by_ids",
    {
      title: "Look up by ID",
      description:
        "Fetch posts, comments or subreddits by ID (up to 500). Posts and comments also accept Reddit URLs and share links. " +
        "Useful for IDs found in search results or interaction lists.",
      inputSchema: z.object({
        kind: z.enum(["posts", "comments", "subreddits"]),
        ids: z.array(z.string()).min(1).max(500).describe("IDs (e.g. ei30r4, t3_ei30r4) or, for posts and comments, Reddit URLs"),
        fields,
        ...output,
      }),
      annotations: readOnly,
    },
    ({ kind, ids, fields: requested, ...settings }) =>
      toolResult(async () => {
        const lookup = ID_LOOKUPS[kind];
        const resolved = lookup.kind ? await resolveIds(ids, lookup.kind) : ids;
        const data = await callApi(`/api/${kind}/ids`, { ids: resolved, fields: fieldsFor(settings.format, requested, lookup.defaults) });
        return respond(data, settings, lookup.render);
      }),
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
    "get_subreddit_rules",
    {
      title: "Get subreddit rules",
      description: "Get the rules of one or more subreddits.",
      inputSchema: z.object({ subreddits: z.array(z.string()).min(1).max(1000), ...output }),
      annotations: readOnly,
    },
    forward("/api/subreddits/rules", renderRules),
  );

  server.registerTool(
    "get_subreddit_wikis",
    {
      title: "Get subreddit wiki pages",
      description: "Get wiki page contents, either all pages of a subreddit or specific paths (e.g. /r/travel/wiki/faq). Set list_only to get just the page paths of a subreddit.",
      inputSchema: z.object({
        subreddit: z.string().optional(),
        paths: z.array(z.string()).max(100).optional(),
        limit: numeric(z.number().int().min(1).max(100)).optional(),
        list_only: flag().optional().describe("Return only the wiki page paths (requires subreddit)"),
        ...output,
      }),
      annotations: readOnly,
    },
    ({ list_only, ...args }) =>
      toolResult(() =>
        list_only
          ? fetchAndRender(callApi, "/api/subreddits/wikis/list", { subreddit: args.subreddit, format: args.format, max_chars: args.max_chars }, renderWikiPaths)
          : fetchAndRender(callApi, "/api/subreddits/wikis", args, renderWikis),
      ),
  );

  server.registerTool(
    "search_users",
    {
      title: "Search users",
      description: "Find users by name, name prefix, karma, activity counts. Returns aggregate stats (post/comment counts, first/last activity, karma); updated infrequently.",
      inputSchema: z.object({
        author: z.string().optional(),
        author_prefix: z.string().optional(),
        min_num_posts: numeric(z.number().int()).optional(),
        min_num_comments: numeric(z.number().int()).optional(),
        active_since: date.optional(),
        min_karma: numeric(z.number().int()).optional(),
        limit: numeric(z.number().int().min(1).max(1000)).optional().describe("Default 25"),
        sort: z.enum(["asc", "desc"]).optional(),
        sort_type: z.enum(["author", "total_karma"]).optional(),
        ...output,
      }),
      annotations: readOnly,
    },
    forward("/api/users/search", renderUsers),
  );

  server.registerTool(
    "get_user_interactions",
    {
      title: "Get user interactions",
      description:
        "See who or where a user interacts. with=users: aggregated reply counts with other users; " +
        "with=users_list: individual interactions; with=subreddits: activity per subreddit. " +
        "Very active users may time out; narrow with after/before.",
      inputSchema: z.object({
        author: z.string(),
        with: z.enum(["users", "users_list", "subreddits"]),
        subreddit: z.string().optional().describe("Only for with=users/users_list"),
        after: date.optional(),
        before: date.optional(),
        min_count: numeric(z.number().int().min(0)).optional(),
        limit: numeric(z.number().int().min(1)).optional().describe("Default 100"),
        weight_posts: numeric().optional().describe("Only for with=subreddits (default 1.0)"),
        weight_comments: numeric().optional().describe("Only for with=subreddits (default 1.0)"),
        ...output,
      }),
      annotations: readOnly,
    },
    ({ with: target, ...args }) =>
      toolResult(async () => {
        onlyWith(args, ["subreddit"], target !== "subreddits", "with=users or with=users_list");
        onlyWith(args, ["weight_posts", "weight_comments"], target === "subreddits", "with=subreddits");
        const endpoint = INTERACTION_ENDPOINTS[target];
        return fetchAndRender(callApi, endpoint.path, args, endpoint.render);
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
  description: `Query archived Reddit posts, comments, subreddits and users via the Arctic Shift API (${BASE_URL}).`,
  instructions:
    "Read-only access to the Arctic Shift archive of Reddit. For any Reddit link, start with get_thread. " +
    "Results are compact markdown by default; pass format=json for raw records. " +
    "Search results are sorted by date only; for most active authors or subreddits, set group_by on search_posts/search_comments. " +
    FRESHNESS,
  registerTools,
};
