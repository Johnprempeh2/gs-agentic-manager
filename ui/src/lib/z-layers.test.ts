import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cn, Z_LAYERS } from "./utils";

/** A z-index class with a number in it: `z-50`, `focus:z-10`, `z-[60]`, `z-(--z-60)`. */
const NUMERIC_Z_CLASS = /(?<![\w-])(?:[\w-]+:|\[[^\]\s]+\]:)*-?z-(?:\d+|\[\d+\]|\(--z-\d+\))(?![\w-])/;
/** An inline `zIndex: 10` style. */
const NUMERIC_Z_STYLE = /zIndex:\s*[^,}\n]*\b\d+\b/;

function sourceFiles(root: URL): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), root);
    if (entry.isDirectory()) return sourceFiles(url);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [fileURLToPath(url)];
  });
}

describe("stacking scale", () => {
  it("defines every named layer once in index.css, lowest first", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const values = Z_LAYERS.map((layer) => {
      const match = css.match(new RegExp(`--z-index-${layer}:\\s*(\\d+);`, "g"));
      expect(match, layer).toHaveLength(1);
      return Number(match![0].replace(/\D+/g, " ").trim().split(" ").pop());
    });
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it("lets cn() replace one named layer with another", () => {
    expect(cn("fixed z-dialog", "z-popover")).toBe("fixed z-popover");
    expect(cn("z-raised focus:z-sticky", "focus:z-top")).toBe("z-raised focus:z-top");
  });

  it("keeps numeric z-index values out of the UI source", () => {
    // Pick a named layer (`z-dialog`, `var(--z-index-popover)`) instead.
    // Reordering a list on purpose (`zIndex: items.length - index`) is not a
    // layer and stays allowed: it has no bare number.
    const violations = sourceFiles(new URL("../", import.meta.url)).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          NUMERIC_Z_CLASS.test(line) || NUMERIC_Z_STYLE.test(line)
            ? [`${file.split("/ui/src/").pop()}:${index + 1}`]
            : [],
        ),
    );
    expect(violations).toEqual([]);
  });
});
