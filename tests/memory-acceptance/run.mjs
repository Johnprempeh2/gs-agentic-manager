#!/usr/bin/env node
// Organization memory acceptance runner: phase 1 (GRE-675), phase 2 (GRE-888) and phase 3 (GRE-866).
//
//   node tests/memory-acceptance/run.mjs                      # test double, phases 1 to 3
//   node tests/memory-acceptance/run.mjs --phase 2            # phase 2 exit tests only
//   node tests/memory-acceptance/run.mjs --phase 3            # phase 3 graph and contribution tests only
//   node tests/memory-acceptance/run.mjs --break engine-open  # prove the tests can fail
//   MEMORY_ACCEPTANCE_LIVE_CONFIG=path node tests/memory-acceptance/run.mjs --target live
//
// Exit code 0 only when every selected test passes. Inconclusive counts as not passed.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { createDoubleTarget, FAULTS } from "./lib/double.mjs";
import { loadFixtures } from "./lib/fixtures.mjs";
import { createGsamTarget, loadGsamConfig } from "./lib/gsam.mjs";
import { createLiveTarget, loadLiveConfig } from "./lib/live.mjs";
import { formatReport } from "./lib/report.mjs";
import { runAll } from "./lib/tests.mjs";

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "double" },
    break: { type: "string", multiple: true, default: [] },
    only: { type: "string" },
    phase: { type: "string", default: "all" },
    json: { type: "string" },
    verbose: { type: "boolean", short: "v", default: false },
    "list-faults": { type: "boolean", default: false },
    "prime-org": { type: "boolean", default: false },
  },
});

if (values["list-faults"]) {
  for (const [k, v] of Object.entries(FAULTS)) console.log(`${k.padEnd(22)} ${v}`);
  process.exit(0);
}

const { world, scenarios, graph } = loadFixtures();
let target;
if (values.target === "double") {
  target = createDoubleTarget({ world, faults: values.break });
} else if (values.target === "live") {
  if (values.break.length) throw new Error("--break applies to the test double only");
  target = createLiveTarget(loadLiveConfig(process.env.MEMORY_ACCEPTANCE_LIVE_CONFIG));
} else if (values.target === "gsam") {
  if (values.break.length) throw new Error("--break applies to the test double only");
  target = createGsamTarget(loadGsamConfig(process.env.MEMORY_ACCEPTANCE_GSAM_CONFIG), { world, primeOrg: values["prime-org"] });
} else {
  throw new Error(`Unknown --target ${values.target} (double | live | gsam)`);
}

const phases = { all: [1, 2, 3], 1: [1], 2: [2], 3: [3] }[values.phase];
if (!phases) throw new Error(`Unknown --phase ${values.phase} (1 | 2 | 3 | all)`);
const report = await runAll(target, { scenarios, graph, only: values.only?.split(","), phases });
report.generatedAt = new Date().toISOString();
console.log(formatReport(report, { verbose: values.verbose }));

if (values.json) {
  mkdirSync(dirname(values.json), { recursive: true });
  writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nJSON report: ${values.json}`);
}

process.exit(report.results.every((r) => r.status === "pass") ? 0 : 1);
