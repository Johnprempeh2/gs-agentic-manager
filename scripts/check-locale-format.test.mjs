import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { countLocaleCalls, compare, lowerBaseline, readBaseline, run, scan } from "./check-locale-format.mjs";

function fixture(files) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "locale-format-"));
  const scanRoot = path.join(repoRoot, "ui/src");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(scanRoot, name)), { recursive: true });
    writeFileSync(path.join(scanRoot, name), content);
  }
  mkdirSync(scanRoot, { recursive: true });
  const baselinePath = path.join(repoRoot, "baseline.json");
  const lines = [];
  const exec = (argv = []) => {
    lines.length = 0;
    return run({ argv, scanRoot, repoRoot, baselinePath, log: (l) => lines.push(l) });
  };
  return {
    baselinePath,
    lines,
    exec,
    scanRoot,
    repoRoot,
    write: (name, content) => writeFileSync(path.join(scanRoot, name), content),
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

const ONE = `d.toLocaleDateString("en-GB");`;
const TWO = `d.toLocaleDateString(); n.toLocaleTimeString();`;

test("counts toLocaleString, toLocaleDateString and toLocaleTimeString calls only", () => {
  assert.equal(
    countLocaleCalls(
      `a.toLocaleString(); b.toLocaleDateString("en-GB"); c.toLocaleTimeString ( ); ` +
        `a.toLocaleUpperCase(); x.myToLocaleString(); const s = "toLocaleString";`,
    ),
    3,
  );
});

test("same counts pass", (t) => {
  const f = fixture({ "A.tsx": TWO });
  t.after(f.cleanup);
  assert.equal(f.exec(["--init"]), 0);
  assert.equal(f.exec(), 0);
});

test("count up fails and tells the author which helper to use", (t) => {
  const f = fixture({ "A.tsx": ONE });
  t.after(f.cleanup);
  f.exec(["--init"]);
  f.write("A.tsx", `${ONE} new Date().toLocaleString();`);
  assert.equal(f.exec(), 1);
  const out = f.lines.join("\n");
  assert.match(out, /ui\/src\/A\.tsx: 1 → 2/);
  assert.match(out, /ui\/src\/lib\/utils\.ts/);
  assert.match(out, /formatDate, formatDateTime, formatShortDate/);
});

test("a new file with one call fails (saved count is 0)", (t) => {
  const f = fixture({ "A.tsx": ONE });
  t.after(f.cleanup);
  f.exec(["--init"]);
  f.write("B.tsx", ONE);
  assert.equal(f.exec(), 1);
  assert.match(f.lines.join("\n"), /ui\/src\/B\.tsx: 0 → 1/);
});

test("count down passes, and --update lowers the saved count", (t) => {
  const f = fixture({ "A.tsx": TWO, "B.tsx": ONE });
  t.after(f.cleanup);
  f.exec(["--init"]);
  f.write("A.tsx", `formatDate(d); ${ONE}`);
  f.write("B.tsx", `formatDate(d);`);
  assert.equal(f.exec(), 0);
  assert.match(f.lines.join("\n"), /ui\/src\/A\.tsx: 2 → 1/);

  assert.equal(f.exec(["--update"]), 0);
  assert.deepEqual(readBaseline(f.baselinePath), { "ui/src/A.tsx": 1 });

  // Creeping back up to the old count now fails.
  f.write("A.tsx", TWO);
  assert.equal(f.exec(), 1);
});

test("the shared helpers in ui/src/lib/utils.ts are exempt", (t) => {
  const f = fixture({ "lib/utils.ts": TWO, "lib/other.ts": ONE });
  t.after(f.cleanup);
  assert.deepEqual(scan(f.scanRoot, f.repoRoot), { "ui/src/lib/other.ts": 1 });
  f.exec(["--init"]);
  f.write("lib/utils.ts", `${TWO} ${TWO}`);
  assert.equal(f.exec(), 0);
});

test("--update never raises a saved count", () => {
  const baseline = { "a.tsx": 1, "b.tsx": 3 };
  const current = { "a.tsx": 2, "b.tsx": 1, "c.tsx": 1 };
  assert.deepEqual(lowerBaseline(baseline, current), { "a.tsx": 1, "b.tsx": 1 });
  assert.equal(compare(lowerBaseline(baseline, current), current).increased.length, 2);
});

test("--init refuses to overwrite an existing baseline", (t) => {
  const f = fixture({ "A.tsx": ONE });
  t.after(f.cleanup);
  f.exec(["--init"]);
  const saved = readFileSync(f.baselinePath, "utf8");
  f.write("A.tsx", TWO);
  assert.equal(f.exec(["--init"]), 1);
  assert.equal(readFileSync(f.baselinePath, "utf8"), saved);
});

test("test files are not counted", (t) => {
  const f = fixture({ "A.test.tsx": ONE });
  t.after(f.cleanup);
  assert.deepEqual(scan(f.scanRoot, f.repoRoot), {});
});
