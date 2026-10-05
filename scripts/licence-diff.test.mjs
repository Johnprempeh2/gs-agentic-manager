// Tests for scripts/licence-diff.mjs (GRE-624), on two fixed
// `pnpm licenses ls --json` samples.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classify, diff } from "./licence-diff.mjs";

const SCRIPT = new URL("./licence-diff.mjs", import.meta.url).pathname;
const pkg = (name, versions, license) => ({ name, versions, paths: [], license, author: "x" });

const BASE = {
  MIT: [pkg("left-pad", ["1.0.0"], "MIT"), pkg("relicensed", ["1.0.0"], "MIT")],
  ISC: [pkg("bumped", ["1.0.0"], "ISC")],
};
const HEAD = {
  MIT: [pkg("left-pad", ["1.0.0"], "MIT"), pkg("brand-new", ["2.1.0"], "MIT")],
  ISC: [pkg("bumped", ["1.1.0"], "ISC")],
  "GPL-3.0": [pkg("relicensed", ["2.0.0"], "GPL-3.0")],
  Unknown: [pkg("no-licence", ["0.1.0"], undefined)],
};

test("new MIT is ok, licence change to GPL-3.0 and no licence are check", () => {
  const rows = diff(BASE, HEAD);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(by).sort(), ["brand-new", "no-licence", "relicensed"]);
  assert.equal(by["brand-new"].mark, "ok");
  assert.equal(by["brand-new"].change, "new");
  assert.equal(by.relicensed.mark, "check");
  assert.equal(by.relicensed.change, "changed, was MIT");
  assert.equal(by["no-licence"].mark, "check");
  // Unchanged and same-licence version bumps are not listed; check lines come first.
  assert.deepEqual(rows.map((r) => r.mark), ["check", "check", "ok"]);
});

test("classify reads SPDX expressions", () => {
  for (const id of ["MIT", "ISC", "BSD-3-Clause", "Apache-2.0", "0BSD", "(MIT OR GPL-3.0)", "(MIT AND Zlib)", "Apache-2.0 WITH LLVM-exception"]) {
    assert.equal(classify(id), "ok", id);
  }
  for (const id of ["GPL-3.0", "AGPL-3.0-only", "LGPL-2.1", "SSPL-1.0", "BUSL-1.1", "Unknown", "", undefined, "SEE LICENSE IN LICENSE.md", "(MIT AND GPL-2.0)", "CC-BY-NC-4.0"]) {
    assert.equal(classify(id), "check", String(id));
  }
});

test("CLI prints the report and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-licence-diff-"));
  try {
    writeFileSync(join(dir, "base.json"), JSON.stringify(BASE));
    writeFileSync(join(dir, "head.json"), JSON.stringify(HEAD));
    const r = spawnSync("node", [SCRIPT, join(dir, "base.json"), join(dir, "head.json"), "a", "b"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      [
        "Licence diff a -> b: 3 new or changed, 2 to check.",
        "check  no-licence@0.1.0  Unknown  (new)",
        "check  relicensed@2.0.0  GPL-3.0  (changed, was MIT)",
        "ok     brand-new@2.1.0  MIT  (new)",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
