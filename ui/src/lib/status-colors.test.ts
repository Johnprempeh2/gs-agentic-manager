import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as statusColors from "./status-colors";

const RAW_PALETTE_CLASS =
  /\b(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/;

function recipeStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(recipeStrings);
  return [];
}

describe("status-colors", () => {
  it("uses semantic status tokens, not raw palette classes", () => {
    const offenders = recipeStrings(statusColors).filter((recipe) => RAW_PALETTE_CLASS.test(recipe));
    expect(offenders).toEqual([]);
  });

  it("maps each status tone to a token defined in index.css for both themes", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const [light, dark] = css.split(/\n\.dark \{/);
    const used = new Set(
      recipeStrings(statusColors).flatMap((recipe) =>
        [...recipe.matchAll(/\b(?:bg|text|border)-status-([a-z]+(?:-(?:foreground|soft))?)\b/g)].map((m) => m[1]),
      ),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const token of used) {
      expect(light, `--status-${token} (light)`).toContain(`--status-${token}:`);
      expect(css, `--color-status-${token} (@theme)`).toContain(`--color-status-${token}:`);
      // Neutral rides theme-aware tokens, so only the hue tones need a void override.
      if (!token.startsWith("neutral")) {
        expect(dark, `--status-${token} (dark)`).toContain(`--status-${token}:`);
      }
    }
  });
});
