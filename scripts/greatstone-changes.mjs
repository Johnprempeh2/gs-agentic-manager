#!/usr/bin/env node
// List what changed in a release candidate and where to see it in the preview
// (see doc/GREATSTONE-WAY-OF-WORKING.md).
//
//   node scripts/greatstone-changes.mjs <rc-tag> [--since <live-tag>] [--no-gh]
//
// It reads the merges on main between the last live-* tag and <rc-tag>, one
// line per merged pull request: the issue link, what changed (the pull request
// title), the page to open on port 3200 and how to reach it from the sidebar.
// The page comes from the "Where to see it:" line in the pull request body
// (read with gh). Without that line it is guessed from the changed files: no
// UI file changed means "no visible change". Only reads git and GitHub.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PREVIEW_URL = `http://localhost:${process.env.GSAM_PREVIEW_PORT || 3200}`;
export const COMPANY_PREFIX = process.env.GSAM_COMPANY_PREFIX || "GRE";
export const GITHUB_REPO = process.env.GSAM_GITHUB_REPO || "Johnprempeh2/gs-agentic-manager";

// UI files → the page they show, most specific first. A change names at most two.
const PAGES = [
  [/InstanceExperimentalSettings/, "/company/settings/instance/experimental", "Sidebar → Settings → Experimental"],
  [/(WhatNeedsMe|DecisionQueue|decisions-focus|Decision)/, "/decisions", "Sidebar → Decisions"],
  [/Inbox/, "/inbox", "Sidebar → Inbox"],
  [/MyTasks/, "/my-tasks", "Sidebar → My tasks"],
  [/Dashboard/, "/dashboard", "Sidebar → Dashboard"],
  [/BoardChat/, "/board-chat", "Sidebar → Conference Room"],
  [/(IssueDetail|IssueChat|IssueThread|IssueProperties)/, "/issues", "Sidebar → Work → Tasks, then open a task"],
  [/Issue/, "/issues", "Sidebar → Work → Tasks"],
  [/Project/, "/projects", "Sidebar → Work → Projects"],
  [/Routine/, "/routines", "Sidebar → Work → Routines"],
  [/Artifact/, "/artifacts", "Sidebar → Work → Artifacts"],
  [/Goal/, "/goals", "Sidebar → Work → Goals"],
  [/Agent/, "/agents", "Sidebar → Org → Agents"],
  [/Skill/, "/skills", "Sidebar → Org → Skills"],
  [/(Costs|Budget)/, "/costs", "Sidebar → Costs"],
  [/Activity/, "/activity", "Sidebar → Activity"],
  [/(CompanySettings|InstanceGeneralSettings|Secrets)/, "/company/settings", "Sidebar → Settings"],
  [/(MobileBottomNav|components\/Sidebar)/, "/dashboard", "look at the sidebar itself (every page)"],
];

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

export function lastLiveTag(cwd, ref) {
  try {
    return git(cwd, "describe", "--tags", "--abbrev=0", "--match", "live-*", `${ref}^`);
  } catch {
    throw new Error(`no live-* tag before ${ref}; name one with --since <live-tag>`);
  }
}

// Merge commits on main between two refs, oldest first.
export function mergedChanges(cwd, since, until) {
  const out = git(cwd, "log", "--first-parent", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", `${since}..${until}`);
  return out.split("\x1e").map((s) => s.trim()).filter(Boolean).map((record) => {
    const [sha, subject, body = ""] = record.split("\x1f");
    let pr = null, branch = "", title = subject;
    const merge = subject.match(/^Merge pull request #(\d+) from [^/\s]+\/(\S+)/);
    const squash = subject.match(/^(.*) \(#(\d+)\)$/);
    if (merge) {
      pr = Number(merge[1]);
      branch = merge[2];
      title = body.split("\n").find((l) => l.trim())?.trim() || branch;
    } else if (squash) {
      pr = Number(squash[2]);
      title = squash[1];
    }
    const files = git(cwd, "diff", "--name-only", `${sha}^1`, sha).split("\n").filter(Boolean);
    return { sha, pr, branch, title, files };
  });
}

export function issueId(...texts) {
  for (const text of texts) {
    const m = (text || "").match(/\b([A-Z]{2,6}-\d+)\b/);
    if (m) return m[1];
  }
  return null;
}

// "feat(ui): Decisions: Focus mode (GRE-55)" → "Decisions: Focus mode."
export function whatChanged(title) {
  const t = title
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "")
    .replace(/^[A-Z]{2,6}-\d+:\s*/, "")
    .replace(/\s*\((?:[A-Z]{2,6}-\d+(?:,\s*)?)+\)\s*$/, "")
    .trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// "Where to see it: Sidebar → Decisions, then Focus (/decisions)" in a PR body.
export function whereFromBody(body) {
  const m = (body || "").match(/^[\s>*-]*(?:\*\*)?Where to see it:?(?:\*\*)?:?\s*(.+)$/im);
  if (!m) return null;
  const text = m[1].trim();
  if (!text || /^<!--/.test(text)) return null;
  if (/no visible change/i.test(text)) return { none: true };
  const path = text.match(/\(?`?(\/[\w\-/]*)`?\)?/);
  return { path: path ? path[1] : null, how: text.replace(/\s*\(?`?\/[\w\-/]*`?\)?\s*/, " ").replace(/\s+([.,])/g, "$1").trim() };
}

const isUiFile = (f) => f.startsWith("ui/src/") && !/\.(test|spec|stories)\.[jt]sx?$/.test(f) && !/\/(__tests__|fixtures)\//.test(f);

export function whereFromFiles(files) {
  const ui = files.filter(isUiFile);
  if (ui.length === 0) return { none: true };
  const pages = PAGES.filter(([pattern]) => ui.some((f) => pattern.test(f))).slice(0, 2);
  if (pages.length > 0) return { path: pages[0][1], how: pages[0][2], also: pages[1] ? { path: pages[1][1], how: pages[1][2] } : null };
  return { path: null, how: `a UI file changed but the page is not named (${ui.slice(0, 2).join(", ")})` };
}

export function changeLine(change, { prBody = null, previewUrl = PREVIEW_URL, prefix = COMPANY_PREFIX, repo = GITHUB_REPO } = {}) {
  const id = issueId(change.title, change.branch, prBody);
  const issue = id ? `[${id}](/${prefix}/issues/${id})` : change.pr ? "(no issue)" : `(commit ${change.sha.slice(0, 9)})`;
  const where = whereFromBody(prBody) ?? whereFromFiles(change.files);
  const see = where.none
    ? "No visible change."
    : [where, where.also].filter(Boolean)
        .map((w, i) => `${i ? "Also " : "Open "}${w.path ? `${previewUrl}/${prefix}${w.path}` : "the preview"}; ${w.how}.`.replace(/\.\.$/, "."))
        .join(" ");
  const pr = change.pr ? ` ([#${change.pr}](https://github.com/${repo}/pull/${change.pr}))` : "";
  return `- ${issue} ${whatChanged(change.title)} ${see}${pr}`;
}

export function changeList(changes, { rc, since, ...opts }) {
  const head = `**What changed and where to see it** (${rc} against ${since}; ${changes.length} change${changes.length === 1 ? "" : "s"}; preview ${opts.previewUrl ?? PREVIEW_URL})`;
  if (changes.length === 0) return `${head}\n- No merged change since ${since}.`;
  return [head, ...changes.map((c) => changeLine(c, { ...opts, prBody: c.prBody }))].join("\n");
}

function ghPrBody(pr, repo) {
  try {
    return execFileSync("gh", ["pr", "view", String(pr), "--repo", repo, "--json", "body", "--jq", ".body"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function main(argv) {
  const args = [...argv];
  const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const since = opt("--since");
  const noGh = flag("--no-gh");
  const rc = args[0];
  if (!rc || args.length > 1) {
    process.stderr.write("usage: greatstone-changes.mjs <rc-tag> [--since <live-tag>] [--no-gh]\n");
    process.exit(2);
  }
  const cwd = process.cwd();
  const from = since || lastLiveTag(cwd, rc);
  const changes = mergedChanges(cwd, from, rc).map((c) => ({ ...c, prBody: !noGh && c.pr ? ghPrBody(c.pr, GITHUB_REPO) : null }));
  process.stdout.write(`${changeList(changes, { rc, since: from })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`changes: ${error.message}\n`);
    process.exit(1);
  }
}
