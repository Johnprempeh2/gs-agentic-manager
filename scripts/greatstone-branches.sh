#!/usr/bin/env bash
# Branch report (GRE-920, register row 133): one line per branch on origin
# with its class, the age of its last commit and what uses it, then a count
# per class.
#
#   scripts/greatstone-branches.sh
#
# Classes:
#   open PR                a pull request from this branch is open
#   merged, still in use   a pull request from it was merged, and an open GSAM
#                          task or an existing git worktree still uses it
#   merged, not in use     a pull request from it was merged, and nothing uses it
#   no PR                  no open or merged pull request (a closed one is named)
#
# A branch is used by an open task when its name starts with the task's id
# (GRE-646-...), or when it is the branch of the task's execution workspace.
# The default branch (main) is not listed.
#
# Read-only. It reads `git ls-remote origin`, `gh pr list`, `git worktree list`
# and GETs open issues and execution workspaces from the GSAM server. The only
# local change is `git fetch origin`, which updates the copies of origin's refs
# so that the age of each branch is known. Row 134 (removing branches) waits
# for John; this script removes and uploads nothing.
#
# GSAM server: GSAM_API_URL and GSAM_API_KEY when set (an agent run), else
# $LIVE_URL with the board key in GSAM_LIVE_BOARD_KEY_FILE. The company is
# GSAM_COMPANY_ID, else the company with issue prefix GRE, else the first one.
# When the server cannot be read the report still runs, says so, and counts
# only worktrees as use. GSAM_BRANCHES_REPO moves the repo for a sandbox test.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"

die() { printf 'branches: %s\n' "$*" >&2; exit 1; }

REPO="${GSAM_BRANCHES_REPO:-$GS_TOOLS_ROOT}"
WORK="$(mktemp -d "${GSAM_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/gs-branches.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

git -C "$REPO" fetch --quiet origin 2>/dev/null \
  || say "(could not fetch origin; ages come from the local copies of origin's refs)" >&2

git -C "$REPO" ls-remote --heads origin >"$WORK/heads" || die "git ls-remote origin failed."
git -C "$REPO" ls-remote --symref origin HEAD >"$WORK/default" 2>/dev/null || : >"$WORK/default"
git -C "$REPO" for-each-ref --format='%(objectname) %(committerdate:unix)' refs/remotes/origin >"$WORK/dates"
git -C "$REPO" worktree list --porcelain >"$WORK/worktrees"

# owner/repo of origin, for gh.
SLUG="$(git -C "$REPO" remote get-url origin | sed -E 's#^(git@[^:]+:|https?://[^/]+/)##; s#\.git$##')"
(cd "$REPO" && gh pr list -R "$SLUG" --state all --limit 5000 --json number,state,headRefName) >"$WORK/prs" \
  || die "gh pr list -R $SLUG failed (see above)."

# Open issues and their execution workspaces: GET only.
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const [liveUrl, keyFile, out] = process.argv.slice(1);
  let base = process.env.GSAM_API_URL ? process.env.GSAM_API_URL.replace(/\/$/, "").replace(/\/api$/, "") : liveUrl;
  let key = process.env.GSAM_API_URL ? (process.env.GSAM_API_KEY ?? "") : "";
  if (!key) { try { key = readFileSync(keyFile, "utf8").trim(); } catch {} }
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  const get = async (p) => {
    const res = await fetch(base + p, { headers });
    if (!res.ok) throw new Error(`GET ${p} answered ${res.status}`);
    return res.json();
  };
  const list = (body) => (Array.isArray(body) ? body : (body.items ?? body.issues ?? []));
  try {
    let company = process.env.GSAM_COMPANY_ID ?? "";
    if (!company) {
      const all = await get("/api/companies");
      company = (all.find((c) => c.issuePrefix === "GRE") ?? all[0])?.id ?? "";
      if (!company) throw new Error("the server has no company");
    }
    const issues = list(await get(`/api/companies/${company}/issues?status=backlog,todo,in_progress,in_review,blocked&limit=5000`));
    const workspaces = list(await get(`/api/companies/${company}/execution-workspaces`));
    writeFileSync(out, JSON.stringify({ ok: true, issues, workspaces }));
  } catch (err) {
    writeFileSync(out, JSON.stringify({ ok: false, reason: `${base}: ${err.message}` }));
  }
' "$LIVE_URL" "$LIVE_BOARD_KEY_FILE" "$WORK/tasks"

node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const dir = process.argv[1];
  const read = (f) => readFileSync(`${dir}/${f}`, "utf8");
  const now = Number(process.env.GSAM_BRANCHES_NOW ?? Math.floor(Date.now() / 1000));

  const defaultBranch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(read("default"))?.[1] ?? "main";
  const heads = read("heads").split("\n").map((l) => l.split("\t"))
    .filter(([sha, ref]) => /^[0-9a-f]{40}$/.test(sha ?? "") && ref?.startsWith("refs/heads/"))
    .map(([sha, ref]) => ({ sha, name: ref.slice("refs/heads/".length) }))
    .filter((b) => b.name !== defaultBranch);
  const dates = new Map(read("dates").split("\n").filter(Boolean).map((l) => l.split(" ")));

  // PRs per branch: open first, then merged (newest number first), then closed.
  const prs = new Map();
  for (const pr of JSON.parse(read("prs"))) {
    prs.set(pr.headRefName, [...(prs.get(pr.headRefName) ?? []), pr]);
  }

  // What uses each branch.
  const users = new Map();
  const use = (branch, who) => {
    if (!users.has(branch)) users.set(branch, new Set());
    users.get(branch).add(who);
  };
  let current = null;
  for (const line of (read("worktrees") + "\n").split("\n")) {
    if (line.startsWith("worktree ")) current = { branch: null, prunable: false };
    else if (line.startsWith("branch refs/heads/") && current) current.branch = line.slice("branch refs/heads/".length);
    else if (line.startsWith("prunable") && current) current.prunable = true;
    else if (line === "" && current) {
      if (current.branch && !current.prunable) use(current.branch, "worktree");
      current = null;
    }
  }
  const tasks = JSON.parse(read("tasks"));
  const taskIds = new Set();
  if (tasks.ok) {
    const branchOfWorkspace = new Map(tasks.workspaces.map((w) => [w.id, w.branchName]));
    for (const issue of tasks.issues) {
      if (issue.identifier) taskIds.add(issue.identifier);
      const branch = branchOfWorkspace.get(issue.executionWorkspaceId);
      if (branch && issue.identifier) use(branch, issue.identifier);
    }
  }
  for (const b of heads) {
    const m = /^([A-Z][A-Z0-9]*-\d+)(?:-|$)/.exec(b.name);
    if (m && taskIds.has(m[1])) use(b.name, m[1]);
  }

  const rows = heads.map((b) => {
    const list = (prs.get(b.name) ?? []).sort((x, y) => y.number - x.number);
    const open = list.find((p) => p.state === "OPEN");
    const merged = list.find((p) => p.state === "MERGED");
    const closed = list.find((p) => p.state === "CLOSED");
    const by = [...(users.get(b.name) ?? [])].sort((x, y) => (x === "worktree") - (y === "worktree") || x.localeCompare(y));
    let cls, pr;
    if (open) { cls = "open PR"; pr = `#${open.number}`; }
    else if (merged) { cls = by.length ? "merged, still in use" : "merged, not in use"; pr = `#${merged.number}`; }
    else { cls = "no PR"; pr = closed ? `(#${closed.number} closed)` : "-"; }
    const when = dates.get(b.sha);
    const age = when ? `${Math.max(0, Math.floor((now - Number(when)) / 86400))}d` : "?";
    return { name: b.name, cls, age, pr, by: by.join(", ") || "-" };
  });

  const order = ["open PR", "merged, still in use", "merged, not in use", "no PR"];
  rows.sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls) || a.name.localeCompare(b.name));
  const width = Math.max(6, ...rows.map((r) => r.name.length));
  const line = (...c) => console.log(`${c[0].padEnd(width)}  ${c[1].padEnd(20)}  ${c[2].padStart(5)}  ${c[3].padEnd(15)}  ${c[4]}`);
  if (!tasks.ok) console.log(`(could not read open tasks from ${tasks.reason}; only worktrees count as use)`);
  line("branch", "class", "age", "PR", "used by");
  for (const r of rows) line(r.name, r.cls, r.age, r.pr, r.by);
  console.log("");
  console.log(`Totals (${rows.length} branches; ${defaultBranch} not listed)`);
  for (const c of order) console.log(`  ${(c + ":").padEnd(22)} ${rows.filter((r) => r.cls === c).length}`);
' "$WORK"
