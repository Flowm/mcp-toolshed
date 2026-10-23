import { describe, expect, it } from "vitest";

import { call, rpc } from "./test/helpers.ts";

const listTools = async (path: string) => (await rpc(path, "tools/list")).tools;

describe("worker", () => {
  it("lists the reddit endpoint at /", async () => {
    expect(await (await call("/")).text()).toContain("- https://mcp.test/reddit/mcp  Query archived Reddit posts");
  });

  it("serves the reddit tools at /reddit/mcp", async () => {
    expect((await listTools("/reddit/mcp")).map((tool: { name: string }) => tool.name)).toContain("get_thread");
  });

  // /mcp is reserved for a future server that works across platforms.
  it.each(["/mcp", "/nope"])("answers %s with 404", async (path) => {
    expect((await call(path)).status).toBe(404);
  });
});
