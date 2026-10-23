# mcp-toolshed

MCP tools for making restricted parts of the web accessible to agents.

Some platforms restrict their APIs or keep their history out of an agent's reach. mcp-toolshed wraps such sources as MCP servers, one per platform, so an agent can search and read them in a few tool calls.

Each server runs on Cloudflare Workers at `/<platform>/mcp`, has only read-only tools, and returns compact markdown sized for an agent's context. Deployments have no authentication: anyone with the URL can use them, and their requests reach the platforms' APIs from your Worker.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Flowm/mcp-toolshed)

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

Test with the MCP Inspector (`npx @modelcontextprotocol/inspector@latest`) pointed at a platform's endpoint, `http://localhost:8788/<platform>/mcp`.

`@types/node` is a dev dependency even though `src/` uses no Node APIs: with the compatibility date in `wrangler.jsonc` the Workers runtime enables Node.js compatibility by default, and without the types `wrangler types` (run by `lint`, `test` and `type-check`) asks to install them on every run.

## Adding a platform

1. Create `src/platforms/<id>/` exporting a `Platform` (`src/core/platform.ts`): its id (the URL segment, named after the platform rather than the data source), server name, description, instructions and `registerTools`.
2. Build its API client with `createJsonClient` (`src/core/client.ts`), passing hooks for how the API wraps payloads and errors and which failures to retry.
3. Give every tool the output settings from `outputSettings` and use the helpers in `src/core/tool.ts`, `output.ts` and `markdown.ts`.
4. Add it to `PLATFORMS` in `src/platforms/index.ts`.

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
claude mcp add --transport http <platform> https://<your-deployment>/<platform>/mcp
```
