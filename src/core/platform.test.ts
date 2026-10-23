import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { call as callWorker, initializeParams, rpc as rpcWorker } from "../test/helpers.ts";
import { createRouter, type Platform } from "./platform.ts";

const fakePlatform = (id: string): Platform => ({
  id,
  name: `${id}-server`,
  version: "1.0.0",
  description: `The ${id} platform`,
  instructions: `Use ${id}.`,
  registerTools(server: McpServer) {
    server.registerTool(`${id}_tool`, { description: `A ${id} tool`, inputSchema: z.object({}) }, () => ({ content: [{ type: "text", text: id }] }));
  },
});

const route = createRouter([fakePlatform("alpha"), fakePlatform("beta")]);

const call = (path: string) => callWorker(path, undefined, route);
const rpc = (path: string, method: string, params?: unknown) => rpcWorker(path, method, params, route);

describe("createRouter", () => {
  it.each([
    ["/alpha/mcp", "alpha"],
    ["/beta/mcp", "beta"],
  ])("serves %s with the %s platform's server and tools", async (path, id) => {
    const init = await rpc(path, "initialize", initializeParams);
    expect(init.serverInfo).toMatchObject({ name: `${id}-server`, description: `The ${id} platform` });
    expect(init.instructions).toBe(`Use ${id}.`);
    const { tools } = await rpc(path, "tools/list");
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([`${id}_tool`]);
  });

  it("lists every endpoint at /", async () => {
    expect(await (await call("/")).text()).toBe(
      [
        "MCP servers on this Worker. Connect an MCP client to one of:",
        "",
        "- https://mcp.test/alpha/mcp  The alpha platform",
        "- https://mcp.test/beta/mcp  The beta platform",
        "",
      ].join("\n"),
    );
  });

  it.each(["/mcp", "/alpha", "/gamma/mcp", "/alpha/mcp/extra"])("answers %s with 404", async (path) => {
    expect((await call(path)).status).toBe(404);
  });

  it("rejects duplicate platform ids", () => {
    expect(() => createRouter([fakePlatform("alpha"), fakePlatform("alpha")])).toThrow("Platform ids must be unique.");
  });
});
