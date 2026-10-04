// Which pull requests need the S2 page-load check before merge (GRE-501).
//
//   node tests/metrics-budgets/s2-paths.mjs --pr <number>     # files from `gh pr diff`
//   node tests/metrics-budgets/s2-paths.mjs --base origin/main # files from git diff base...HEAD
//   git diff --name-only main... | node tests/metrics-budgets/s2-paths.mjs
//
// Prints "S2 page-load check needed: yes|no" and the matching files. Always
// exits 0 when it could read the file list; the answer is in the output.
import { execFileSync } from "node:child_process";

// S2 times the issue detail page and the issues board, served from the built
// UI and the issue API. A change to any of these can move the number, and so
// can a change to the harness or the budgets that judge it.
export const S2_PATH_RULES = [
  { pattern: /^ui\//, why: "UI code" },
  { pattern: /^server\/src\/routes\/issues?[-.][^/]*$/, why: "issue/board API route" },
  { pattern: /^server\/src\/services\/issues\.ts$/, why: "issue list/detail service" },
  { pattern: /^tests\/perf\/issue-detail\//, why: "S2 harness" },
  { pattern: /^tests\/metrics-budgets\/(budgets(\.keystone-host)?\.json|check\.mjs|s2-check\.mjs)$/, why: "S2 budgets/checker" },
];

// Tests, stories and docs inside ui/ and server/ do not reach the page.
const NOT_SHIPPED = /(\.(test|spec|stories)\.[cm]?[jt]sx?$)|(\/__tests__\/)|(\.md$)/;

export function matchS2Path(file) {
  const path = file.trim().replace(/^\.\//, "");
  if (!path) return null;
  const rule = S2_PATH_RULES.find((entry) => entry.pattern.test(path));
  if (!rule) return null;
  if (NOT_SHIPPED.test(path) && !path.startsWith("tests/")) return null;
  return rule.why;
}

export function s2CheckNeeded(files) {
  const matches = files.flatMap((file) => {
    const why = matchS2Path(file);
    return why ? [{ file: file.trim(), why }] : [];
  });
  return { needed: matches.length > 0, matches };
}

async function changedFiles(argv) {
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const pr = flag("pr");
  const base = flag("base");
  if (pr) return execFileSync("gh", ["pr", "diff", pr, "--name-only"], { encoding: "utf8" });
  if (base) return execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  if (process.stdin.isTTY) throw new Error("give --pr <number>, --base <ref>, or a file list on stdin");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { needed, matches } = s2CheckNeeded((await changedFiles(process.argv.slice(2))).split("\n"));
    console.log(`S2 page-load check needed: ${needed ? "yes" : "no"}`);
    for (const match of matches.slice(0, 20)) console.log(`  ${match.file} (${match.why})`);
    if (matches.length > 20) console.log(`  ... and ${matches.length - 20} more`);
    if (needed) console.log("Run: pnpm test:metrics:s2");
  } catch (error) {
    console.error(`S2 path check could not read the changed files: ${error.message}`);
    process.exitCode = 2;
  }
}
