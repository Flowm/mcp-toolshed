import { describe, expect, it } from "vitest";

import { decodeEntities } from "./markdown.ts";

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("&gt; quoted &amp; more &lt;3 &quot;x&quot; &#39;y&#39; &#x1F600;")).toBe(`> quoted & more <3 "x" 'y' 😀`);
  });

  it("decodes one level only and leaves unknown entities and bare ampersands alone", () => {
    expect(decodeEntities("&amp;lt; &bogus; a&b ?x=1&s=2 &#xFFFFFFF;")).toBe("&lt; &bogus; a&b ?x=1&s=2 &#xFFFFFFF;");
  });
});
