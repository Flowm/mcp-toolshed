// Plumbing shared by every platform's tools: error handling, option checks and single-endpoint tools.

import type { Get, Params } from "./client.ts";
import { type Output, type Render, respond } from "./output.ts";

/** A failure the model can act on; its message is returned as the tool's error text. */
export class ToolError extends Error {}

/** Input the caller can fix; reported to the model as a tool error. */
export class InputError extends ToolError {}

export const readOnly = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

/** Runs a tool's work and wraps its text, or its expected failure, as an MCP tool result. */
export async function toolResult(work: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] };
  } catch (e) {
    const message = e instanceof ToolError ? e.message : `Request failed: ${String(e)}`;
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

/**
 * Rejects options that only one mode of a tool understands. The API rejects or silently ignores parameters an
 * endpoint does not use, so a clear error up front saves the model a wasted call.
 */
export function onlyWith(options: Record<string, unknown>, names: string[], allowed: boolean, mode: string): void {
  const used = names.filter((name) => options[name] !== undefined);
  if (!allowed && used.length > 0) throw new InputError(`${used.join(" and ")} only appl${used.length === 1 ? "ies" : "y"} with ${mode}.`);
}

/** A tool's arguments without the output settings, which the API would reject as unknown parameters. */
export function apiParams<T extends Output>(args: T): Omit<T, keyof Output> {
  const params = { ...args };
  delete params.format;
  delete params.max_chars;
  return params;
}

/** Calls one endpoint with a tool's arguments, minus the output settings, and renders the result. */
export async function fetchAndRender(get: Get, path: string, args: Output & Params, render: Render): Promise<string> {
  return respond(await get(path, apiParams(args)), args, render);
}
