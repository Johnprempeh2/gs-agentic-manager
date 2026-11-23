#!/usr/bin/env node
// Packs the built checkout into one runnable payload folder (GRE-6097):
// node_modules/gsam (the CLI and the server) and its workspace packages, the
// same steps `gsam install --ref` takes (cli/src/commands/install.ts,
// installGitPayload), but from this checkout instead of a GitHub download.
//
// Run from the repository root after `scripts/build-npm.sh` and the server
// build (scripts/aura-macos/build-package.sh does both).
//
//   node scripts/aura-macos/pack-payload.mjs <payload dir> <scratch dir>

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [payloadArg, scratchArg] = process.argv.slice(2);
if (!payloadArg || !scratchArg) {
  console.error("usage: pack-payload.mjs <payload dir> <scratch dir>");
  process.exit(2);
}
const root = process.cwd();
const payload = path.resolve(payloadArg);
const scratch = path.resolve(scratchArg);
if (fs.existsSync(payload)) throw new Error(`${payload} already exists`);
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

const run = (file, args, opts = {}) => {
  console.log(`  $ ${file} ${args.join(" ")}`);
  execFileSync(file, args, { stdio: "inherit", cwd: root, ...opts, env: { ...process.env, ...opts.env } });
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// Workspace packages the server needs, dependencies first.
const manifest = readJson(path.join(root, "scripts", "release-package-manifest.json"));
const byName = new Map(manifest.map((entry) => [entry.name, entry]));
const ordered = [];
const seen = new Set();
const visit = (name) => {
  if (seen.has(name)) return;
  seen.add(name);
  const entry = byName.get(name);
  if (!entry) throw new Error(`${name} is missing from scripts/release-package-manifest.json`);
  const pkg = readJson(path.join(root, entry.dir, "package.json"));
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const dep of Object.keys(pkg[section] ?? {})) if (dep.startsWith("@greatstone/")) visit(dep);
  }
  ordered.push(entry);
};
visit("@greatstone/server");

for (const [index, entry] of ordered.entries()) {
  const dir = path.join(root, entry.dir);
  const pkg = readJson(path.join(dir, "package.json"));
  const bundled = pkg.bundleDependencies ?? pkg.bundledDependencies ?? [];
  if (bundled.length > 0) {
    const staged = path.join(scratch, `workspace-package-${index}`);
    run(process.execPath, [path.join(root, "scripts", "prepare-bundled-package.mjs"), dir, staged]);
    run("npm", ["pack", staged, "--pack-destination", scratch]);
  } else {
    run("pnpm", ["--dir", entry.dir, "pack", "--pack-destination", scratch], { env: { GSAM_RELEASE_REUSE_UI_DIST: "1" } });
  }
}
run("npm", ["pack", "--pack-destination", scratch], { cwd: path.join(root, "cli") });

const version = readJson(path.join(root, "cli", "package.json")).version;
const tarballs = fs.readdirSync(scratch).filter((name) => name.endsWith(".tgz"));
const cli = tarballs.find((name) => name === `gsam-${version}.tgz`);
const workspace = tarballs.filter((name) => name !== cli);
if (!cli || workspace.length !== ordered.length) {
  throw new Error(`packed ${workspace.length} workspace tarballs and ${cli ? "the" : "no"} CLI; expected ${ordered.length} and the CLI`);
}
fs.mkdirSync(payload, { recursive: true });
run("npm", ["install", "--prefix", payload, path.join(scratch, cli), ...workspace.map((name) => path.join(scratch, name)), "--no-audit", "--no-fund"], { cwd: scratch });

const reported = execFileSync(process.execPath, [path.join(payload, "node_modules", "gsam", "dist", "index.js"), "--version"], { encoding: "utf8" }).trim().split(/\s+/)[0];
if (reported !== version) throw new Error(`payload CLI reports ${reported || "no version"}; expected ${version}`);
console.log(`payload ready: gsam ${version} in ${payload}`);
