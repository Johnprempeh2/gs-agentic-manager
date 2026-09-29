// Client "What's new" (GRE-128) against a real git repository in a temp
// folder: the notes come from the stable-* tag on the running commit only.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientVersionRoutes } from "../routes/client-version.js";
import { gitReader, readClientVersion } from "../services/client-version.js";

let repo: string;
let head: string;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "client-version-"));
  git("init", "--quiet", "-b", "main");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) git("config", k, v);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "--quiet", "-m", "first");
  head = git("rev-parse", "HEAD");
  git("tag", "-a", "live-2026-09-27.1", "-m", "Run limits\n\nFeatures\n- Run limits in settings (#49, GRE-117)");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("readClientVersion", () => {
  it("reads the client notes from the stable tag on the running commit", () => {
    git("tag", "-a", "stable-2026-09-28.1", "-m", "Run limits you can set in Settings.\nA faster board.");
    expect(readClientVersion(gitReader(repo), head)).toEqual({
      label: "2026-09-28.1",
      stableTag: "stable-2026-09-28.1",
      notes: "Run limits you can set in Settings.\nA faster board.",
    });
  });

  it("with no stable tag shows the version and no notes, never the live changelog", () => {
    const version = readClientVersion(gitReader(repo), head);
    expect(version).toEqual({ label: "2026-09-27.1", stableTag: null, notes: null });
    expect(JSON.stringify(version)).not.toMatch(/#49|GRE-117|Run limits/);
  });

  it("falls back to the short commit when no release tag is on it", () => {
    git("tag", "-d", "live-2026-09-27.1");
    expect(readClientVersion(gitReader(repo), head)).toEqual({ label: head.slice(0, 7), stableTag: null, notes: null });
  });

  it("hides notes that carry internal numbers", () => {
    git("tag", "-a", "stable-2026-09-28.1", "-m", "Run limits (#49, GRE-117)");
    expect(readClientVersion(gitReader(repo), head)).toEqual({ label: "2026-09-28.1", stableTag: "stable-2026-09-28.1", notes: null });
  });

  it("shows no notes when git cannot be read", () => {
    expect(readClientVersion(gitReader(null), head)).toEqual({ label: head.slice(0, 7), stableTag: null, notes: null });
    expect(readClientVersion(gitReader(repo), null)).toEqual({ label: null, stableTag: null, notes: null });
  });
});

describe("GET /api/companies/:companyId/version", () => {
  function app(companyIds: string[]) {
    const a = express();
    a.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: "agent-1", companyId: companyIds[0], source: "agent_key" } as Express.Request["actor"];
      next();
    });
    a.use("/api", clientVersionRoutes({ git: gitReader(repo), runningCommit: () => head }));
    a.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status ?? 500).json({});
    });
    return a;
  }

  it("answers any member of the company", async () => {
    git("tag", "-a", "stable-2026-09-28.1", "-m", "A faster board.");
    const res = await request(app(["company-1"])).get("/api/companies/company-1/version");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: "2026-09-28.1", stableTag: "stable-2026-09-28.1", notes: "A faster board." });
  });

  it("refuses another company", async () => {
    const res = await request(app(["company-2"])).get("/api/companies/company-1/version");
    expect(res.status).toBe(403);
  });
});
