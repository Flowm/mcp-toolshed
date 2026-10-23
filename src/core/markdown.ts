// Building blocks for compact markdown tool output, shared by all platforms.

export type Thing = Record<string, unknown>;

export const asList = (data: unknown): Thing[] => (Array.isArray(data) ? data : []);
export const str = (value: unknown): string => (value == null ? "" : String(value));
export const num = (value: unknown): string => (typeof value === "number" ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : str(value));
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const counted = (value: unknown, word: string) => `${num(value)} ${word}${Math.abs(Number(value)) === 1 ? "" : "s"}`;
export const meta = (...parts: unknown[]) => parts.filter((part) => typeof part === "string" && part !== "").join(" · ");
// Blank lines stay empty so paragraphs don't pick up trailing whitespace.
export const indent = (text: string, pad: string) => text.replaceAll(/\n(?!\n|$)/g, `\n${pad}`);

export const normalizeNewlines = (text: unknown) => str(text).replaceAll("\r\n", "\n");

export function clip(text: unknown, limit: number): string {
  const trimmed = normalizeNewlines(text).trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit).trimEnd()} … [truncated]`;
}

export function formatDate(epoch: unknown, { time = true } = {}): string {
  const seconds = Number(epoch);
  if (epoch == null || !Number.isFinite(seconds)) return "";
  const iso = new Date(seconds * 1000).toISOString();
  return time ? `${iso.slice(0, 16).replace("T", " ")} UTC` : iso.slice(0, 10);
}

// Optional parts render only when the field was returned, so a narrow `fields` selection still reads cleanly.
export const field = (thing: Thing, key: string, format: (value: unknown) => string) => (thing[key] == null ? "" : format(thing[key]));
