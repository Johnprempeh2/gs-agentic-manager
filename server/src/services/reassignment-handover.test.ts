import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SELF_HANDOFF_GRACE_MS,
  decideReassignmentRunStop,
  listChangedFilesWithGit,
  parseChangedFiles,
} from "./reassignment-handover.js";

const base = {
  runId: "run-a",
  runAgentId: "agent-a",
  runtimeMode: "legacy",
  processStartedAt: new Date("2026-09-27T20:00:00Z"),
  actorAgentId: "agent-board",
  actorRunId: null,
};

describe("decideReassignmentRunStop (GRE-36)", () => {
  it("lets a run that hands its own task over finish its turn, with a bounded grace", () => {
    // 17 of 19 live `issue_reassigned` cancels were this case.
    expect(decideReassignmentRunStop({ ...base, actorAgentId: "agent-a", actorRunId: "run-a" }))
      .toEqual({ kind: "let_finish", graceMs: SELF_HANDOFF_GRACE_MS });
    expect(SELF_HANDOFF_GRACE_MS).toBeLessThanOrEqual(2 * 60_000);
  });

  it("does not treat another run of the same agent as a self-handoff", () => {
    expect(decideReassignmentRunStop({ ...base, actorAgentId: "agent-a", actorRunId: "run-other" }))
      .toEqual({ kind: "interrupt" });
  });

  it("withdraws a run reassigned before its provider process started", () => {
    // Live case 258b98d3: started 5s before the reassignment, no process yet.
    expect(decideReassignmentRunStop({ ...base, processStartedAt: null }))
      .toEqual({ kind: "withdraw_before_start" });
  });

  it("interrupts a working run when someone else reassigns the task", () => {
    expect(decideReassignmentRunStop(base)).toEqual({ kind: "interrupt" });
  });

  it("keeps native runs on their own stop protocol", () => {
    expect(decideReassignmentRunStop({ ...base, runtimeMode: "native", actorAgentId: "agent-a", actorRunId: "run-a" }))
      .toEqual({ kind: "interrupt" });
  });
});

describe("changed files for the handover", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("dedupes, sorts, and drops blank lines", () => {
    expect(parseChangedFiles("b.ts\na.ts\n\nb.ts\n")).toEqual(["a.ts", "b.ts"]);
  });

  it("lists committed, uncommitted, and untracked changes against the base", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gre36-handover-"));
    dirs.push(cwd);
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(cwd, "base.txt"), "base\n");
    git("add", "."); git("commit", "-qm", "base");
    git("checkout", "-qb", "feature");
    writeFileSync(join(cwd, "committed.ts"), "x\n");
    git("add", "."); git("commit", "-qm", "work");
    writeFileSync(join(cwd, "base.txt"), "edited\n");
    writeFileSync(join(cwd, "new.ts"), "y\n");
    await expect(listChangedFilesWithGit({ cwd, baseRef: "main" }))
      .resolves.toEqual(["base.txt", "committed.ts", "new.ts"]);
  });

  it("returns null when the workspace is not a git checkout", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gre36-nogit-"));
    dirs.push(cwd);
    await expect(listChangedFilesWithGit({ cwd: join(cwd, "missing"), baseRef: "main" })).resolves.toBeNull();
  });
});
