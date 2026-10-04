// Compare two `pnpm licenses ls --json` outputs and list the packages that are
// new or whose licence changed, each marked `ok` or `check` (GRE-624).
//
//   node scripts/licence-diff.mjs <base.json> <head.json> [<base label> <head label>]
//
// Used by scripts/licence-diff.sh, which makes the two JSON files. Always exits 0
// once both files are read: the output is the report.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Permissive licences we take without asking Harbor. Anything else is `check`.
const OK = new Set([
  "MIT", "MIT-0", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear",
  "Apache-2.0", "Unlicense", "CC0-1.0", "CC-BY-3.0", "CC-BY-4.0", "Zlib", "Python-2.0",
  "BlueOak-1.0.0", "WTFPL", "BSD",
]);

function okId(id) {
  const bare = id.replace(/\s+WITH\s+.*$/i, "").replace(/\+$/, "").trim();
  return OK.has(bare) || /^BSD-/.test(bare);
}

// `ok` when the SPDX expression lets us use the package under a licence in OK:
// one OR branch suffices; an AND needs all of its parts. Unknown or none: `check`.
export function classify(licence) {
  if (!licence || /^(unknown|none|unlicensed|see license in)/i.test(licence.trim())) return "check";
  const alternatives = licence.replace(/[()]/g, " ").split(/\s+OR\s+/i);
  if (/\s+AND\s+/i.test(licence) && /\s+OR\s+/i.test(licence)) {
    // Mixed expression: only `ok` if every part is ok.
    return alternatives.flatMap((a) => a.split(/\s+AND\s+/i)).every(okId) ? "ok" : "check";
  }
  return alternatives.some((a) => a.split(/\s+AND\s+/i).every(okId)) ? "ok" : "check";
}

// name -> Map(version -> licence) from `pnpm licenses ls --json`.
export function index(report) {
  const byName = new Map();
  for (const [group, packages] of Object.entries(report ?? {})) {
    for (const pkg of packages ?? []) {
      const licence = (pkg.license ?? group ?? "").trim() || "none";
      const versions = byName.get(pkg.name) ?? new Map();
      for (const version of pkg.versions ?? [pkg.version]) versions.set(version, licence);
      byName.set(pkg.name, versions);
    }
  }
  return byName;
}

// Rows for head packages that are new, or whose licence is not one the same
// package had on base. A version bump under the same licence is not listed.
export function diff(baseReport, headReport) {
  const base = index(baseReport);
  const rows = [];
  for (const [name, versions] of index(headReport)) {
    const before = base.get(name);
    const beforeLicences = new Set(before?.values() ?? []);
    for (const [version, licence] of versions) {
      if (before && beforeLicences.has(licence)) continue;
      rows.push({
        mark: classify(licence),
        name,
        version,
        licence,
        change: before ? `changed, was ${[...beforeLicences].join(" | ")}` : "new",
      });
    }
  }
  return rows.sort((a, b) => (a.mark === b.mark ? a.name.localeCompare(b.name) : a.mark === "check" ? -1 : 1));
}

export function render(rows, baseLabel = "base", headLabel = "head") {
  const checks = rows.filter((r) => r.mark === "check").length;
  const lines = [`Licence diff ${baseLabel} -> ${headLabel}: ${rows.length} new or changed, ${checks} to check.`];
  for (const r of rows) lines.push(`${r.mark.padEnd(5)}  ${r.name}@${r.version}  ${r.licence}  (${r.change})`);
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [baseFile, headFile, baseLabel, headLabel] = process.argv.slice(2);
  if (!baseFile || !headFile) {
    console.error("usage: node scripts/licence-diff.mjs <base.json> <head.json> [<base label> <head label>]");
    process.exit(2);
  }
  const read = (f) => JSON.parse(readFileSync(f, "utf8"));
  console.log(render(diff(read(baseFile), read(headFile)), baseLabel, headLabel));
}
