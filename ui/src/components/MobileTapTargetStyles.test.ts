import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("../index.css", import.meta.url), "utf8");

function cssBlock(selector: string, from = 0): string {
  const start = stylesheet.indexOf(`${selector} {`, from);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);
  const bodyStart = stylesheet.indexOf("{", start);
  return stylesheet.slice(bodyStart + 1, stylesheet.indexOf("}", bodyStart));
}

describe("phone chat styles (GRE-5819)", () => {
  it("lets a long external link wrap inside a chat bubble", () => {
    const block = cssBlock(".paperclip-markdown-external-ref");
    expect(block).not.toContain("white-space: nowrap");
    expect(block).toContain("overflow-wrap: anywhere");
  });

  it("gives the task chat mode chip a 44px tap layer on touch screens", () => {
    const coarse = stylesheet.indexOf("@media (pointer: coarse)");
    const layer = cssBlock('[data-slot="task-chat-mode-trigger"]::before', coarse);
    expect(layer).toContain("position: absolute");
    // 32px chip + 6px above and below.
    expect(layer).toContain("inset: calc(var(--spacing) * -1.5) 0");
  });

  it("lifts the Conference Room composer above the phone keyboard only by what covers it", () => {
    const block = cssBlock(".board-chat-composer-dock");
    expect(block).toContain("max(0px, calc(var(--vv-bottom-inset)");
    expect(block).toContain("- 4rem - var(--sz-safe-bottom)");
  });
});
