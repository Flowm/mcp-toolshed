import { describe, expect, it } from "vitest";
import { z } from "zod";

import { flag, numeric } from "./input.ts";

describe("numeric", () => {
  const count = numeric(z.number().int().min(0));

  it("accepts numbers and numeric strings", () => {
    expect(count.parse(25)).toBe(25);
    expect(count.parse("25")).toBe(25);
    expect(count.parse(" 7 ")).toBe(7);
  });

  it.each(["", "  ", "abc", null, true, "-1", "2.5"])("rejects %j instead of coercing it", (value) => {
    expect(count.safeParse(value).success).toBe(false);
  });
});

describe("flag", () => {
  it.each([
    [true, true],
    ["true", true],
    [false, false],
    ["false", false],
  ])("reads %j as %s", (value, expected) => {
    expect(flag().parse(value)).toBe(expected);
  });

  it.each(["yes", "", 1])("rejects %j", (value) => {
    expect(flag().safeParse(value).success).toBe(false);
  });
});
