// The output settings every tool offers: markdown or raw JSON, within a character budget.

import { z } from "zod";

import { numeric } from "./input.ts";

export const DEFAULT_MAX_CHARS = 40_000;

const outputSchema = z.object({
  format: z.enum(["markdown", "json"]).optional().describe("markdown (default): compact summary of the key fields. json: the raw API records."),
  max_chars: numeric(z.number().int().min(1000).max(500_000))
    .optional()
    .describe(`Character budget for the result (default ${DEFAULT_MAX_CHARS}); longer output is truncated with a notice.`),
});
export type Output = z.infer<typeof outputSchema>;

/** The output settings to spread into every tool's input schema. */
export const outputSettings = outputSchema.shape;

export type Render = (data: unknown) => string;

export function limitChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const notice = `\n\n_[output truncated at ${maxChars} characters; narrow the query or raise max_chars]_`;
  return `${text.slice(0, Math.max(0, maxChars - notice.length)).trimEnd()}${notice}`;
}

export function renderJson(data: unknown, maxChars: number): string {
  const text = JSON.stringify(data);
  if (text.length <= maxChars) return text;
  const notice = `\n[truncated at ${maxChars} characters; this JSON is incomplete. Narrow the query, pass fields, or raise max_chars]`;
  return `${text.slice(0, Math.max(0, maxChars - notice.length))}${notice}`;
}

export function respond(data: unknown, { format, max_chars = DEFAULT_MAX_CHARS }: Output, render: Render): string {
  return format === "json" ? renderJson(data, max_chars) : limitChars(render(data), max_chars);
}

/** The fields to request: the caller's choice, else the ones the markdown shows (JSON gets everything). */
export const fieldsFor = (format: Output["format"], requested: string[] | undefined, defaults: string[]) => requested ?? (format === "json" ? undefined : defaults);
