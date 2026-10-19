#!/usr/bin/env node
// Every test file named in tests/release-switch-tests/switch-tests.json must exist.
// A graduated switch whose test was deleted (#740) left a stale entry, and the
// release preview refused rc-2026-10-19.2 for it. Dependency-free, for the guard job.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const map = JSON.parse(readFileSync(join(root, "tests/release-switch-tests/switch-tests.json"), "utf8"));
const switches = map.switches ?? map;
const missing = [];
for (const [name, files] of Object.entries(switches)) {
  if (!Array.isArray(files)) continue;
  for (const f of files) if (!existsSync(join(root, f))) missing.push(`${name}: ${f}`);
}
if (missing.length) {
  console.error(`switch-tests.json names test files that do not exist:\n  ${missing.join("\n  ")}`);
  console.error("Remove or replace them (a graduated switch's deleted test must leave the map too).");
  process.exit(1);
}
console.log(`switch-tests map OK: every named test file exists.`);
