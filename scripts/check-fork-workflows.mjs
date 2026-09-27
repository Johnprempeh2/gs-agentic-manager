#!/usr/bin/env node
/**
 * check-fork-workflows.mjs
 *
 * Fails when .github/workflows/ holds a workflow this fork does not own, or is
 * missing one it does.
 *
 * Upstream's workflows publish to its npm scope and container registry, route
 * to its AWS runner fleets and call its trusted PR workflow by reference. On
 * this fork they fail or act on infrastructure we do not own, so they are
 * deleted, not adapted. A merge from upstream brings them back in two ways:
 *
 *   - a workflow upstream edited comes back as a modify/delete conflict:
 *     resolve it with `git rm`;
 *   - a workflow upstream added merges in cleanly and silently: this check is
 *     what catches it.
 *
 * Run it after every upstream merge, beside `greatstone-rebrand.mjs --check`,
 * and before pushing. GitHub runs a workflow from the pushed commit itself, so
 * CI flagging it after the push is already too late. To keep a workflow on
 * purpose, add its file name to FORK_WORKFLOWS.
 *
 *   node scripts/check-fork-workflows.mjs
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = ".github/workflows";

export const FORK_WORKFLOWS = ["fork-ci.yml", "metric-budgets.yml"];

let present = [];
try {
  present = readdirSync(path.join(ROOT, WORKFLOWS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => entry.name);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const unexpected = present.filter((name) => !FORK_WORKFLOWS.includes(name)).sort();
const missing = FORK_WORKFLOWS.filter((name) => !present.includes(name));

if (unexpected.length === 0 && missing.length === 0) {
  console.log(`check-fork-workflows: clean (${FORK_WORKFLOWS.join(", ")})`);
  process.exit(0);
}

const paths = (names) => names.map((name) => `${WORKFLOWS_DIR}/${name}`);

if (unexpected.length > 0) {
  console.error(`check-fork-workflows: ${unexpected.length} workflow(s) this fork does not own:`);
  for (const file of paths(unexpected)) console.error(`  ${file}`);
  console.error("Remove them before pushing (GitHub runs a workflow from the pushed commit itself):");
  console.error(`  git rm ${paths(unexpected).join(" ")}`);
  console.error("To keep one on purpose, add it to FORK_WORKFLOWS in scripts/check-fork-workflows.mjs.");
}
if (missing.length > 0) {
  console.error(`check-fork-workflows: fork workflow(s) missing: ${paths(missing).join(", ")}`);
}
process.exit(1);
