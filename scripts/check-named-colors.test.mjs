import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { countNamedColors, compare, lowerBaseline, readBaseline, run, scan } from "./check-named-colors.mjs";

function fixture(files) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "named-colors-"));
  const scanRoot = path.join(repoRoot, "ui/src");
  mkdirSync(scanRoot, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(scanRoot, name), content);
  }
  const baselinePath = path.join(repoRoot, "baseline.json");
  const lines = [];
  const exec = (argv = []) => {
    lines.length = 0;
    return run({ argv, scanRoot, repoRoot, baselinePath, log: (l) => lines.push(l) });
  };
  return {
    repoRoot,
    scanRoot,
    baselinePath,
    lines,
    exec,
    write: (name, content) => writeFileSync(path.join(scanRoot, name), content),
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

test("counts palette classes with variants and opacity, ignores tokens and lookalikes", () => {
  const counts = countNamedColors(
    `<div className="bg-amber-100 dark:text-red-600 hover:border-zinc-800/50 border-t-sky-500 ` +
      `bg-status-warning text-muted-foreground bg-white text-red-6000 my-bg-red-500 bg-red-500-x" />`,
  );
  assert.deepEqual(counts, {
    "bg-amber-100": 1,
    "text-red-600": 1,
    "border-zinc-800/50": 1,
    "border-t-sky-500": 1,
  });
});

test("same counts pass", (t) => {
  const f = fixture({ "A.tsx": `"bg-amber-100 text-amber-900"` });
  t.after(f.cleanup);
  assert.equal(f.exec(["--init"]), 0);
  assert.equal(f.exec(), 0);
});

test("adding one named colour class fails and names the file and class", (t) => {
  const f = fixture({ "A.tsx": `"bg-amber-100 text-amber-900"` });
  t.after(f.cleanup);
  f.exec(["--init"]);
  f.write("A.tsx", `"bg-amber-100 text-amber-900 border-amber-300"`);
  assert.equal(f.exec(), 1);
  const out = f.lines.join("\n");
  assert.match(out, /ui\/src\/A\.tsx: 2 → 3/);
  assert.match(out, /border-amber-300 \(0 → 1\)/);
});

test("a new file with a named colour class fails (saved count is 0)", (t) => {
  const f = fixture({ "A.tsx": `"bg-amber-100"` });
  t.after(f.cleanup);
  f.exec(["--init"]);
  f.write("B.tsx", `"text-rose-500"`);
  assert.equal(f.exec(), 1);
  assert.match(f.lines.join("\n"), /ui\/src\/B\.tsx: 0 → 1/);
});

test("swapping one class for another at the same total passes", (t) => {
  const f = fixture({ "A.tsx": `"bg-amber-100"` });
  t.after(f.cleanup);
  f.exec(["--init"]);
  f.write("A.tsx", `"bg-amber-200"`);
  assert.equal(f.exec(), 0);
});

test("removing classes passes, and --update lowers the saved count", (t) => {
  const f = fixture({ "A.tsx": `"bg-amber-100 text-amber-900"`, "B.tsx": `"bg-red-50"` });
  t.after(f.cleanup);
  f.exec(["--init"]);
  f.write("A.tsx", `"bg-status-warning text-amber-900"`);
  f.write("B.tsx", `"bg-destructive"`);
  assert.equal(f.exec(), 0);
  assert.match(f.lines.join("\n"), /ui\/src\/A\.tsx: 2 → 1/);

  assert.equal(f.exec(["--update"]), 0);
  assert.deepEqual(readBaseline(f.baselinePath), { "ui/src/A.tsx": { "text-amber-900": 1 } });

  // Creeping back up to the old count now fails.
  f.write("A.tsx", `"bg-amber-100 text-amber-900"`);
  assert.equal(f.exec(), 1);
});

test("--update never raises a saved count", () => {
  const baseline = { "a.tsx": { "bg-red-500": 1 }, "b.tsx": { "bg-red-500": 3 } };
  const current = { "a.tsx": { "bg-red-500": 2 }, "b.tsx": { "bg-red-500": 1 }, "c.tsx": { "bg-red-500": 1 } };
  assert.deepEqual(lowerBaseline(baseline, current), {
    "a.tsx": { "bg-red-500": 1 },
    "b.tsx": { "bg-red-500": 1 },
  });
  assert.equal(compare(lowerBaseline(baseline, current), current).increased.length, 2);
});

test("--init refuses to overwrite an existing baseline", (t) => {
  const f = fixture({ "A.tsx": `"bg-amber-100"` });
  t.after(f.cleanup);
  f.exec(["--init"]);
  const saved = readFileSync(f.baselinePath, "utf8");
  f.write("A.tsx", `"bg-amber-100 bg-amber-200"`);
  assert.equal(f.exec(["--init"]), 1);
  assert.equal(readFileSync(f.baselinePath, "utf8"), saved);
});

test("test files are not counted", (t) => {
  const f = fixture({ "A.test.tsx": `"bg-amber-100"` });
  t.after(f.cleanup);
  assert.deepEqual(scan(f.scanRoot, f.repoRoot), {});
});
