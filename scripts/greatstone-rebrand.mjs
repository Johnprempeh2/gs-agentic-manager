#!/usr/bin/env node
/**
 * greatstone-rebrand.mjs
 *
 * Rebrands the Paperclip fork as GS Agentic Manager. Mechanical, ordered,
 * idempotent: running it twice changes nothing the second time. Re-run it
 * after merging anything from upstream, then `pnpm install` to relink the
 * renamed workspace scope.
 *
 *   node scripts/greatstone-rebrand.mjs          apply
 *   node scripts/greatstone-rebrand.mjs --check  exit 1 if anything is left to rename
 *
 * The runner package checks generated artefacts against their sources, and the
 * rename changes text inside those sources. After a run, regenerate them:
 *
 *   pnpm --filter @greatstone/paperclip-runner run generate:protocol-manifest
 *   pnpm --filter @greatstone/paperclip-runner run generate:protocol-types
 *   pnpm --filter @greatstone/paperclip-runner run generate:semantic-contracts
 *   pnpm --filter @greatstone/paperclip-runner run generate:protocol-coverage
 *   pnpm --filter @greatstone/paperclip-runner run generate:replay-goldens
 *   pnpm --filter @greatstone/paperclip-runner run generate:semantic-action-catalog
 *
 * and if check:capability-inventory reports moved skill-heading slugs, rename
 * `paperclip-*` slug ids in spec/capability/capabilities.yaml to match.
 *
 * What it renames (and deliberately does not):
 *   R0  lucide's `Paperclip` attachment ICON is re-imported as `PaperclipIcon`
 *       first, so R5 cannot mistake a code identifier for the product name.
 *   R1  package scope        @paperclipai/*   -> @greatstone/*
 *   R2  CLI command          paperclipai      -> gsam
 *       NOT: GitHub org logins, ghcr.io image names, github.com URLs, or the
 *       `paperclipai/bundled` / `paperclipai:bundled` catalogue keys (those are
 *       persisted identifiers and upstream-hosted artefacts).
 *   R3  env vars             PAPERCLIP_*      -> GSAM_*
 *       External runtimes still read the old names; the compatibility bridge in
 *       packages/shared/src/legacy-env.ts mirrors them at every boundary.
 *   R4  data folder          .paperclip       -> .gsam   (~/.paperclip, repo-local .paperclip/)
 *   R5  product name         Paperclip        -> GS Agentic Manager
 *                            Paperclip/1.0    -> GSAM/1.0 (single-token contexts)
 *       NOT: "Paperclip Cloud" / "Enterprise" / "Labs" / "AI" (upstream's own
 *       hosted service and company, which this fork still talks to), copyright
 *       lines, X-Paperclip-* HTTP header names (wire protocol), or identifiers
 *       such as `PaperclipLockup` / `managedByPaperclip`.
 *   R6  repository metadata  package.json repository/homepage/bugs -> this fork.
 *   R7  legibility (ui/ only) text-muted-foreground/NN -> text-subtle-foreground,
 *                            text-foreground/55|60     -> text-muted-foreground
 *       Greatstone rule: de-emphasise text with a colour token, never with alpha.
 *
 * Out of scope on purpose: internal lowercase identifiers (paths, CSS classes,
 * storage keys, MCP/tool names, Rust crate names) and file names. They are never
 * shown to users, and renaming ~37k of them would buy risk and nothing else.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

export const BRAND = {
  productName: "GS Agentic Manager",
  shortName: "GSAM", // where a single token is required (User-Agent product tokens)
  scope: "@greatstone/",
  cli: "gsam",
  envPrefix: "GSAM_",
  dataDir: ".gsam",
  repoUrl: "https://github.com/Johnprempeh2/GS-Clip",
};

/** Paths never touched: history, third-party notices, generated lockfiles. */
const EXCLUDE = [
  /^pnpm-lock\.yaml$/,
  /(^|\/)LICENSE(\.[a-z]+)?$/i,
  /(^|\/)NOTICE(\.md)?$/i,
  /(^|\/)PROVENANCE\.md$/,
  /(^|\/)CHANGELOG\.md$/i,
  /^releases\//,
  /^packages\/db\/src\/migrations\//,
  /^skills-releases\//, // frozen skill snapshots: servers refuse a seeded release whose hash changed
  /^\.github\//, // upstream CI wired to paperclipai infrastructure; reworked separately
  /^scripts\/greatstone-rebrand\.mjs$/,
  /^README\.md$/, // hand-written for the fork; names Paperclip on purpose (attribution, bridge)
  /^packages\/shared\/src\/legacy-env(\.test)?\.ts$/, // the bridge must keep the old names
  /^ui\/public\/fonts\/NOTICE\.md$/,
];

const TEXT_MAX_BYTES = 4 * 1024 * 1024;

function listFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.toString("utf8").split("\0").filter(Boolean);
}

function isText(buf) {
  const probe = buf.subarray(0, 8192);
  return !probe.includes(0);
}

const counts = Object.fromEntries(["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7"].map((k) => [k, 0]));

function sub(text, re, replacement, key) {
  if (typeof replacement === "string") {
    // Keep native `$1` expansion: a function wrapper would return it literally.
    counts[key] += text.match(re)?.length ?? 0;
    return text.replace(re, replacement);
  }
  return text.replace(re, (...args) => {
    counts[key] += 1;
    return replacement(...args);
  });
}

// R2 guards: a GitHub org login is data about upstream's repo, not our CLI.
const GITHUB_LOGIN_LINE = /(login|owner|org|organization)\s*:\s*\{?\s*(login\s*:\s*)?["'`]paperclipai["'`]/;

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// R5 never renames these phrases: they name upstream's company and hosted service.
const UPSTREAM_NAMES = /^ (Cloud|Enterprise|Labs|AI)\b/;

function rebrand(file, text) {
  let next = text;

  // R0: lucide-react's Paperclip icon -> its PaperclipIcon alias.
  if (/from\s+["']lucide-react["']/.test(next) && /\bPaperclip\b/.test(next)) {
    next = next.replace(/import\s*\{[^}]*\}\s*from\s*["']lucide-react["']/g, (stmt) =>
      stmt.replace(/(?<![\w$])Paperclip(?![\w$])/g, () => {
        counts.R0 += 1;
        return "PaperclipIcon";
      }),
    );
    next = sub(next, /<(\/?)Paperclip(?=[\s/>])/g, "<$1PaperclipIcon", "R0");
    next = sub(next, /(\b[Ii]con\s*[:=]\s*\{?\s*)Paperclip(?![\w$])/g, "$1PaperclipIcon", "R0");
    next = sub(next, /\{\s*Paperclip\s*\}/g, "{PaperclipIcon}", "R0");
  }

  // R1: workspace package scope.
  next = sub(next, /@paperclipai\//g, BRAND.scope, "R1");

  // R2: CLI command / npm package name, line by line so GitHub-org lines are skipped.
  next = next
    .split("\n")
    .map((line) =>
      GITHUB_LOGIN_LINE.test(line)
        ? line
        : sub(line, /(?<![@\w./-])paperclipai(?![\w/:.-])/g, BRAND.cli, "R2"),
    )
    .join("\n");

  // R3: environment variables and constants.
  next = sub(next, /PAPERCLIP_/g, BRAND.envPrefix, "R3");

  // R4: the data folder, only where it is a path segment on its own.
  next = sub(next, /(?<=^|["'`~/\s(=:])\.paperclip(?=["'`/)\s,;]|$)/gm, BRAND.dataDir, "R4");

  // R5: the product name as a standalone word.
  next = next
    .split("\n")
    .map((line) => {
      if (/copyright|©|\(c\)\s+\d{4}/i.test(line)) return line;
      return line.replace(/(?<![\w$])Paperclip(?![\w$])/g, (match, offset, whole) => {
        const before = whole.slice(0, offset);
        const after = whole.slice(offset + match.length);
        if (UPSTREAM_NAMES.test(after)) return match;
        // Header names (X-Paperclip-Run-Id): wire protocol the server matches
        // case-insensitively as x-paperclip-*, and header names cannot hold spaces.
        if (/X-$/.test(before) || (/-$/.test(before) && /^-[A-Z]/.test(after))) return match;
        counts.R5 += 1;
        // Product tokens (User-Agent "Paperclip/1.0") cannot contain spaces either.
        if (/^\/[A-Za-z0-9]/.test(after)) return BRAND.shortName;
        // A bare object key (`Paperclip: {` in code) must be quoted once it has spaces.
        if (CODE_FILE.test(file) && /^\s*$/.test(before) && /^\s*:/.test(after)) {
          return JSON.stringify(BRAND.productName);
        }
        return BRAND.productName;
      });
    })
    .join("\n");

  // R6: repository metadata in manifests only.
  if (path.basename(file) === "package.json") {
    next = sub(
      next,
      /("(?:url|homepage)"\s*:\s*"(?:git\+)?)https:\/\/github\.com\/paperclipai\/paperclip(?:\.git)?(\/issues)?(")/g,
      (_m, pre, issues = "", post) => `${pre}${BRAND.repoUrl}${issues}${post}`,
      "R6",
    );
  }

  // R7: legibility. Text faded with an alpha modifier drops below AA (worst in
  // light mode), so de-emphasis becomes a solid step down the text ramp.
  if (/^ui\//.test(file)) {
    next = sub(next, /text-muted-foreground\/\d{2}(?![\d\w])/g, "text-subtle-foreground", "R7");
    next = sub(next, /text-foreground\/(?:55|60)(?![\d\w])/g, "text-muted-foreground", "R7");
  }

  return next;
}

let changedFiles = 0;
const changed = [];
for (const file of listFiles()) {
  if (EXCLUDE.some((re) => re.test(file))) continue;
  const abs = path.join(ROOT, file);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    continue; // deleted in the working tree
  }
  if (!stat.isFile() || stat.size > TEXT_MAX_BYTES) continue;
  const buf = readFileSync(abs);
  if (!isText(buf)) continue;
  const before = buf.toString("utf8");
  const after = rebrand(file, before);
  if (after === before) continue;
  changedFiles += 1;
  changed.push(file);
  if (!CHECK) writeFileSync(abs, after);
}

const summary = Object.entries(counts)
  .map(([k, v]) => `${k}=${v}`)
  .join(" ");
if (CHECK) {
  if (changedFiles > 0) {
    console.error(`greatstone-rebrand: ${changedFiles} file(s) still need rebranding (${summary})`);
    for (const f of changed.slice(0, 40)) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log("greatstone-rebrand: clean");
} else {
  console.log(`greatstone-rebrand: rewrote ${changedFiles} file(s) (${summary})`);
}
