#!/usr/bin/env node
// The GSAM and website contract check (GRE-2633). No dependencies: it runs in
// both repos' CI before anything is installed.
//
//   node contracts/check.mjs                    every file matches manifest.json; no secrets
//   node contracts/check.mjs --write            rehash after a change (gs-agentic-manager only)
//   node contracts/check.mjs --vendor <repo>    copy this folder into <repo>/contracts, pinned to this commit
//   node contracts/check.mjs --site-speaks <n>  the website deploy guard: the site's code speaks contract <n>
//   node contracts/check.mjs --print            the manifest's name, version and minSiteVersion as JSON
//
// The canonical copy lives in gs-agentic-manager. A vendored copy has
// VENDORED.json and must never be edited by hand: the hashes catch it.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MANIFEST = "manifest.json";
const VENDORED = "VENDORED.json";
/** Not hashed: the manifest itself, and the pin a vendored copy adds. */
const UNHASHED = new Set([MANIFEST, VENDORED]);

/** Nothing secret and no real people go in the shared package (Flint checks this too). */
export const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{8,}/, "a live Stripe key"],
  [/\bwhsec_[A-Za-z0-9]{16,}/, "a Stripe webhook secret"],
  [/\bnfp_[A-Za-z0-9]{20,}/, "a Netlify token"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bxox[abp]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/[A-Za-z0-9._%+-]+@(?![A-Za-z0-9.-]*(?:example\.(?:com|org|net|test)|\.test)\b)[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/, "an email address outside example or .test domains"],
];

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function listFiles(dir = ROOT) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(relative(ROOT, path).split(sep).join("/"));
  }
  return out;
}

const hashedFiles = () => listFiles().filter((path) => !UNHASHED.has(path));

/** sha256 of the sorted `path hash` lines: one value that names the whole contract. */
export const contentHashOf = (files) =>
  sha256(Object.keys(files).sort().map((path) => `${path} ${files[path]}\n`).join(""));

function readManifest() {
  return JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
}

/** Every problem with the folder as it is now, or an empty list. */
export function problems() {
  const found = [];
  let manifest;
  try {
    manifest = readManifest();
  } catch (error) {
    return [`${MANIFEST} cannot be read: ${error.message}`];
  }
  for (const key of ["name", "version", "minSiteVersion", "files", "contentHash"]) {
    if (manifest[key] === undefined) found.push(`${MANIFEST} has no "${key}".`);
  }
  if (!(Number.isInteger(manifest.minSiteVersion) && manifest.minSiteVersion >= 1 && manifest.minSiteVersion <= manifest.version)) {
    found.push(`${MANIFEST}: minSiteVersion must be a whole number from 1 to version.`);
  }
  const listed = manifest.files ?? {};
  const present = hashedFiles();
  for (const path of present) {
    const data = readFileSync(join(ROOT, path));
    if (!(path in listed)) found.push(`${path} is not in ${MANIFEST}. Run --write in gs-agentic-manager.`);
    else if (listed[path] !== sha256(data)) found.push(`${path} does not match its hash in ${MANIFEST}: it was edited by hand, or --write was not run.`);
    if (path.endsWith(".json")) {
      try {
        JSON.parse(data.toString("utf8"));
      } catch (error) {
        found.push(`${path} is not valid JSON: ${error.message}`);
      }
    }
    const text = data.toString("utf8");
    for (const [pattern, what] of SECRET_PATTERNS) {
      if (pattern.test(text)) found.push(`${path} holds ${what}. Secrets and client data never go in the contract.`);
    }
  }
  for (const path of Object.keys(listed)) {
    if (!present.includes(path)) found.push(`${path} is in ${MANIFEST} but missing.`);
  }
  if (manifest.contentHash !== undefined && manifest.contentHash !== contentHashOf(listed)) {
    found.push(`${MANIFEST}: contentHash does not match its files. Run --write in gs-agentic-manager.`);
  }
  for (const [surface, spec] of Object.entries(manifest.surfaces ?? {})) {
    for (const ref of [spec?.schema, spec?.fixture].filter((value) => typeof value === "string")) {
      if (!present.includes(ref)) found.push(`surface ${surface} names ${ref}, which is missing.`);
    }
  }
  return found;
}

function write() {
  if (existsSync(join(ROOT, VENDORED))) {
    fail([`This is a vendored copy (${VENDORED}). Change the contract in gs-agentic-manager, then vendor it again.`]);
  }
  const manifest = readManifest();
  const files = Object.fromEntries(hashedFiles().map((path) => [path, sha256(readFileSync(join(ROOT, path)))]));
  manifest.files = files;
  manifest.contentHash = contentHashOf(files);
  writeFileSync(join(ROOT, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${MANIFEST}: ${Object.keys(files).length} files, content ${manifest.contentHash.slice(0, 12)}.`);
}

function vendor(target) {
  const found = problems();
  if (found.length) fail(found);
  if (existsSync(join(ROOT, VENDORED))) fail([`Vendor from gs-agentic-manager, not from a vendored copy.`]);
  const repo = resolve(target);
  if (!existsSync(join(repo, ".git"))) fail([`${repo} is not a git checkout.`]);
  const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--", ".")) fail(["contracts/ has changes that are not committed. Vendor a committed contract only."]);
  const dest = join(repo, "contracts");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(ROOT, dest, { recursive: true });
  const manifest = readManifest();
  const pin = {
    _comment: "Vendored from gs-agentic-manager by contracts/check.mjs --vendor. Do not edit this folder; vendor again instead.",
    source: "Johnprempeh2/gs-agentic-manager",
    commit: git("rev-parse", "HEAD"),
    name: manifest.name,
    version: manifest.version,
    contentHash: manifest.contentHash,
  };
  writeFileSync(join(dest, VENDORED), `${JSON.stringify(pin, null, 2)}\n`);
  console.log(`Vendored ${manifest.name} v${manifest.version} (${pin.commit.slice(0, 12)}) into ${dest}.`);
}

function fail(lines) {
  for (const line of lines) console.error(`contract: ${line}`);
  process.exit(1);
}

function main(argv) {
  const [command, value] = argv;
  if (command === "--write") return write();
  if (command === "--vendor") {
    if (!value) fail(["--vendor needs the website checkout's folder."]);
    return vendor(value);
  }
  const found = problems();
  if (found.length) fail(found);
  const manifest = readManifest();
  if (command === "--print") {
    console.log(JSON.stringify({ name: manifest.name, version: manifest.version, minSiteVersion: manifest.minSiteVersion, contentHash: manifest.contentHash }));
    return;
  }
  if (command === "--site-speaks") {
    const speaks = Number(value);
    if (!Number.isInteger(speaks) || speaks !== manifest.version) {
      fail([`The site's code speaks contract ${value ?? "none"}, but the vendored contract is v${manifest.version}. Make the site speak v${manifest.version} before it deploys.`]);
    }
  } else if (command !== undefined) {
    fail([`Unknown option ${command}.`]);
  }
  const pinned = existsSync(join(ROOT, VENDORED)) ? JSON.parse(readFileSync(join(ROOT, VENDORED), "utf8")) : null;
  if (pinned && (pinned.version !== manifest.version || pinned.contentHash !== manifest.contentHash)) {
    fail([`${VENDORED} names v${pinned.version} ${pinned.contentHash}, but the files are v${manifest.version} ${manifest.contentHash}. Vendor again.`]);
  }
  const where = pinned ? `vendored from ${pinned.commit.slice(0, 12)}` : "canonical";
  console.log(`contract ${manifest.name} v${manifest.version} (${where}): ${Object.keys(manifest.files).length} files match.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
