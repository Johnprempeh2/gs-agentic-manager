// Sandbox tests for scripts/greatstone-branches.sh (GRE-920). origin is a
// local bare repo, gh is a stub on PATH that prints fixed pull requests, and
// the GSAM server is a local fake that answers the open-issue and workspace
// GETs. No network, nothing under ~/GSAM, no real GitHub call.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const scriptsDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const script = join(scriptsDir, "greatstone-branches.sh");
const NOW = 1_790_000_000;
const DAY = 86_400;
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// Branch -> days since its last commit.
const BRANCHES = {
  "feat-open": 1,
  "GRE-5-task-open": 2, // merged; open task GRE-5 by its name
  "ws-branch": 3, // merged; execution workspace of open task GRE-6
  "in-worktree": 4, // merged; checked out in a worktree
  "GRE-7-task-done": 10, // merged; GRE-7 is not open
  "gone-worktree": 11, // merged; its worktree folder was removed (prunable)
  "closed-only": 20, // a closed PR, never merged
  "never-pr": 30,
};

const PRS = [
  { number: 1, state: "OPEN", headRefName: "feat-open" },
  { number: 2, state: "MERGED", headRefName: "GRE-5-task-open" },
  { number: 3, state: "MERGED", headRefName: "ws-branch" },
  { number: 4, state: "MERGED", headRefName: "in-worktree" },
  { number: 5, state: "MERGED", headRefName: "GRE-7-task-done" },
  { number: 6, state: "MERGED", headRefName: "gone-worktree" },
  { number: 7, state: "CLOSED", headRefName: "closed-only" },
  // A merged PR and a newer open one on the same branch: open wins.
  { number: 8, state: "MERGED", headRefName: "feat-open" },
];

// Commits are written as raw objects with a fixed committer date: the git
// wrapper of an agent run drops GIT_COMMITTER_DATE.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "gs-branches-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, ["init", "--quiet", "--bare", "-b", "main", origin]);
  const hash = (type, body) =>
    execFileSync("git", ["hash-object", "-t", type, "-w", "--stdin"], { cwd: origin, input: body, encoding: "utf8" }).trim();
  const tree = hash("tree", "");
  const commit = (days, msg, parent) => {
    const who = `t <t@t> ${NOW - days * DAY} +0000`;
    return hash("commit", `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author ${who}\ncommitter ${who}\n\n${msg}\n`);
  };
  const base = commit(40, "base");
  git(origin, ["update-ref", "refs/heads/main", base]);
  for (const [name, days] of Object.entries(BRANCHES)) git(origin, ["update-ref", `refs/heads/${name}`, commit(days, name, base)]);
  git(root, ["clone", "--quiet", origin, repo]);
  git(repo, ["worktree", "add", "--quiet", join(root, "wt1"), "in-worktree"]);
  git(repo, ["worktree", "add", "--quiet", join(root, "wt2"), "gone-worktree"]);
  rmSync(join(root, "wt2"), { recursive: true, force: true });

  const bin = join(root, "bin");
  execFileSync("mkdir", [bin]);
  writeFileSync(join(root, "prs.json"), JSON.stringify(PRS));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${join(root, "gh-calls")}"\ncat "${join(root, "prs.json")}"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return { root, repo, bin };
}

function fakeServer() {
  const methods = [];
  const server = http.createServer((req, res) => {
    methods.push(req.method);
    const url = new URL(req.url, "http://x");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/companies") return res.end(JSON.stringify([{ id: "c1", issuePrefix: "GRE" }]));
    if (url.pathname === "/api/companies/c1/issues") {
      return res.end(JSON.stringify([
        { identifier: "GRE-5", status: "in_progress", executionWorkspaceId: null },
        { identifier: "GRE-6", status: "in_review", executionWorkspaceId: "w6" },
      ]));
    }
    if (url.pathname === "/api/companies/c1/execution-workspaces") {
      return res.end(JSON.stringify([
        { id: "w6", branchName: "ws-branch" },
        { id: "w7", branchName: "GRE-7-task-done" }, // GRE-7 is not open
      ]));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, methods })));
}

async function report(box, liveUrl) {
  const env = {
    ...process.env,
    PATH: `${box.bin}:${process.env.PATH}`,
    GSAM_ROOT: box.root,
    GSAM_BRANCHES_REPO: box.repo,
    GSAM_LIVE_URL: liveUrl,
    GSAM_BRANCHES_NOW: String(NOW),
  };
  // BASH_ENV in an agent run puts a real gh first on PATH.
  for (const k of ["BASH_ENV", "GSAM_API_URL", "GSAM_API_KEY", "GSAM_COMPANY_ID", "GSAM_LIVE_BOARD_KEY_FILE"]) delete env[k];
  const { stdout } = await promisify(execFile)("bash", [script], { env, encoding: "utf8" });
  return stdout;
}

// The row of <branch>: [class, age, PR, used by].
const row = (stdout, branch) => {
  const line = stdout.split("\n").find((l) => l.startsWith(`${branch} `));
  assert.ok(line, `no row for ${branch}:\n${stdout}`);
  return line.slice(branch.length).trim().split(/\s{2,}/);
};

test("each branch gets one of the four classes, its age and what uses it", async () => {
  const box = sandbox();
  const { server, methods } = await fakeServer();
  try {
    const out = await report(box, `http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(row(out, "feat-open"), ["open PR", "1d", "#1", "-"]);
    assert.deepEqual(row(out, "GRE-5-task-open"), ["merged, still in use", "2d", "#2", "GRE-5"]);
    assert.deepEqual(row(out, "ws-branch"), ["merged, still in use", "3d", "#3", "GRE-6"]);
    assert.deepEqual(row(out, "in-worktree"), ["merged, still in use", "4d", "#4", "worktree"]);
    assert.deepEqual(row(out, "GRE-7-task-done"), ["merged, not in use", "10d", "#5", "-"]);
    assert.deepEqual(row(out, "gone-worktree"), ["merged, not in use", "11d", "#6", "-"]);
    assert.deepEqual(row(out, "closed-only"), ["no PR", "20d", "(#7 closed)", "-"]);
    assert.deepEqual(row(out, "never-pr"), ["no PR", "30d", "-", "-"]);
    assert.ok(!out.split("\n").some((l) => l.startsWith("main ")), "the default branch is not listed");
    assert.match(out, /Totals \(8 branches; main not listed\)/);
    assert.match(out, /open PR:\s+1\n/);
    assert.match(out, /merged, still in use:\s+3\n/);
    assert.match(out, /merged, not in use:\s+2\n/);
    assert.match(out, /no PR:\s+2\n/);
    assert.deepEqual([...new Set(methods)], ["GET"], "the server is only read");
    assert.match(readFileSync(join(box.root, "gh-calls"), "utf8"), /^pr list /m, "gh is only asked to list");
  } finally {
    server.close();
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("with no GSAM server, worktrees still count as use and the report says so", async () => {
  const box = sandbox();
  try {
    const out = await report(box, "http://127.0.0.1:9");
    assert.match(out, /could not read open tasks/);
    assert.equal(row(out, "in-worktree")[0], "merged, still in use");
    assert.equal(row(out, "GRE-5-task-open")[0], "merged, not in use");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("the script has no write call to git or GitHub", () => {
  const code = readFileSync(script, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  for (const bad of [/\bpush\b/, /branch\s+-[dD]\b/, /\bDELETE\b/, /\b(POST|PUT|PATCH)\b/, /\bmethod\s*:/, /\s-X\s/, /--prune\b/, /\bgh\s+api\b/, /\bupdate-ref\b/]) {
    assert.doesNotMatch(code, bad);
  }
});
