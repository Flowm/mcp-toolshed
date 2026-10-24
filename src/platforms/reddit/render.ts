// Compact markdown for model consumption. A raw post carries ~90 fields and a busy
// comment tree is hundreds of KB of JSON; these renderers keep the handful that matter.

import { asList, clip, counted, decodeEntities, field, formatDate, indent, meta, normalizeNewlines, num, plural, str, type Thing } from "../../core/markdown.ts";

const BODY_MAX_CHARS = 1500;
const SELFTEXT_MAX_CHARS = 4000;
const PREVIEW_MAX_CHARS = 300;

// Arctic Shift archives things the moment they are posted and backfills votes after ~36h.
const BACKFILL_SECONDS = 36 * 3600;
export const FRESHNESS = "Scores and comment counts of items posted under 36h ago are placeholders until Arctic Shift backfills them; do not report them as real counts.";
export const FRESHNESS_NOTE = `_Note: ${FRESHNESS}_`;

const bareId = (id: unknown): string => str(id).replace(/^t[13]_/, "");

/**
 * Text someone wrote, as Reddit shows it. Older posts and comments, and some wiki pages, arrive HTML-escaped, and
 * Reddit's editor marks empty paragraphs with a zero-width space (&amp;#x200B; once escaped); those are dropped
 * with the blank lines they leave.
 */
const text = (value: unknown): string =>
  decodeEntities(normalizeNewlines(value))
    .replaceAll(/&#x200b;|\u200b/gi, "")
    .replaceAll(/\n\s*\n/g, "\n\n");

const excerpt = (value: unknown, limit: number) => clip(text(value), limit);

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
  const url = text(post.url);
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
    field(post, "link_flair_text", (v) => `flair: ${text(v)}`),
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
    lines.push(`- **${text(post.title) || "(no title)"}** · ${meta(`\`${bareId(post.id)}\``, postMeta(post))}`);
    lines.push(...linkLines(post).map((line) => `  ${line}`));
    const preview = excerpt(post.selftext, PREVIEW_MAX_CHARS).split("\n")[0];
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
    const body = excerpt(comment.body, BODY_MAX_CHARS);
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
    out.push(`${pad}- ${header}: ${indent(excerpt(data.body, BODY_MAX_CHARS), `${pad}  `)}`);
    const replies = data.replies as Thing | undefined;
    if (replies && typeof replies === "object") {
      treeLines(asList((replies.data as Thing | undefined)?.children), depth + 1, sort, out, rendered);
    }
  }
}

export function renderThread(post: Thing, tree: unknown, { sort = "tree" as CommentSort, includeComments = true } = {}): string {
  const lines = [`# ${text(post.title) || "(no title)"}`, "", meta(`\`${bareId(post.id)}\``, postMeta(post))];
  lines.push(...linkLines(post));
  const selftext = excerpt(post.selftext, SELFTEXT_MAX_CHARS);
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
    const description = excerpt(sub.public_description, PREVIEW_MAX_CHARS).split("\n")[0];
    if (description) lines.push(`  ${description}`);
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
  if (group === "author") return user({ author: row.key });
  if (group === "subreddit") return `r/${str(row.key)}`;
  return bucketLabel(row.created_utc ?? row.key, frequency);
}

// Counts arrive as strings.
const countValue = (row: Thing) => (row.count != null && Number.isFinite(Number(row.count)) ? num(Number(row.count)) : "?");

/** Rows of `{ key | created_utc, count }` from the search aggregate endpoints. */
export function renderCounts(data: unknown, { group, frequency }: { group?: CountGroup; frequency?: string } = {}): string {
  const rows = asList(data);
  if (rows.length === 0) return "No results.";
  return [`${plural(rows.length, "row")}:`, "", ...rows.map((row) => `- ${countLabel(row, group, frequency)}: ${countValue(row)}`)].join("\n");
}

export function renderTimeSeries(data: unknown): string {
  const points = asList(data);
  if (points.length === 0) return "No data points.";
  return [`${plural(points.length, "data point")}:`, "", ...points.map((point) => `- ${formatDate(point.date).replace(" 00:00 UTC", "")}: ${num(point.value)}`)].join("\n");
}

export const SUBREDDIT_SECTIONS = ["about", "rules", "wiki"] as const;
export type SubredditSection = (typeof SUBREDDIT_SECTIONS)[number];
/** What get_subreddit_info fetched: the subreddit record (null if unknown), its rules, and wiki page paths or pages. */
export type SubredditInfo = Partial<Record<SubredditSection, unknown>>;

function renderAbout(data: unknown): string {
  if (typeof data !== "object" || data === null) return "## About\n\n_Not in the archive. Check the name, or find it with search_subreddits._";
  const sub = data as Thing;
  // Arctic Shift's own key for the archive's post and comment counts.
  const stats = (sub["_meta"] ?? {}) as Thing;
  const lines = ["## About", ""];
  const title = text(sub.title).trim();
  if (title) lines.push(`_${title}_`, "");
  lines.push(
    meta(
      field(sub, "subscribers", (v) => counted(v, "subscriber")),
      field(sub, "created_utc", (v) => `created ${formatDate(v, { time: false })}`),
      sub.over18 ? "NSFW" : "",
      sub.subreddit_type && sub.subreddit_type !== "public" ? str(sub.subreddit_type) : "",
      field(stats, "num_posts", (v) => `${counted(v, "post")} archived`),
      field(stats, "num_comments", (v) => `${counted(v, "comment")} archived`),
      field(sub, "retrieved_on", (v) => `details as of ${formatDate(v, { time: false })}`),
    ),
  );
  const description = excerpt(sub.description || sub.public_description, SELFTEXT_MAX_CHARS);
  if (description) lines.push("", description);
  return lines.join("\n");
}

function renderRules(data: unknown): string {
  const rules = asList(data);
  if (rules.length === 0) return "## Rules\n\n_No rules found._";
  const lines = ["## Rules", ""];
  rules.forEach((rule, i) => {
    lines.push(`${i + 1}. **${text(rule.short_name)}**${rule.kind ? ` (applies to: ${str(rule.kind)})` : ""}`);
    const description = excerpt(rule.description, BODY_MAX_CHARS);
    if (description) lines.push(`   ${indent(description, "   ")}`);
  });
  return lines.join("\n");
}

/** Wiki pages, noting first, so truncation cannot drop it, which `requested` paths Arctic Shift has no page for. */
function renderWikis(data: unknown, requested: string[]): string {
  const pages = asList(data);
  const found = new Set(pages.map((page) => str(page.path).toLowerCase()));
  const missing = requested.filter((path) => !found.has(path.toLowerCase()));
  const sections = pages.map((page) => `## ${str(page.path)}\n\n${text(page.content).trim()}`);
  if (missing.length > 0) sections.unshift(`_Not found: ${missing.join(", ")}_`);
  return sections.join("\n\n");
}

function renderWikiPaths(data: unknown): string {
  const paths = asList(data);
  if (paths.length === 0) return "## Wiki\n\n_No wiki pages found._";
  return ["## Wiki", "", `${plural(paths.length, "page")} (read them with wiki_pages):`, "", ...paths.map((path) => `- ${str(path)}`)].join("\n");
}

/** The sections get_subreddit_info fetched, under one heading; the wiki is either page paths or the `wikiPaths` read. */
export function renderSubredditInfo(name: string, { about, rules, wiki }: SubredditInfo, wikiPaths?: string[]): string {
  const sections = [`# r/${name}`];
  if (about !== undefined) sections.push(renderAbout(about));
  if (rules !== undefined) sections.push(renderRules(rules));
  if (wiki !== undefined) sections.push(wikiPaths ? renderWikis(wiki, wikiPaths) : renderWikiPaths(wiki));
  return sections.join("\n\n");
}
