// A platform is one MCP server (its tools and guidance); the router serves each at /<id>/mcp.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

export interface Platform {
  /** URL segment, e.g. "reddit" for /reddit/mcp. Named after the platform, not the data source. */
  id: string;
  /** MCP server name, e.g. "arctic-shift". */
  name: string;
  version: string;
  /** One line on what the server offers, listed at / and sent to clients on initialize. */
  description: string;
  /** Usage guidance sent to clients on initialize. */
  instructions: string;
  registerTools(server: McpServer): void;
}

export const mcpPath = (platform: Platform) => `/${platform.id}/mcp`;

function createServer(platform: Platform): McpServer {
  const server = new McpServer({ name: platform.name, version: platform.version, description: platform.description }, { instructions: platform.instructions });
  platform.registerTools(server);
  return server;
}

type FetchHandler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

/** Serves each platform at /<id>/mcp and lists the endpoints at /. Everything else is a 404. */
export function createRouter(platforms: Platform[]): FetchHandler {
  if (new Set(platforms.map((platform) => platform.id)).size !== platforms.length) throw new Error("Platform ids must be unique.");

  // The handler checks the request path against its route, so each platform gets its own.
  const handlers = new Map(
    platforms.map((platform) => {
      const path = mcpPath(platform);
      return [path, createMcpHandler(() => createServer(platform), { route: path })];
    }),
  );

  return async (request, env, ctx) => {
    const url = new URL(request.url);
    const handler = handlers.get(url.pathname);
    if (handler) return handler(request, env, ctx);
    if (url.pathname === "/") return new Response(describeEndpoints(platforms, url));
    return new Response("Not found", { status: 404 });
  };
}

function describeEndpoints(platforms: Platform[], url: URL): string {
  const lines = ["MCP servers on this Worker. Connect an MCP client to one of:", ""];
  for (const platform of platforms) lines.push(`- ${new URL(mcpPath(platform), url)}  ${platform.description}`);
  return `${lines.join("\n")}\n`;
}
