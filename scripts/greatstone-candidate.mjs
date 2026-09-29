#!/usr/bin/env node
// Cut a release candidate tag with a title and changelog (GRE-120; see
// doc/GREATSTONE-WAY-OF-WORKING.md).
//
//   node scripts/greatstone-candidate.mjs <rc-tag> --title "<title>" [--ref origin/main] [--since <live-tag>] [--print] [--json]
//
// It makes <rc-tag> an annotated tag on <ref> (default origin/main). The tag
// message is the title, then the merged pull requests since the last live-*
// tag in two groups, "Features" and "Fixes", one line each:
// "- <summary> (#<PR>, GRE-<n>)". A pull request whose title starts with
// "fix" (after any "type(scope):" or "GRE-n:" prefix) is a fix; every other
// one is a feature. The title is required: the
// release script refuses an rc tag without one. --print shows the message and
// makes no tag. --json prints the result as JSON (the live server reads it for
// the Releases page, GRE-121). The tag stays local; the release script pushes it.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { issueId, mergedChanges, whatChanged } from "./greatstone-changes.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Must match rc_tag_title in scripts/greatstone-common.sh.
export function titleProblem(title, tag) {
  const t = (title ?? "").trim();
  if (!t) return "a title is required (--title \"...\")";
  if (t.includes("\n")) return "the title must be one line";
  if (t === tag || /^release candidate\b/i.test(t) || /^rc-\d/.test(t)) return `"${t}" is not a title; say in plain words what this release brings`;
  return null;
}

export function changeKind(title) {
  const fix = /^(fix|hotfix|revert)\b/i;
  return fix.test(title.trim()) || fix.test(whatChanged(title)) ? "fixes" : "features";
}

export function noteLine(change) {
  const summary = whatChanged(change.title).replace(/\.$/, "");
  const refs = [change.pr ? `#${change.pr}` : null, issueId(change.title, change.branch)].filter(Boolean);
  return `- ${summary.charAt(0).toUpperCase()}${summary.slice(1)}${refs.length ? ` (${refs.join(", ")})` : ""}`;
}

export function tagMessage(title, changes) {
  const groups = { features: [], fixes: [] };
  for (const c of changes) groups[changeKind(c.title)].push(noteLine(c));
  const parts = [title.trim()];
  if (groups.features.length) parts.push(["Features", ...groups.features].join("\n"));
  if (groups.fixes.length) parts.push(["Fixes", ...groups.fixes].join("\n"));
  return `${parts.join("\n\n")}\n`;
}

// The newest live-* tag that <ref> contains (it may be <ref> itself).
export function liveTagOf(cwd, ref) {
  try {
    return git(cwd, "describe", "--tags", "--abbrev=0", "--match", "live-*", ref);
  } catch {
    throw new Error(`no live-* tag in ${ref}; name one with --since <live-tag>`);
  }
}

export function cutCandidate(cwd, { tag, title, ref = "origin/main", since = null, print = false }) {
  if (!/^rc-\d{4}-\d{2}-\d{2}\.\d+$/.test(tag ?? "")) throw new Error(`"${tag}" is not an rc tag (rc-YYYY-MM-DD.N)`);
  const problem = titleProblem(title, tag);
  if (problem) throw new Error(problem);
  if (!print) {
    let exists = true;
    try { git(cwd, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`); } catch { exists = false; }
    if (exists) throw new Error(`${tag} already exists`);
  }
  const sha = git(cwd, "rev-parse", "--verify", `${ref}^{commit}`);
  const from = since || liveTagOf(cwd, sha);
  const changes = mergedChanges(cwd, from, sha);
  if (changes.length === 0) throw new Error(`nothing merged since ${from}; no candidate needed`);
  const message = tagMessage(title, changes);
  if (!print) execFileSync("git", ["tag", "-a", tag, sha, "-F", "-"], { cwd, input: message, stdio: ["pipe", "ignore", "pipe"] });
  const summary = changes.map((c) => ({
    sha: c.sha,
    pr: c.pr,
    issue: issueId(c.title, c.branch),
    kind: changeKind(c.title) === "fixes" ? "fix" : "feature",
    line: noteLine(c).slice(2),
  }));
  return { sha, since: from, message, changes: summary };
}

function main(argv) {
  const args = [...argv];
  const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const title = opt("--title");
  const ref = opt("--ref") || "origin/main";
  const since = opt("--since");
  const print = flag("--print");
  const json = flag("--json");
  if (args.length !== 1) {
    process.stderr.write('usage: greatstone-candidate.mjs <rc-tag> --title "<title>" [--ref origin/main] [--since <live-tag>] [--print] [--json]\n');
    process.exit(2);
  }
  const result = cutCandidate(process.cwd(), { tag: args[0], title, ref, since, print });
  const { sha, since: from, message } = result;
  if (json) {
    process.stdout.write(`${JSON.stringify({ tag: args[0], tagged: !print, ...result })}\n`);
    return;
  }
  process.stdout.write(`${print ? "Would tag" : "Tagged"} ${args[0]} on ${sha.slice(0, 9)} (changes since ${from}):\n\n${message}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`candidate: ${error.message}\n`);
    process.exit(1);
  }
}
