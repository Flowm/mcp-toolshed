// Rules every platform must follow, checked through its real endpoint. A new platform in PLATFORMS is covered
// automatically.

import { describe, expect, it } from "vitest";

import { mcpPath } from "../core/platform.ts";
import { initializeParams, rpc } from "../test/helpers.ts";
import { PLATFORMS } from "./index.ts";

// Tool definitions are sent with every conversation. ~4 characters per token puts this at ~5k tokens.
const DEFINITION_BUDGET_CHARS = 20_000;

interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { properties?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
}

describe.each(PLATFORMS.map((platform) => [platform.id, platform] as const))("platform %s", (_id, platform) => {
  const path = mcpPath(platform);
  const tools = async (): Promise<Tool[]> => (await rpc(path, "tools/list")).tools;

  it("has a URL-safe id", () => {
    expect(platform.id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("introduces itself on initialize", async () => {
    const result = await rpc(path, "initialize", initializeParams);
    expect(result.serverInfo).toMatchObject({ name: platform.name, version: platform.version, description: platform.description });
    expect(result.instructions).toBe(platform.instructions);
    expect(platform.instructions.length).toBeGreaterThan(0);
  });

  it("offers uniquely named, documented tools", async () => {
    const list = await tools();
    expect(list.length).toBeGreaterThan(0);
    const names = list.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of list) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
    }
  });

  it("marks every tool as read-only and open-world", async () => {
    for (const tool of await tools()) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
  });

  it("offers the output settings on every tool", async () => {
    for (const tool of await tools()) {
      expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).toEqual(expect.arrayContaining(["format", "max_chars"]));
    }
  });

  it(`keeps its tool definitions under ${DEFINITION_BUDGET_CHARS} characters`, async () => {
    expect(JSON.stringify(await tools()).length).toBeLessThan(DEFINITION_BUDGET_CHARS);
  });
});
