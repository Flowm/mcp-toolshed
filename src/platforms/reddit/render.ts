// Compact markdown for model consumption. A raw post carries ~90 fields and a busy
// comment tree is hundreds of KB of JSON; these renderers keep the handful that matter.

import { asList, clip, counted, field, formatDate, indent, meta, normalizeNewlines, num, plural, str, type Thing } from "../../core/markdown.ts";

const BODY_MAX_CHARS = 1500;
const SELFTEXT_MAX_CHARS = 4000;
const PREVIEW_MAX_CHARS = 300;

// Arctic Shift archives things the moment they are posted and backfills votes after ~36h.
const BACKFILL_SECONDS = 36 * 3600;
export const FRESHNESS = "Scores and comment counts of items posted under 36h ago are placeholders until Arctic Shift backfills them; do not report them as real counts.";
export const FRESHNESS_NOTE = `_Note: ${FRESHNESS}_`;

const bareId = (id: unknown): string => str(id).replace(/^t[13]_/, "");

function isFresh(thing: Thing): boolean {
  const created = Number(thing.created_utc);
  return Number.isFinite(created) && Date.now() / 1000 - created < BACKFILL_SECONDS;
}

function user(thing: Thing): string {
  const author = str(thing.author);
  return !author || author === "[deleted]" || author === "[removed]" ? "u/[deleted]" : `u/${author}`;
}

function postLink(post: Thing): string {
  const subreddit = str(post.subreddit);
  return subreddit && post.id ? `https://www.reddit.com/r/${subreddit}/comments/${bareId(post.id)}/` : "";
}

function commentLink(comment: Thing): string {
  const subreddit = str(comment.subreddit);
  return subreddit && comment.link_id && comment.id ? `https://www.reddit.com/r/${subreddit}/comments/${bareId(comment.link_id)}/_/${bareId(comment.id)}/` : "";
}

function outboundLink(post: Thing): string {
  const url = str(post.url);
  return url && !/^https?:\/\/(?:[\w-]+\.)?(?:reddit\.com|redd\.it)\//.test(url) ? url : "";
}

/** The post's reddit permalink and, for link posts, where it points. */
function linkLines(post: Thing): string[] {
  const outbound = outboundLink(post);
  return [postLink(post), outbound && `Link: ${outbound}`].filter(Boolean);
}

function postMeta(post: Thing): string {
  return meta(
    field(post, "subreddit", (v) => `r/${str(v)}`),
    field(post, "author", () => user(post)),
    field(post, "score", (v) => counted(v, "point")),
    field(post, "num_comments", (v) => counted(v, "comment")),
    formatDate(post.created_utc),
    post.over_18 === true ? "NSFW" : "",
    field(post, "link_flair_text", (v) => `flair: ${str(v)}`),
  );
}

function withFreshness(lines: string[], things: Thing[]): string {
  if (things.some(isFresh)) lines.push("", FRESHNESS_NOTE);
  return lines.join("\n");
}

export function renderPosts(data: unknown): string {
  const posts = asList(data);
  if (posts.length === 0) return "No posts matched.";
  const lines = [`${plural(posts.length, "post")}:`, ""];
  for (const post of posts) {
    lines.push(`- **${str(post.title) || "(no title)"}** · ${meta(`\`${bareId(post.id)}\``, postMeta(post))}`);
    lines.push(...linkLines(post).map((line) => `  ${line}`));
    const preview = clip(post.selftext, PREVIEW_MAX_CHARS).split("\n")[0];
    if (preview) lines.push(`  ${preview}`);
  }
  return withFreshness(lines, posts);
}

export function renderComments(data: unknown): string {
  const comments = asList(data);
  if (comments.length === 0) return "No comments matched.";
  const lines = [`${plural(comments.length, "comment")}:`, ""];
  for (const comment of comments) {
    const parent = str(comment.parent_id);
    lines.push(
      `- ${meta(
        `**${user(comment)}**`,
        field(comment, "subreddit", (v) => `r/${str(v)}`),
        field(comment, "score", (v) => counted(v, "point")),
        formatDate(comment.created_utc),
        `\`${bareId(comment.id)}\``,
        field(comment, "link_id", (v) => `on post \`${bareId(v)}\``),
        parent.startsWith("t1_") ? `reply to \`${bareId(parent)}\`` : "",
      )}`,
    );
    const link = commentLink(comment);
    if (link) lines.push(`  ${link}`);
    const body = clip(comment.body, BODY_MAX_CHARS);
    if (body) lines.push(`  ${indent(body, "  ")}`);
  }
  return withFreshness(lines, comments);
}

export type CommentSort = "tree" | "top";

// Collapsed "more" stubs rank lowest, so they stay at the end of their level.
const scoreRank = (node: Thing) => (node.kind === "more" ? -Infinity : Number((node.data as Thing | undefined)?.score) || 0);

function ordered(nodes: Thing[], sort: CommentSort): Thing[] {
  if (sort === "tree") return nodes;
  return nodes.toSorted((a, b) => scoreRank(b) - scoreRank(a));
}

function treeLines(nodes: Thing[], depth: number, sort: CommentSort, out: string[], rendered: Thing[]): void {
  const pad = "  ".repeat(depth);
  for (const node of ordered(nodes, sort)) {
    const data = (node.data ?? {}) as Thing;
    if (node.kind === "more") {
      const count = Number(data.count) || asList(data.children).length;
      const parent = str(data.parent_id);
      const hint = parent.startsWith("t1_") ? `get_thread with parent_id ${bareId(parent)}` : "raise comment_limit";
      out.push(`${pad}- _[+${count} more: ${hint}]_`);
      continue;
    }
    if (node.kind !== "t1") continue;
    rendered.push(data);
    const header = meta(
      `**${user(data)}**`,
      field(data, "score", (v) => counted(v, "point")),
      formatDate(data.created_utc),
      `\`${bareId(data.id)}\``,
    );
    out.push(`${pad}- ${header}: ${indent(clip(data.body, BODY_MAX_CHARS), `${pad}  `)}`);
    const replies = data.replies as Thing | undefined;
    if (replies && typeof replies === "object") {
      treeLines(asList((replies.data as Thing | undefined)?.children), depth + 1, sort, out, rendered);
    }
  }
}

export function renderThread(post: Thing, tree: unknown, { sort = "tree" as CommentSort, includeComments = true } = {}): string {
  const lines = [`# ${str(post.title) || "(no title)"}`, "", meta(`\`${bareId(post.id)}\``, postMeta(post))];
  lines.push(...linkLines(post));
  const selftext = clip(post.selftext, SELFTEXT_MAX_CHARS);
  if (selftext) lines.push("", selftext);

  // Everything shown, so the freshness check covers comments as well as the post.
  const rendered: Thing[] = [post];
  if (includeComments) {
    lines.push("", "---", "");
    const nodes = asList(tree);
    if (nodes.length === 0) lines.push("_No comments._");
    treeLines(nodes, 0, sort, lines, rendered);
  }
  return withFreshness(lines, rendered);
}

export function renderSubreddits(data: unknown): string {
  const subreddits = asList(data);
  if (subreddits.length === 0) return "No subreddits matched.";
  const lines = [`${plural(subreddits.length, "subreddit")}:`, ""];
  for (const sub of subreddits) {
    lines.push(
      `- ${meta(
        `**r/${str(sub.display_name) || "?"}**`,
        field(sub, "subscribers", (v) => counted(v, "subscriber")),
        field(sub, "created_utc", (v) => `created ${formatDate(v, { time: false })}`),
        sub.over18 === true ? "NSFW" : "",
        field(sub, "id", (v) => `\`${str(v)}\``),
      )}`,
    );
    const description = clip(sub.public_description, PREVIEW_MAX_CHARS).split("\n")[0];
    if (description) lines.push(`  ${description}`);
  }
  return lines.join("\n");
}

export function renderUsers(data: unknown): string {
  const users = asList(data);
  if (users.length === 0) return "No users matched.";
  const lines = [`${plural(users.length, "user")}:`, ""];
  for (const entry of users) {
    // Arctic Shift's own key for the aggregate user stats.
    const stats = (entry["_meta"] ?? {}) as Thing;
    const times = (keys: string[]) => keys.map((key) => Number(stats[key])).filter((t) => Number.isFinite(t) && t > 0);
    const first = times(["earliest_post_at", "earliest_comment_at"]);
    const last = times(["last_post_at", "last_comment_at"]);
    lines.push(
      `- ${meta(
        `**${user(entry)}**`,
        field(entry, "id", (v) => `\`${str(v)}\``),
        field(stats, "total_karma", (v) => `${num(v)} karma (${num(stats.post_karma)} post, ${num(stats.comment_karma)} comment)`),
        field(stats, "num_posts", (v) => counted(v, "post")),
        field(stats, "num_comments", (v) => counted(v, "comment")),
        first.length ? `first active ${formatDate(Math.min(...first), { time: false })}` : "",
        last.length ? `last active ${formatDate(Math.max(...last), { time: false })}` : "",
      )}`,
    );
  }
  return lines.join("\n");
}

export type CountGroup = "author" | "subreddit" | "created_utc";

const HALF_DAY_MS = 12 * 3600 * 1000;

/**
 * Labels a date bucket by its size. Arctic Shift starts buckets at midnight in the server's time zone (the
 * 2006 year bucket arrives as 2005-12-31T23:00:00Z), so day-or-larger buckets are shifted half a day before
 * reading the date; that is right for any server offset within ±12h.
 */
function bucketLabel(start: unknown, frequency: string | undefined): string {
  const ms = Date.parse(str(start));
  const unit = /year|quarter|month|week|day|hour|minute/.exec(str(frequency).toLowerCase())?.[0];
  if (!Number.isFinite(ms) || !unit) return str(start);
  if (unit === "hour" || unit === "minute") return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const iso = new Date(ms + HALF_DAY_MS).toISOString();
  if (unit === "year") return iso.slice(0, 4);
  if (unit === "quarter") return `${iso.slice(0, 4)}-Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`;
  if (unit === "month") return iso.slice(0, 7);
  return unit === "week" ? `week of ${iso.slice(0, 10)}` : iso.slice(0, 10);
}

function countLabel(row: Thing, group: CountGroup | undefined, frequency: string | undefined): string {
  // Search aggregates by author or subreddit name the group `key`; interaction endpoints name it after the group.
  const author = row.author ?? (group === "author" ? row.key : undefined);
  if (author != null) return user({ author });
  const subreddit = row.subreddit ?? (group === "subreddit" ? row.key : undefined);
  if (subreddit != null) return `r/${str(subreddit)}`;
  return bucketLabel(row.created_utc ?? row.key, frequency);
}

// Counts arrive as strings from search aggregates and as numbers from interaction endpoints.
const countValue = (row: Thing) => (row.count != null && Number.isFinite(Number(row.count)) ? num(Number(row.count)) : "?");

/** Rows of `{ <author|subreddit|created_utc|key>: ..., count }` from the aggregate and interaction endpoints. */
export function renderCounts(data: unknown, { group, frequency }: { group?: CountGroup; frequency?: string } = {}): string {
  const rows = asList(data);
  if (rows.length === 0) return "No results.";
  return [`${plural(rows.length, "row")}:`, "", ...rows.map((row) => `- ${countLabel(row, group, frequency)}: ${countValue(row)}`)].join("\n");
}

export function renderInteractionList(data: unknown): string {
  const rows = asList(data);
  if (rows.length === 0) return "No interactions found.";
  return [
    `${plural(rows.length, "interaction")}:`,
    "",
    ...rows.map(
      (row) =>
        `- ${meta(
          str(row.created_utc),
          user(row),
          str(row.interaction_type),
          field(row, "id", (v) => `\`${str(v)}\``),
        )}`,
    ),
  ].join("\n");
}

export function renderTimeSeries(data: unknown): string {
  const points = asList(data);
  if (points.length === 0) return "No data points.";
  return [`${plural(points.length, "data point")}:`, "", ...points.map((point) => `- ${formatDate(point.date).replace(" 00:00 UTC", "")}: ${num(point.value)}`)].join("\n");
}

export function renderRules(data: unknown): string {
  const subreddits = asList(data);
  if (subreddits.length === 0) return "No rules found.";
  const lines: string[] = [];
  for (const sub of subreddits) {
    const rules = asList(sub.rules);
    lines.push(`## r/${str(sub.subreddit)}`, "");
    if (rules.length === 0) lines.push("_No rules._");
    rules.forEach((rule, i) => {
      lines.push(`${i + 1}. **${str(rule.short_name)}**${rule.kind ? ` (applies to: ${str(rule.kind)})` : ""}`);
      const description = clip(rule.description, BODY_MAX_CHARS);
      if (description) lines.push(`   ${indent(description, "   ")}`);
    });
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderWikis(data: unknown): string {
  const pages = asList(data);
  if (pages.length === 0) return "No wiki pages found.";
  return pages.map((page) => `## ${str(page.path)}\n\n${normalizeNewlines(page.content).trim()}`).join("\n\n");
}

export function renderWikiPaths(data: unknown): string {
  const paths = asList(data);
  if (paths.length === 0) return "No wiki pages found.";
  return [`${plural(paths.length, "wiki page")}:`, "", ...paths.map((path) => `- ${str(path)}`)].join("\n");
}
