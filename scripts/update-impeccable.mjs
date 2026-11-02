#!/usr/bin/env node
/**
 * Refresh the vendored Impeccable live-mode page scripts (Apache-2.0,
 * github.com/pbakaus/impeccable) that GSAM's live editor runs.
 *
 * Usage, from an Impeccable checkout at the release you want:
 *   1. Start its helper in any project: `impeccable live` (note the token).
 *   2. node scripts/update-impeccable.mjs --checkout <impeccable dir> --token <token> [--port 8400]
 *
 * It copies LICENSE and NOTICE, splits the served live.js into the globals
 * GSAM needs and the page-script body, records the upstream commit, and
 * lists every helper endpoint the new scripts call. GSAM answers only the
 * endpoints in KNOWN_ENDPOINTS (server/src/services/impeccable-helper.ts); a
 * new one means the helper stand-in needs work before the update ships.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.checkout || !args.token) {
  console.error("usage: update-impeccable.mjs --checkout <impeccable dir> --token <helper token> [--port 8400]");
  process.exit(1);
}
const port = args.port ?? "8400";

// Apache-2.0 asks that changed files say so. This is the only change GSAM makes to the skill.
const GSAM_NOTE = `> **In GS Agentic Manager (modified by Greatstone):** the \`scripts/impeccable\` launcher is not installed. Take the "Launcher unavailable" path below: read PRODUCT.md and DESIGN.md at your workspace root directly (write them first if they are missing; Greatstone brand by default, the client's brand for client work). Live mode runs through GSAM's live design editor, which gives you its own instructions; do not run \`impeccable live\`.
`;
const out = path.resolve(import.meta.dirname, "../server/src/built-ins/impeccable");
mkdirSync(out, { recursive: true });

const res = await fetch(`http://localhost:${port}/live.js?token=${encodeURIComponent(args.token)}`);
if (!res.ok) throw new Error(`helper answered ${res.status}`);
const served = await res.text();
const firstPart = served.indexOf("// --- impeccable live script part:");
if (firstPart < 0) throw new Error("no script parts in live.js; the helper format changed");

// Keep only the globals that describe the UI, not this machine's token, port or paths.
const globals = {};
for (const line of served.slice(0, firstPart).split("\n")) {
  const m = line.match(/^window\.(__IMPECCABLE_(VOCAB|LIVE_UI_SURFACES|LIVE_MOUNT_CONTRACT)__) = (.*);$/);
  if (m) globals[m[1]] = JSON.parse(m[3]);
}
for (const key of ["__IMPECCABLE_VOCAB__", "__IMPECCABLE_LIVE_UI_SURFACES__", "__IMPECCABLE_LIVE_MOUNT_CONTRACT__"]) {
  if (!(key in globals)) throw new Error(`missing ${key} in live.js`);
}
const body = served.slice(firstPart);
writeFileSync(path.join(out, "live-browser.js"), body);
writeFileSync(path.join(out, "globals.json"), `${JSON.stringify(globals, null, 2)}\n`);
copyFileSync(path.join(args.checkout, "LICENSE"), path.join(out, "LICENSE"));
// modern-screenshot (MIT, its licence in modern-screenshot.LICENSE) as Impeccable bundles it, for annotation screenshots.
copyFileSync(path.join(args.checkout, "skill/scripts/modern-screenshot.umd.js"), path.join(out, "modern-screenshot.umd.js"));
copyFileSync(path.join(args.checkout, "NOTICE.md"), path.join(out, "NOTICE.md"));
const commit = execFileSync("git", ["-C", args.checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const version = JSON.parse(execFileSync("cat", [path.join(args.checkout, "package.json")], { encoding: "utf8" })).version;
writeFileSync(path.join(out, "VERSION"), `impeccable ${version} ${commit}\nhttps://github.com/pbakaus/impeccable\n`);

// The design skill every GSAM agent carries: SKILL.md and its references, not the launcher binary.
const skillSrc = path.join(args.checkout, ".claude/skills/impeccable");
const skillOut = path.resolve(import.meta.dirname, "../skills/impeccable");
rmSync(skillOut, { recursive: true, force: true });
cpSync(path.join(skillSrc, "reference"), path.join(skillOut, "reference"), { recursive: true });
copyFileSync(path.join(args.checkout, "LICENSE"), path.join(skillOut, "LICENSE"));
copyFileSync(path.join(args.checkout, "NOTICE.md"), path.join(skillOut, "NOTICE.md"));
const skill = readFileSync(path.join(skillSrc, "SKILL.md"), "utf8");
const frontEnd = skill.indexOf("\n---", 3) + 4;
writeFileSync(
  path.join(skillOut, "SKILL.md"),
  `${skill.slice(0, frontEnd)}\n\n${GSAM_NOTE}${skill.slice(frontEnd)}`,
);

const endpoints = [...new Set([...body.matchAll(/'http:\/\/localhost:' \+ PORT \+ '(\/[a-z0-9.\-/]+)/gi)].map((m) => m[1]))].sort();
console.log(`Vendored impeccable ${version} (${commit.slice(0, 7)}): ${(body.length / 1024).toFixed(0)} KB.`);
console.log(`Helper endpoints the page scripts call:\n  ${endpoints.join("\n  ")}`);
console.log("Compare with KNOWN_ENDPOINTS in server/src/services/impeccable-helper.ts before shipping.");
