import { describe, expect, it } from "vitest";

import { limitChars, renderJson } from "./output.ts";

describe("output budget", () => {
  it("leaves short output alone and truncates long output with a notice", () => {
    expect(limitChars("short", 1000)).toBe("short");
    const text = limitChars("x".repeat(5000), 1000);
    expect(text).toHaveLength(1000);
    expect(text).toMatch(/_\[output truncated at 1000 characters; narrow the query or raise max_chars\]_$/);
  });

  it("marks truncated JSON as incomplete", () => {
    expect(renderJson([{ id: 1 }], 1000)).toBe('[{"id":1}]');
    const text = renderJson(
      Array.from({ length: 500 }, (_, id) => ({ id })),
      1000,
    );
    expect(text).toHaveLength(1000);
    expect(text).toContain("this JSON is incomplete");
  });
});
