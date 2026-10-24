// Turn anything a user can paste (URLs, share links, redd.it links, bare or prefixed IDs)
// into t3_/t1_ prefixed Reddit IDs.

import { InputError } from "../../core/tool.ts";
import { callApi } from "./api.ts";

/** Reddit's type prefix for an ID: t3_ for posts, t1_ for comments. */
export type Kind = "t3" | "t1";

export interface Target {
  postId?: string;
  commentId?: string;
}

const BASE36 = "[a-z0-9]{2,13}";
const PREFIXED = new RegExp(`^(t[13])_(${BASE36})$`, "i");
const BARE = new RegExp(`^${BASE36}$`, "i");
const COMMENTS_PATH = new RegExp(`/(?:(?:r|u|user)/[^/]+/)?comments/(${BASE36})(?:/[^/]*(?:/(${BASE36}))?)?/?$`, "i");
const SHARE_PATH = /^\/(?:r|u|user)\/[^/]+\/s\/[A-Za-z0-9]+$/;
const REDD_IT_PATH = new RegExp(`^/(${BASE36})/?$`, "i");
const REDDIT_HOST = /(?:^|\.)(?:reddit\.com|redd\.it)$/i;

const HELP =
  "Pass a Reddit URL (https://www.reddit.com/r/<sub>/comments/<id>/...), a share link (/r/<sub>/s/<code>), a redd.it link, or an ID such as abc123x, t3_abc123x (post) or t1_abc123x (comment).";

const KIND_NAMES: Record<Kind, string> = { t3: "post", t1: "comment" };

type Parsed = Target | { sharePath: string };

function splitUrl(text: string): { host: string; path: string } {
  // Accept "www.reddit.com/r/..." without a scheme too.
  const withScheme = /^(?:[\w-]+\.)*(?:reddit\.com|redd\.it)\//i.test(text) ? `https://${text}` : text;
  if (!withScheme.includes("://")) return { host: "", path: withScheme.split(/[?#]/)[0] ?? "" };
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InputError(`Could not parse ${JSON.stringify(text)} as a URL. ${HELP}`);
  }
  if (!REDDIT_HOST.test(url.hostname)) throw new InputError(`${url.hostname} is not a Reddit URL. ${HELP}`);
  return { host: url.hostname.toLowerCase(), path: url.pathname };
}

/** Parses an input without network access; share links come back unresolved. `bareKind` decides what a bare ID means. */
function parse(input: string, bareKind: Kind): Parsed {
  const text = input.trim();
  const prefixed = PREFIXED.exec(text);
  if (prefixed) {
    const id = `${prefixed[1]!.toLowerCase()}_${prefixed[2]!.toLowerCase()}`;
    return prefixed[1]!.toLowerCase() === "t3" ? { postId: id } : { commentId: id };
  }
  if (BARE.test(text)) {
    const id = `${bareKind}_${text.toLowerCase()}`;
    return bareKind === "t3" ? { postId: id } : { commentId: id };
  }

  const { host, path } = splitUrl(text);
  const normalized = (path.startsWith("/") ? path : `/${path}`).replace(/\/+$/, "");

  if (SHARE_PATH.test(normalized)) return { sharePath: normalized };

  const comments = COMMENTS_PATH.exec(normalized);
  if (comments) {
    return {
      postId: `t3_${comments[1]!.toLowerCase()}`,
      ...(comments[2] ? { commentId: `t1_${comments[2].toLowerCase()}` } : {}),
    };
  }

  const reddIt = host.endsWith("redd.it") ? REDD_IT_PATH.exec(normalized) : null;
  if (reddIt) return { postId: `t3_${reddIt[1]!.toLowerCase()}` };

  throw new InputError(`Could not read a Reddit post or comment from ${JSON.stringify(input)}. ${HELP}`);
}

/** Resolves an input to a target, expanding a share link through Arctic Shift's /api/short_links. */
export async function resolveTarget(input: string, bareKind: Kind): Promise<Target> {
  const parsed = parse(input, bareKind);
  if (!("sharePath" in parsed)) return parsed;

  const links = (await callApi<{ original_path?: string; resolved_path?: string }[] | null>("/api/short_links", { paths: parsed.sharePath })) ?? [];
  const target = links.find((link) => link.original_path === parsed.sharePath)?.resolved_path;
  if (!target) throw new InputError(`Arctic Shift has not archived the share link ${parsed.sharePath}. Open it in a browser and pass the full /comments/ URL instead.`);
  const result = parse(target, bareKind);
  if ("sharePath" in result) throw new InputError(`Share link ${parsed.sharePath} resolved to another share link (${target}).`);
  return result;
}

function pick(target: Target, kind: Kind, input: string): string {
  const id = kind === "t3" ? target.postId : target.commentId;
  if (!id) throw new InputError(`${JSON.stringify(input)} does not identify a ${KIND_NAMES[kind]}. ${HELP}`);
  return id;
}

/** Resolves a post (t3) or comment (t1) reference to a prefixed ID. A comment URL yields its post when asking for t3. */
export async function resolveId(input: string, kind: Kind): Promise<string> {
  return pick(await resolveTarget(input, kind), kind, input);
}
