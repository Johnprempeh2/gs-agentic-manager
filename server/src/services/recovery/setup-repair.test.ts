import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSetupRepairBlockedComment,
  buildSetupRepairResumeComment,
  classifySetupRepairCause,
  decideSetupRepair,
  inspectWorktreeSafety,
  repointWorktreeToTaskBranch,
} from "./setup-repair.js";

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A task repo: `main` pushed to a bare origin, plus a task worktree whose
// checked-out branch can be moved off the task branch to model the mismatch.
async function makeTaskRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "setup-repair-"));
  tempDirs.push(root);
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", origin, repo);
  git(repo, "config", "user.email", "ridge@example.com");
  git(repo, "config", "user.name", "Ridge");
  await fs.writeFile(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "push", "origin", "main");
  const worktree = path.join(root, "GRE-1-task");
  git(repo, "worktree", "add", "-b", "GRE-1-task", worktree, "main");
  return { root, repo, worktree };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("classifySetupRepairCause", () => {
  it("names the three repairable causes and nothing else", () => {
    expect(classifySetupRepairCause({ errorCode: "workspace_validation_failed" })).toBe("workspace_mismatch");
    expect(
      classifySetupRepairCause({
        errorCode: "setup_failed",
        resultJson: { workspaceReuseFailure: { executionWorkspaceId: "ws-1" } },
      }),
    ).toBe("workspace_reuse_failed");
    expect(
      classifySetupRepairCause({
        errorCode: "setup_failed",
        error: "Issue GRE-1 requested inherited execution workspace reuse for ws-1, but the workspace could not be restored.",
      }),
    ).toBe("workspace_reuse_failed");
    expect(classifySetupRepairCause({ errorCode: "setup_failed", error: "boom" })).toBeNull();
    // The first process loss keeps its existing retry; only a lost retry is ours.
    expect(classifySetupRepairCause({ errorCode: "process_lost", retryOfRunId: null })).toBeNull();
    expect(classifySetupRepairCause({ errorCode: "process_lost", retryOfRunId: "run-0" })).toBe("process_lost");
    expect(classifySetupRepairCause({ errorCode: "adapter_failed" })).toBeNull();
  });
});

describe("decideSetupRepair", () => {
  const safe = { state: "safe" as const, currentBranch: "GRE-1-task" };

  it("repairs a safe first failure", () => {
    expect(decideSetupRepair({ cause: "workspace_mismatch", recentRepairCount: 0, safety: safe })).toEqual({ kind: "repair" });
    expect(decideSetupRepair({ cause: "workspace_reuse_failed", recentRepairCount: 0, safety: { state: "missing" } })).toEqual({ kind: "repair" });
  });

  it("blocks the same cause twice in the window", () => {
    expect(decideSetupRepair({ cause: "workspace_mismatch", recentRepairCount: 1, safety: safe })).toEqual({
      kind: "block",
      reason: "the same failure happened twice in 30 minutes",
    });
  });

  it("blocks when work is at risk", () => {
    expect(
      decideSetupRepair({ cause: "workspace_mismatch", recentRepairCount: 0, safety: { state: "at_risk", reason: "dirty" } }),
    ).toEqual({ kind: "block", reason: "dirty" });
  });

  it("never retries a lost process retry", () => {
    expect(decideSetupRepair({ cause: "process_lost", recentRepairCount: 0, safety: null }).kind).toBe("block");
  });
});

describe("plain comments", () => {
  it("says what stopped, that the app fixed it, and to carry on", () => {
    expect(buildSetupRepairResumeComment("workspace_mismatch")).toBe(
      "Your run stopped because its workspace was on the wrong branch or path. The app fixed it (put the workspace back on the task branch). Please carry on.",
    );
  });

  it("names the board as owner when blocked", () => {
    expect(buildSetupRepairBlockedComment("process_lost", "the retry was lost too")).toMatch(
      /^Your run stopped because its process was lost\. The app did not retry: the retry was lost too\. The board must act: /,
    );
  });
});

describe("inspectWorktreeSafety and repointWorktreeToTaskBranch", () => {
  it("treats a missing workspace as nothing to lose", async () => {
    expect(await inspectWorktreeSafety({ cwd: "/nonexistent/gre-395", expectedBranchName: "x" })).toEqual({ state: "missing" });
  });

  it("repoints a clean worktree on the wrong branch back to the task branch", async () => {
    const { worktree } = await makeTaskRepo();
    // The task branch has a local, unpushed commit: it stays on the branch.
    await fs.writeFile(path.join(worktree, "task.txt"), "work\n");
    git(worktree, "add", "task.txt");
    git(worktree, "commit", "-m", "task work");
    const taskHead = git(worktree, "rev-parse", "HEAD");
    git(worktree, "switch", "-c", "stray", "origin/main");

    const safety = await inspectWorktreeSafety({ cwd: worktree, expectedBranchName: "GRE-1-task" });
    expect(safety).toEqual({ state: "safe", currentBranch: "stray" });
    expect(await repointWorktreeToTaskBranch({ cwd: worktree, expectedBranchName: "GRE-1-task" })).toEqual({ ok: true });
    expect(git(worktree, "symbolic-ref", "--short", "HEAD")).toBe("GRE-1-task");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(taskHead);
  });

  it("flags uncommitted changes as at risk", async () => {
    const { worktree } = await makeTaskRepo();
    await fs.writeFile(path.join(worktree, "wip.txt"), "wip\n");
    const safety = await inspectWorktreeSafety({ cwd: worktree, expectedBranchName: "GRE-1-task" });
    expect(safety.state).toBe("at_risk");
  });

  it("flags commits that are on neither the task branch nor a remote as at risk", async () => {
    const { worktree } = await makeTaskRepo();
    git(worktree, "switch", "-c", "stray");
    await fs.writeFile(path.join(worktree, "stray.txt"), "stray\n");
    git(worktree, "add", "stray.txt");
    git(worktree, "commit", "-m", "stray work");
    const safety = await inspectWorktreeSafety({ cwd: worktree, expectedBranchName: "GRE-1-task" });
    expect(safety).toEqual({
      state: "at_risk",
      reason: "1 commit is on stray, not pushed and not on the task branch",
    });
  });

  it("flags a directory that is not a git checkout as at risk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "setup-repair-plain-"));
    tempDirs.push(root);
    expect((await inspectWorktreeSafety({ cwd: root, expectedBranchName: "x" })).state).toBe("at_risk");
  });
});
