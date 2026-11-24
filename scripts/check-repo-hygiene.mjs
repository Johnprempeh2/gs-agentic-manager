#!/usr/bin/env node
// The repository is public (GRE-6164). Refuse new secrets and client or people
// names, checking only the lines a change adds: never the whole tree or the
// history, so it stays well under a second on any pull request.
//
//   node scripts/check-repo-hygiene.mjs --base HEAD^1   the lines added since a commit (CI)
//   node scripts/check-repo-hygiene.mjs --staged        the lines staged for commit (pre-commit hook)
//   node scripts/check-repo-hygiene.mjs --hash "Name"   the line to add to the blocklist for a name
//
// Names are kept as SHA-256 hashes (scripts/repo-hygiene/blocklist.sha256), so the
// list does not itself say who our clients are. Every 1 to 4 word run of an added
// line is hashed and looked up. A real fixture that must keep a match is listed
// with its reason in scripts/repo-hygiene/allow.json, which a reviewer approves.
// Findings print the file, line and rule with the match redacted. Dependency-free
// so the always-on CI guard job can run it.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BLOCKLIST_FILE = join(HERE, "repo-hygiene/blocklist.sha256");
export const ALLOW_FILE = join(HERE, "repo-hygiene/allow.json");
const HASH_PREFIX = "gsam-hygiene-v1:";
const MAX_WORDS = 4;

/** Secret patterns, a small gitleaks-style set: the providers this company holds keys for. */
export const SECRET_RULES = [
  { id: "private-key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { id: "anthropic-key", re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{40,}/ },
  { id: "openai-key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}/ },
  { id: "stripe-key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { id: "slack-token", re: /\bxox[abposr]-\d{6,}-\d{6,}-[A-Za-z0-9-]{10,}/ },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "netlify-token", re: /\bnfp_[A-Za-z0-9]{36,}\b/ },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  // A password in a connection URL, unless it is a local development database.
  {
    id: "url-password",
    re: /\b[a-z][a-z0-9+.-]*:\/\/([^\s:@/"'`]+):([^\s:@/"'`$<>{}\[\]]{8,})@([^\s:/"'`]+)/i,
    value: 2,
    skip: (m) =>
      m[1] === m[2] ||
      /^(password|postgres|paperclip)$/i.test(m[2]) ||
      /^(localhost|127\.0\.0\.1|0\.0\.0\.0|db|postgres|host)$|(^|\.)example(\.|$)|\.(test|invalid|internal|local)$/i.test(m[3]),
  },
  // A long random value assigned to a key, token, secret or password. Readable words, UUIDs and sentinels pass.
  {
    id: "generic-secret",
    re: /\b(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret|access[_-]?key)\w*["']?\s*[:=]\s*["'`]([A-Za-z0-9+/_.=-]{20,})["'`]/i,
    value: 1,
    skip: (m) => !randomLooking(m[1]),
  },
];

/** At least 20 letters and digits in one unbroken run, mixing both, with high entropy: how real keys look. */
function randomLooking(value) {
  const longest = value.split(/[^A-Za-z0-9]+/).reduce((a, b) => (b.length > a.length ? b : a), "");
  return longest.length >= 20 && /\d/.test(longest) && /[A-Za-z]/.test(longest) && entropy(longest) >= 3.5;
}

// Words and runs a made-up fixture uses and a real key does not.
const PLACEHOLDER = /example|placeholder|dummy|fake|sample|test|synthetic|sentinel|marker|canary|secret|xxxx|abcdef|123456|changeme|redacted|your[_-]|<|\$\{|\.\.\./i;

/** Shannon entropy in bits per character. */
function entropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

export function hashName(name) {
  const words = wordsOf(name)[0];
  return createHash("sha256").update(HASH_PREFIX + words.join(" ")).digest("hex");
}

/** Two word sequences for a line: split on anything not a letter or digit, and also at camelCase joins. */
function wordsOf(text) {
  // Base64 and hex blobs make short accidental words; they are never a name.
  text = text.replace(/[A-Za-z0-9+/=_-]{40,}/g, " ");
  const plain = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const camel = text.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return camel.join(" ") === plain.join(" ") ? [plain] : [plain, camel];
}

export function loadBlocklist(file = BLOCKLIST_FILE) {
  const hashes = new Set();
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (/^[0-9a-f]{64}$/.test(line)) hashes.add(line);
  }
  return hashes;
}

/** Entries: { path, rule, reason }. `path` ends in `/` for a folder or `*` for a prefix; `rule` is a secret rule id, "name" or "*". */
export function loadAllow(file = ALLOW_FILE) {
  const entries = JSON.parse(readFileSync(file, "utf8")).entries ?? [];
  for (const entry of entries) {
    if (!entry.path || !entry.rule || !String(entry.reason ?? "").trim()) {
      throw new Error(`allow.json: every entry needs path, rule and reason (${JSON.stringify(entry)})`);
    }
  }
  return entries;
}

function allowed(allow, path, rule) {
  return allow.some((entry) => {
    const pathMatch = entry.path.endsWith("*") || entry.path.endsWith("/")
      ? path.startsWith(entry.path.replace(/\*$/, ""))
      : path === entry.path;
    return pathMatch && (entry.rule === "*" || entry.rule === rule);
  });
}

/** The added lines of a unified diff: { path, line, text }. */
export function addedLines(diff) {
  const out = [];
  let path = null;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).replace(/\t.*$/, "");
      path = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("diff --git ")) { path = null; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!path) continue;
    if (raw.startsWith("+")) { out.push({ path, line, text: raw.slice(1) }); line += 1; }
    else if (raw.startsWith(" ")) line += 1;
  }
  return out;
}

function redact(value) {
  return value.length <= 4 ? "*".repeat(value.length) : `${value.slice(0, 2)}${"*".repeat(Math.min(value.length - 2, 12))}`;
}

/** Hygiene findings for a diff: { path, line, rule, match } with the match already redacted. */
export function checkDiff(diff, { blocklist = loadBlocklist(), allow = loadAllow() } = {}) {
  const findings = [];
  const own = new Set(["scripts/repo-hygiene/blocklist.sha256", "scripts/repo-hygiene/allow.json"]);
  for (const { path, line, text } of addedLines(diff)) {
    if (own.has(path)) continue;
    for (const rule of SECRET_RULES) {
      const match = rule.re.exec(text);
      if (!match) continue;
      const value = match[rule.value ?? 0];
      if (PLACEHOLDER.test(value) || rule.skip?.(match)) continue;
      if (allowed(allow, path, rule.id)) continue;
      // One secret per line: the specific rules come first, so generic-secret does not repeat them.
      findings.push({ path, line, rule: rule.id, match: redact(value) });
      break;
    }
    if (blocklist.size === 0 || allowed(allow, path, "name")) continue;
    const hit = blocklistedRun(text, blocklist);
    if (hit) findings.push({ path, line, rule: "name", match: redact(hit) });
  }
  return findings;
}

// Most runs repeat across a diff; remember each run's answer instead of hashing it again.
const runCache = new Map();

function blocklistedRun(text, blocklist) {
  for (const words of wordsOf(text)) {
    for (let i = 0; i < words.length; i += 1) {
      for (let n = 1; n <= MAX_WORDS && i + n <= words.length; n += 1) {
        const run = words.slice(i, i + n).join(" ");
        let hit = runCache.get(run);
        if (hit === undefined) {
          hit = blocklist.has(createHash("sha256").update(HASH_PREFIX + run).digest("hex"));
          if (runCache.size > 500_000) runCache.clear();
          runCache.set(run, hit);
        }
        if (hit) return run;
      }
    }
  }
  return null;
}

function gitDiff(args) {
  const result = spawnSync("git", ["diff", "--no-color", "--no-ext-diff", "-U0", "--diff-filter=d", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git diff ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  if (argv.includes("--hash")) {
    console.log(`${hashName(flag("--hash") ?? "")}`);
    return 0;
  }
  let diff;
  if (argv.includes("--staged")) diff = gitDiff(["--cached"]);
  else if (flag("--base")) diff = gitDiff([flag("--base"), "HEAD"]);
  else if (flag("--diff-file")) diff = readFileSync(flag("--diff-file"), "utf8");
  else {
    console.error("usage: check-repo-hygiene.mjs --base <ref> | --staged | --diff-file <path> | --hash <name>");
    return 2;
  }
  const findings = checkDiff(diff);
  for (const f of findings) {
    const what = f.rule === "name" ? "a blocklisted client or person name" : `a possible secret (${f.rule})`;
    console.error(`${f.path}:${f.line}: ${what}: ${f.match}`);
  }
  if (findings.length === 0) {
    console.log("repo hygiene: no secrets or blocklisted names in the added lines.");
    return 0;
  }
  console.error(
    `\nrepo hygiene: ${findings.length} finding(s). Use a neutral fixture (Acme, Ada Example, example.com) or move the ` +
      "secret out of the code. A real fixture that must stay goes in scripts/repo-hygiene/allow.json with a reason.",
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
