#!/usr/bin/env node
// Organization memory phase 1 acceptance runner (GRE-675).
//
//   node tests/memory-acceptance/run.mjs                      # test double, all 11 tests
//   node tests/memory-acceptance/run.mjs --break engine-open  # prove the tests can fail
//   MEMORY_ACCEPTANCE_LIVE_CONFIG=path node tests/memory-acceptance/run.mjs --target live
//
// Exit code 0 only when every selected test passes. Inconclusive counts as not passed.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { createDoubleTarget, FAULTS } from "./lib/double.mjs";
import { loadFixtures } from "./lib/fixtures.mjs";
import { createLiveTarget, loadLiveConfig } from "./lib/live.mjs";
import { formatReport } from "./lib/report.mjs";
import { runAll } from "./lib/tests.mjs";

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "double" },
    break: { type: "string", multiple: true, default: [] },
    only: { type: "string" },
    json: { type: "string" },
    verbose: { type: "boolean", short: "v", default: false },
    "list-faults": { type: "boolean", default: false },
  },
});

if (values["list-faults"]) {
  for (const [k, v] of Object.entries(FAULTS)) console.log(`${k.padEnd(22)} ${v}`);
  process.exit(0);
}

const { world, scenarios } = loadFixtures();
let target;
if (values.target === "double") {
  target = createDoubleTarget({ world, faults: values.break });
} else if (values.target === "live") {
  if (values.break.length) throw new Error("--break applies to the test double only");
  target = createLiveTarget(loadLiveConfig(process.env.MEMORY_ACCEPTANCE_LIVE_CONFIG));
} else {
  throw new Error(`Unknown --target ${values.target} (double | live)`);
}

const report = await runAll(target, { scenarios, only: values.only?.split(",") });
report.generatedAt = new Date().toISOString();
console.log(formatReport(report, { verbose: values.verbose }));

if (values.json) {
  mkdirSync(dirname(values.json), { recursive: true });
  writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nJSON report: ${values.json}`);
}

process.exit(report.results.every((r) => r.status === "pass") ? 0 : 1);
