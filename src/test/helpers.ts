// Helpers shared by the tests: requests to the Worker's MCP endpoints and stubbed API responses.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect, vi } from "vitest";

import worker from "../index.ts";

type Handler = (request: Request<unknown, IncomingRequestCfProperties>, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

/** Sends a request for https://mcp.test<path> to `handler`, by default the Worker. */
export async function call(path: string, init?: RequestInit, handler: Handler = worker.fetch): Promise<Response> {
  const ctx = createExecutionContext();
  // The runtime types an incoming request's `cf` as IncomingRequestCfProperties; a test request has none.
  const request = new Request(`https://mcp.test${path}`, init) as Request<unknown, IncomingRequestCfProperties>;
  const res = await handler(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Sends one JSON-RPC request to an MCP endpoint and returns its result. Stateless Streamable HTTP answers each POST as SSE. */
export async function rpc(path: string, method: string, params?: unknown, handler?: Handler): Promise<any> {
  const res = await call(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    handler,
  );
  expect(res.status).toBe(200);
  const data = (await res.text()).split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data!.slice("data: ".length)).result;
}

export const initializeParams = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };

export const respond = (body: string, init: ResponseInit = {}) => new Response(body, init);

/** Answers successive fetch calls with these responses, in order, and returns the spy. */
export function stubFetch(...responses: Response[]) {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return fetch;
}
