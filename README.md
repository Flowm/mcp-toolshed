# mcp-toolshed

MCP tools for making restricted parts of the web accessible to agents.

Some platforms restrict their APIs or keep their history out of an agent's reach. mcp-toolshed wraps such sources as MCP servers, one per platform, so an agent can search and read them in a few tool calls. The first is Reddit, served from the Arctic Shift archive.

Each server runs on Cloudflare Workers at `/<platform>/mcp`, has only read-only tools, and returns compact markdown sized for an agent's context. Deployments have no authentication: anyone with the URL can use them, and their requests reach the platforms' APIs from your Worker.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Flowm/mcp-toolshed)

## Platforms

### Reddit: `/reddit/mcp`

Reddit posts, comments, subreddits and users from the [Arctic Shift](https://arctic-shift.photon-reddit.com) archive ([API docs](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md)).

| Tool                    | What it does                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_thread`            | Reads a post and its comment tree from whatever a user pastes: a post or comment URL, a share link (`/r/<sub>/s/<code>`), a redd.it link or an ID                     |
| `search_posts`          | Finds posts by subreddit, author, keywords, flair, linked URL or date; with `group_by`, counts them per author, subreddit or date                                     |
| `search_comments`       | Finds comments by subreddit, author, post, parent comment, text or date; with `group_by`, counts them the same way. An author alone gives that user's comment history |
| `get_by_ids`            | Fetches up to 500 posts, comments or subreddits by ID; posts and comments also by URL                                                                                 |
| `search_subreddits`     | Finds subreddits by name, name prefix, subscriber count, creation date or NSFW flag                                                                                   |
| `get_subreddit_rules`   | Lists the rules of one or more subreddits                                                                                                                             |
| `get_subreddit_wikis`   | Reads a subreddit's wiki pages, or lists their paths                                                                                                                  |
| `search_users`          | Finds users by name or name prefix, with karma, post and comment counts and first and last activity                                                                   |
| `get_user_interactions` | Shows whom a user interacts with most, each individual interaction, or the subreddits they are active in                                                              |
| `get_time_series`       | Shows post and comment counts, total scores or subscribers over time, Reddit-wide or for one subreddit                                                                |

Post and comment filters such as `link_id` and `parent_id` accept Reddit URLs as well as IDs.

Results that include items under 36 hours old carry a note that their scores and comment counts are placeholders until Arctic Shift backfills them. Requests that fail with HTTP 422 (usually a timeout) or 5xx are retried once.

## How it works

Each server is stateless and uses the MCP Streamable HTTP transport through `createMcpHandler` from the Cloudflare Agents SDK. A deployment lists its servers at `/`. The top-level `/mcp` is kept free for a possible future server that works across platforms.

Every tool returns compact markdown, or the raw API records with `format: "json"`, and caps its output at `max_chars` (default 40,000) with a truncation notice.

## Setup

```sh
mise trust && mise install   # toolchain (node, pnpm, prek)
mise setup                   # install the pre-commit hooks
pnpm install
```

## Develop

```sh
pnpm dev          # http://localhost:8788/ lists the endpoints
pnpm lint         # oxlint + oxfmt --check + tsc
pnpm lint:fix
pnpm test         # vitest in workerd via @cloudflare/vitest-plugin
```

Test with the MCP Inspector (`npx @modelcontextprotocol/inspector@latest`) pointed at an endpoint such as `http://localhost:8788/reddit/mcp`.

`@types/node` is a dev dependency even though `src/` uses no Node APIs: with the compatibility date in `wrangler.jsonc` the Workers runtime enables Node.js compatibility by default, and without the types `wrangler types` (run by `lint`, `test` and `type-check`) asks to install them on every run.

## Adding a platform

1. Create `src/platforms/<id>/` exporting a `Platform` (`src/core/platform.ts`): its id (the URL segment, named after the platform rather than the data source), server name, description, instructions and `registerTools`.
2. Build its API client with `createJsonClient` (`src/core/client.ts`), passing hooks for how the API wraps payloads and errors and which failures to retry.
3. Give every tool the output settings from `outputSettings` and use the helpers in `src/core/tool.ts`, `output.ts` and `markdown.ts`.
4. Add it to `PLATFORMS` in `src/platforms/index.ts`. The contract tests (`src/platforms/contract.test.ts`) then check it through its endpoint: a URL-safe id, uniquely named and documented tools, read-only annotations, the output settings on every tool, and tool definitions under 20,000 characters (about 5k tokens).

Secrets are named `<PLATFORM>_<NAME>`. List them without values in `.dev.vars.example`, which the Deploy to Cloudflare setup page asks for, and describe each under `cloudflare.bindings` in `package.json`. Put local values in `.dev.vars` (gitignored) and production values in with `wrangler secret put`. Code reads them through `import { env } from "cloudflare:workers"`, since the MCP server factory gets no `env`.

Keep `wrangler.jsonc` free of account-specific settings: forks and Deploy to Cloudflare clones deploy from it as it is. A storage binding (KV, D1, ...) needs a default name and no ID, so a clone's first deploy can create it.

## Deploy

A deployment serves at `https://mcp-toolshed.<your-subdomain>.workers.dev`, or at a custom domain if `DEPLOY_DOMAIN` is set.

### Deploy to Cloudflare button

The button clones this repository into your GitHub account and deploys your copy with Workers Builds. On the setup page, keep the deploy command as `pnpm run deploy`. Workers Builds ships pnpm 10 and normally switches to the pnpm version in `packageManager`; if installing fails, set the `PNPM_VERSION` build variable to `12`.

### CI

`.github/workflows/ci.yml` runs lint and tests on every push and PR. With the `CLOUDFLARE_API_TOKEN` repository secret, it also uploads a preview version for each PR and deploys `main`. Without it, for example in a copy that deploys through Workers Builds, those jobs are skipped.

### By hand

```sh
pnpm run deploy           # production
pnpm run deploy:preview   # preview-<sha> alias, not promoted
```

Plain `pnpm deploy` is pnpm's built-in command for deploying workspace packages and never reaches the script.

### Settings

| Setting          | What it does                                                                                                                                | Locally           | CI                  | Workers Builds |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------- | -------------- |
| `DEPLOY_DOMAIN`  | Custom domain to serve at, in a zone on your Cloudflare account; the deploy creates its DNS record and certificate                          | `mise.local.toml` | repository variable | build variable |
| `REPOSITORY_URL` | Repository named in the User-Agent `mcp-toolshed (+<repository URL>)`, so the platforms' API operators can tell whose deployment is calling | `mise.local.toml` | set automatically   | build variable |

For local settings, copy `mise.local.toml.example` to `mise.local.toml`, which is gitignored.

### Connect a client

For example Claude Code:

```sh
claude mcp add --transport http reddit https://<your-deployment>/reddit/mcp
```
