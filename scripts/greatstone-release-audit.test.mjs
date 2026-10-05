// Sandbox tests for scripts/greatstone-release-audit.sh (GRE-767). The release
// repo is a temp git repo with fixed rc-*/live-* tags, and the live server is a
// local fake that answers /api/health and the issue search. Nothing under
// ~/GSAM is read or written, and no live server is contacted.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const scriptsDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// Three commits on main: rc-.1 (live-.1), rc-.2 (live-.2), rc-.3 (not live).
function repo() {
  const root = mkdtempSync(join(tmpdir(), "gs-release-audit-"));
  git(root, "init", "--quiet");
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) git(root, "config", k, v);
  const commits = [];
  for (const n of [1, 2, 3]) {
    git(root, "commit", "--quiet", "--allow-empty", "-m", `c${n}`);
    git(root, "tag", "-a", `rc-2026-10-04.${n}`, "-m", `Candidate ${n}`);
    if (n < 3) git(root, "tag", "-a", `live-2026-10-04.${n}`, "-m", `Candidate ${n}`);
    commits.push(git(root, "rev-parse", "HEAD"));
  }
  return { root, commits };
}

// A fake live server: /api/health gives <commit>; the issue search returns the
// issues whose title holds the query.
function fakeLive(commit, issues) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/health") return res.end(JSON.stringify({ status: "ok", commit }));
    if (url.pathname === "/api/companies") return res.end(JSON.stringify([{ id: "c1", issuePrefix: "GRE" }]));
    if (url.pathname === "/api/companies/c1/issues") {
      const q = url.searchParams.get("q") ?? "";
      return res.end(JSON.stringify(issues.filter((i) => i.title.includes(q))));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function audit(box, liveCommit, issues) {
  const server = await fakeLive(liveCommit, issues);
  const methods = [];
  server.on("request", (req) => methods.push(req.method));
  const env = { ...process.env, GSAM_ROOT: box.root, GSAM_RELEASE_REPO: box.root, GSAM_LIVE_URL: `http://127.0.0.1:${server.address().port}` };
  delete env.GSAM_API_KEY;
  delete env.GSAM_COMPANY_ID;
  try {
    const { stdout } = await promisify(execFile)("bash", [join(scriptsDir, "greatstone-release-audit.sh")], { env, encoding: "utf8" });
    return { stdout, methods };
  } finally {
    server.close();
  }
}

const task = (rc, status = "todo") => ({ identifier: "GRE-9", status, title: `John: release ${rc} to live (by hand)` });
const verdictOf = (stdout) => stdout.match(/verdict:\s+(.*)/)[1];

test("match: live is on the tag the open release task names", async () => {
  const box = repo();
  try {
    const { stdout, methods } = await audit(box, box.commits[1], [task("rc-2026-10-04.2")]);
    assert.equal(verdictOf(stdout), "match");
    assert.match(stdout, /live tags:\s+live-2026-10-04\.2/);
    assert.match(stdout, /rc tags:\s+rc-2026-10-04\.2/);
    assert.match(stdout, /release task:\s+GRE-9 names rc-2026-10-04\.2/);
    assert.deepEqual([...new Set(methods)], ["GET"], "the audit only reads");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("live moved past task: live runs a newer tag than the open task names", async () => {
  const box = repo();
  try {
    const { stdout } = await audit(box, box.commits[1], [task("rc-2026-10-04.1"), task("rc-2026-10-03.1", "done")]);
    assert.equal(verdictOf(stdout), "live moved past task (live-2026-10-04.2)");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("live behind task: the open task names a candidate live does not run yet", async () => {
  const box = repo();
  try {
    const { stdout } = await audit(box, box.commits[1], [task("rc-2026-10-04.3")]);
    assert.equal(verdictOf(stdout), "live behind task");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("each live tag shows its rc and whether Flint checked it", async () => {
  const box = repo();
  try {
    const { stdout } = await audit(box, box.commits[1], [
      { identifier: "GRE-1", status: "done", title: "Flint: preview check of rc-2026-10-04.1 (daily candidate)" },
      { identifier: "GRE-2", status: "done", title: "Flint: check live after rc-2026-10-04.1" },
      // A cancelled check and John's own task do not count.
      { identifier: "GRE-3", status: "cancelled", title: "Flint: check live after John releases rc-2026-10-04.2" },
      task("rc-2026-10-04.2", "done"),
      // rc-2026-10-04.20 is not rc-2026-10-04.2.
      { identifier: "GRE-4", status: "done", title: "Flint: preview check of rc-2026-10-04.20" },
    ]);
    assert.equal(verdictOf(stdout), "no open release task");
    assert.match(stdout, /live-2026-10-04\.1\s+\S+\s+rc-2026-10-04\.1\s+checked \(GRE-1\)\s+checked \(GRE-2\)/);
    assert.match(stdout, /live-2026-10-04\.2\s+\S+\s+rc-2026-10-04\.2\s+NOT CHECKED\s+NOT CHECKED/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});
