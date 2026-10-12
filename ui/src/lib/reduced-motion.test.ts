import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexCss = readFileSync(new URL("../index.css", import.meta.url), "utf8");

/** Bodies of every `@media (prefers-reduced-motion: reduce)` block, joined. */
function reducedMotionCss(): string {
  const bodies: string[] = [];
  const opener = "@media (prefers-reduced-motion: reduce)";
  let from = 0;
  for (let at = indexCss.indexOf(opener, from); at !== -1; at = indexCss.indexOf(opener, from)) {
    const start = indexCss.indexOf("{", at);
    let depth = 0;
    let end = start;
    for (; end < indexCss.length; end++) {
      if (indexCss[end] === "{") depth++;
      if (indexCss[end] === "}" && --depth === 0) break;
    }
    bodies.push(indexCss.slice(start + 1, end));
    from = end;
  }
  return bodies.join("\n");
}

// GRE-821: looping Tailwind utilities stop when the OS asks for reduced motion.
describe("reduced motion", () => {
  const css = reducedMotionCss();

  it("stops pulse, bounce and ping", () => {
    expect(css).toMatch(/\.animate-pulse,\s*\.animate-bounce\s*\{\s*animation:\s*none;/);
    expect(css).toMatch(/\.animate-ping\s*\{\s*animation:\s*none;\s*visibility:\s*hidden;/);
  });

  it("keeps spin, the loading signal", () => {
    expect(css).not.toContain(".animate-spin");
  });
});
