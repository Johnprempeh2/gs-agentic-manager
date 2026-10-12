#!/usr/bin/env node
/**
 * find-ui-dashes.mjs
 *
 * Lists em dashes (U+2014) and en dashes (U+2013) that sit in code, not in
 * comments, across ui/src. It parses each file, so a dash inside a string,
 * template or JSX text counts and a dash inside a comment does not.
 * Greatstone house style keeps both dashes out of anything a person reads.
 *
 *   node scripts/find-ui-dashes.mjs            list findings, then a summary
 *   node scripts/find-ui-dashes.mjs --summary  summary only
 *   node scripts/find-ui-dashes.mjs --json     machine-readable findings
 *
 * Skips dev-only surfaces (UX labs, the design guide, stories, storybook,
 * preview harnesses, fixtures). Test files are counted separately.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";

// @babel/parser is not a direct dependency; borrow the copy Vite's React plugin ships with.
const fromUi = createRequire(new URL("../ui/package.json", import.meta.url));
const fromReactPlugin = createRequire(fromUi.resolve("@vitejs/plugin-react"));
const { parse } = createRequire(fromReactPlugin.resolve("@babel/core"))("@babel/parser");

const root = new URL("..", import.meta.url).pathname;
// The characters themselves, or spelled as a JS escape or an HTML entity.
const DASH = /[–—]|\\u201[34]|\\u\{201[34]\}|&[mn]dash;|&#821[12];|&#x201[34];/i;
const SKIP = [
  /^ui\/src\/pages\/[^/]*UxLab[^/]*\.tsx$/,
  /^ui\/src\/pages\/DesignGuide\.tsx$/,
  /\.stories\.tsx$/,
  /^ui\/storybook\//,
  /preview-main\.tsx$/,
  /^ui\/src\/fixtures\//,
];
const LITERALS = new Set(["StringLiteral", "TemplateElement", "JSXText"]);
const isTest = (p) => /\.test\.tsx?$/.test(p) || p.includes("/__tests__/");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const findings = [];
for (const file of walk(join(root, "ui/src"))) {
  const rel = relative(root, file);
  if (SKIP.some((re) => re.test(rel))) continue;
  const text = readFileSync(file, "utf8");
  if (!DASH.test(text)) continue;
  const plugins = file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"];
  const ast = parse(text, { sourceType: "module", plugins, errorRecovery: true });
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (LITERALS.has(node.type)) {
      const raw = text.slice(node.start, node.end);
      if (DASH.test(raw)) {
        findings.push({ file: rel, line: node.loc.start.line, test: isTest(rel), text: raw.trim().slice(0, 160) });
      }
    }
    for (const key in node) {
      if (key === "loc" || key.endsWith("Comments")) continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast.program);
}

const args = new Set(process.argv.slice(2));
if (args.has("--json")) {
  process.stdout.write(JSON.stringify(findings, null, 1) + "\n");
  process.exit(0);
}
const lineCount = (f) => new Set(f.map((x) => `${x.file}:${x.line}`)).size;
const fileCount = (f) => new Set(f.map((x) => x.file)).size;
const src = findings.filter((f) => !f.test);
const tst = findings.filter((f) => f.test);
if (!args.has("--summary")) for (const f of findings) console.log(`${f.file}:${f.line}\t${f.text}`);
console.log(`source: ${lineCount(src)} lines in ${fileCount(src)} files; tests: ${lineCount(tst)} lines in ${fileCount(tst)} files`);
