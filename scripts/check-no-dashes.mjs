#!/usr/bin/env node
/**
 * check-no-dashes.mjs
 *
 * House style: no em dash (U+2014) or en dash (U+2013) in any text a person
 * reads. This fails when one appears in a string literal, template literal or
 * JSX text in the UI, the server, or the shared package both of them render
 * from, and in the markdown the server hands to agents and users.
 *
 *   node scripts/check-no-dashes.mjs
 *
 * Dependency-free on purpose (the guard job runs before `pnpm install`), so it
 * uses a small lexer rather than a parser. Comments and regex literals are
 * skipped: a comment is not shown to anyone, and a regex that matches a dash is
 * parsing, not copy. Tests and fixtures are skipped too: they may quote
 * third-party text. Where code genuinely needs the character as data, write it
 * as an escape ("—") so the intent is visible.
 *
 * Fix a finding by rewriting the copy with commas, colons, full stops or
 * parentheses; a range of numbers or dates uses "to" ("3 to 5").
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASH = /[–—]/;

const CODE_SCOPE = /^(ui\/src|server\/src|packages\/shared\/src)\/.*\.(tsx?|jsx?|mjs|cjs)$/;
// Markdown the server loads at runtime and shows to agents and users.
const MARKDOWN_SCOPE = /^server\/src\/(onboarding-assets|built-ins)\/.*\.md$/;
const SKIP = [/(^|\/)__tests__\//, /\.(test|spec)\.[cm]?[jt]sx?$/, /fixtures?/i, /\.stories\.[jt]sx?$/, /(^|\/)README\.md$/];

// Characters after which `/` starts a regex literal rather than a division.
// `<` is left out so a JSX closing tag (`</p>`) is not read as a regex.
const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%~^".split(""));
const REGEX_KEYWORDS = /(?:^|[^\w$])(return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;

/** Returns [{ line, text }] for every dash outside comments and regex literals. */
export function findDashes(src) {
  const hits = [];
  let line = 1;
  let i = 0;
  let lastSig = ""; // last non-space character seen in code
  let codeSoFar = ""; // recent code, for the keyword check before `/`
  const templateBraces = []; // brace depth inside each open `${ ... }`
  const flag = (ch) => {
    if (DASH.test(ch)) hits.push(line);
  };
  const n = src.length;

  const readTemplate = () => {
    // i is just past a backtick or a closing `}` of an expression.
    while (i < n) {
      const ch = src[i];
      if (ch === "\\" && src[i + 1] !== "\n") {
        i += 2;
        continue;
      }
      if (ch === "\n") line += 1;
      if (ch === "`") {
        i += 1;
        lastSig = "`";
        return;
      }
      if (ch === "$" && src[i + 1] === "{") {
        i += 2;
        templateBraces.push(0);
        lastSig = "{";
        return;
      }
      flag(ch);
      i += 1;
    }
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // Quoted strings cannot span lines, so a stray apostrophe in JSX text
      // costs at most the rest of its line.
      i += 1;
      while (i < n && src[i] !== ch && src[i] !== "\n") {
        if (src[i] === "\\" && src[i + 1] !== "\n") i += 1;
        else flag(src[i]);
        i += 1;
      }
      if (src[i] === ch) i += 1;
      lastSig = ch;
      continue;
    }
    if (ch === "`") {
      i += 1;
      readTemplate();
      continue;
    }
    if (ch === "/" && (lastSig === "" || REGEX_AFTER.has(lastSig) || REGEX_KEYWORDS.test(codeSoFar))) {
      i += 1;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        const c = src[i];
        if (c === "\\" && src[i + 1] !== "\n") i += 1;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        i += 1;
      }
      if (src[i] === "/") i += 1;
      lastSig = "/";
      codeSoFar = "";
      continue;
    }
    if (templateBraces.length > 0) {
      if (ch === "{") templateBraces[templateBraces.length - 1] += 1;
      if (ch === "}") {
        if (templateBraces[templateBraces.length - 1] === 0) {
          templateBraces.pop();
          i += 1;
          readTemplate();
          continue;
        }
        templateBraces[templateBraces.length - 1] -= 1;
      }
    }
    // Anything else in code position: identifiers cannot hold a dash, so a dash
    // here is JSX text.
    flag(ch);
    if (!/\s/.test(ch)) {
      lastSig = ch;
      codeSoFar = (codeSoFar + ch).slice(-12);
    } else {
      codeSoFar += " ";
    }
    i += 1;
  }
  return hits;
}

function listFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter((f) => (CODE_SCOPE.test(f) || MARKDOWN_SCOPE.test(f)) && !SKIP.some((re) => re.test(f)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = [];
  for (const file of listFiles()) {
    let src;
    try {
      src = readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    if (!DASH.test(src)) continue;
    const lines = src.split("\n");
    const hitLines = file.endsWith(".md")
      ? lines.flatMap((l, idx) => (DASH.test(l) ? [idx + 1] : []))
      : findDashes(src);
    for (const ln of new Set(hitLines)) findings.push(`  ${file}:${ln}  ${lines[ln - 1].trim().slice(0, 140)}`);
  }
  if (findings.length > 0) {
    console.error(`check-no-dashes: ${findings.length} line(s) with an em or en dash in user-facing text`);
    console.error(findings.join("\n"));
    console.error('Rewrite with commas, colons, full stops or parentheses; ranges use "to".');
    process.exit(1);
  }
  console.log("check-no-dashes: clean");
}
