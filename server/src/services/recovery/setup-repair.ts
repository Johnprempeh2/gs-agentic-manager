import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

// GRE-395: a run that fails on a known, repairable setup cause is repaired by
// the app and the agent is woken once, instead of a human finding the cause,
// fixing it, and posting "Please carry on." An unsafe repair, or the same cause
// twice in 30 minutes, blocks the task with a named owner instead.

const execFile = promisify(execFileCallback);

export const SETUP_REPAIR_RETRY_REASON = "setup_repair";
export const SETUP_REPAIR_WAKE_REASON = "setup_repair_resume";
export const SETUP_REPAIR_REPEAT_WINDOW_MS = 30 * 60 * 1000;
export const SETUP_REPAIR_BLOCK_OWNER = "board" as const;

export type SetupRepairCause =
  | "workspace_mismatch"
  | "workspace_reuse_failed"
  | "process_lost";

type SetupRepairRun = {
  errorCode: string | null;
  error?: string | null;
  resultJson?: unknown;
  contextSnapshot?: unknown;
  retryOfRunId?: string | null;
};

function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const INHERITED_REUSE_FAILURE_RE = /requested inherited execution workspace reuse for/i;

/**
 * Names the repairable setup cause of a failed run, or null when the failure
 * is not one the app may repair by itself. `process_lost` only counts once the
 * run was itself a retry: the first loss keeps its existing retry path.
 */
export function classifySetupRepairCause(run: SetupRepairRun): SetupRepairCause | null {
  if (run.errorCode === "workspace_validation_failed") return "workspace_mismatch";
  if (run.errorCode === "setup_failed") {
    const result = parseObject(run.resultJson);
    if (Object.keys(parseObject(result.workspaceReuseFailure)).length > 0) return "workspace_reuse_failed";
    if (INHERITED_REUSE_FAILURE_RE.test(run.error ?? "")) return "workspace_reuse_failed";
    return null;
  }
  if (run.errorCode === "process_lost" && readString(run.retryOfRunId)) return "process_lost";
  return null;
}

/** The workspace a repair acts on, read from the failed run's own evidence. */
export function readSetupRepairWorkspaceHint(run: SetupRepairRun): {
  executionWorkspaceId: string | null;
  cwd: string | null;
  expectedBranchName: string | null;
} {
  const result = parseObject(run.resultJson);
  const validation = parseObject(result.workspaceValidation);
  const branch = parseObject(validation.managedGitWorktreeBranch);
  const reuse = parseObject(result.workspaceReuseFailure);
  return {
    executionWorkspaceId:
      readString(validation.executionWorkspaceId) ??
      readString(validation.persistedExecutionWorkspaceId) ??
      readString(branch.executionWorkspaceId) ??
      readString(reuse.executionWorkspaceId),
    cwd:
      readString(validation.worktreePath) ??
      readString(branch.worktreePath) ??
      readString(validation.executionWorkspaceCwd),
    expectedBranchName:
      readString(validation.expectedBranchName) ?? readString(branch.expectedBranchName),
  };
}

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout } = await execFile("git", args, { cwd, timeout: 15_000 });
  return String(stdout).trim();
};

export type WorktreeSafety =
  | { state: "missing" }
  | { state: "safe"; currentBranch: string | null }
  | { state: "at_risk"; reason: string };

/**
 * Says whether repointing or replacing a worktree could lose work. Uncommitted
 * or untracked files are at risk. So are commits on HEAD that are on neither
 * the task branch nor any remote, because a workspace rebuilt from the task
 * branch would not carry them.
 */
export async function inspectWorktreeSafety(input: {
  cwd: string | null;
  expectedBranchName: string | null;
  git?: GitRunner;
}): Promise<WorktreeSafety> {
  const git = input.git ?? defaultGitRunner;
  if (!input.cwd) return { state: "missing" };
  const exists = await fs.stat(input.cwd).then((s) => s.isDirectory(), () => false);
  if (!exists) return { state: "missing" };

  const topLevel = await git(["rev-parse", "--show-toplevel"], input.cwd).catch(() => null);
  if (!topLevel) return { state: "at_risk", reason: `${input.cwd} exists but is not a git checkout` };

  const status = await git(["status", "--porcelain"], input.cwd).catch(() => null);
  if (status === null) return { state: "at_risk", reason: `git status failed in ${input.cwd}` };
  if (status.length > 0) return { state: "at_risk", reason: `the workspace has uncommitted changes in ${input.cwd}` };

  const currentBranch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], input.cwd).catch(() => null);
  const expectedRef = input.expectedBranchName
    ? await git(["rev-parse", "--verify", "--quiet", `refs/heads/${input.expectedBranchName}`], input.cwd).catch(() => null)
    : null;
  const unique = await git(
    ["rev-list", "--count", "HEAD", "--not", "--remotes", ...(expectedRef ? [expectedRef] : [])],
    input.cwd,
  ).catch(() => null);
  if (unique === null) return { state: "at_risk", reason: `could not count unpushed commits in ${input.cwd}` };
  const count = Number.parseInt(unique, 10);
  if (!Number.isFinite(count) || count > 0) {
    return {
      state: "at_risk",
      reason: `${count} commit${count === 1 ? " is" : "s are"} on ${currentBranch ?? "a detached HEAD"}, not pushed and not on the task branch`,
    };
  }
  return { state: "safe", currentBranch };
}

/**
 * Puts a clean, safe worktree back on its task branch. Only call after
 * inspectWorktreeSafety returned "safe": every commit on HEAD is on a remote
 * or the task branch, so switching discards nothing.
 */
export async function repointWorktreeToTaskBranch(input: {
  cwd: string;
  expectedBranchName: string;
  git?: GitRunner;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const git = input.git ?? defaultGitRunner;
  const localExists = await git(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${input.expectedBranchName}`],
    input.cwd,
  ).then(() => true, () => false);
  const args = localExists
    ? ["switch", input.expectedBranchName]
    : ["switch", "--track", "-c", input.expectedBranchName, `origin/${input.expectedBranchName}`];
  try {
    await git(args, input.cwd);
  } catch (error) {
    return {
      ok: false,
      reason: `could not switch to ${input.expectedBranchName}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    };
  }
  const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], input.cwd).catch(() => null);
  return head === input.expectedBranchName
    ? { ok: true }
    : { ok: false, reason: `HEAD is ${head ?? "detached"} after switching to ${input.expectedBranchName}` };
}

export type SetupRepairDecision =
  | { kind: "repair" }
  | { kind: "block"; reason: string };

export function decideSetupRepair(input: {
  cause: SetupRepairCause;
  /** Earlier repairs of this cause on this task inside the repeat window. */
  recentRepairCount: number;
  safety: WorktreeSafety | null;
}): SetupRepairDecision {
  if (input.cause === "process_lost") {
    return { kind: "block", reason: "the retry was lost too" };
  }
  if (input.recentRepairCount > 0) {
    return { kind: "block", reason: "the same failure happened twice in 30 minutes" };
  }
  if (input.safety?.state === "at_risk") {
    return { kind: "block", reason: input.safety.reason };
  }
  return { kind: "repair" };
}

const CAUSE_TEXT: Record<SetupRepairCause, string> = {
  workspace_mismatch: "its workspace was on the wrong branch or path",
  workspace_reuse_failed: "its saved workspace could not be reused",
  process_lost: "its process was lost",
};

const FIX_TEXT: Record<Exclude<SetupRepairCause, "process_lost">, string> = {
  workspace_mismatch: "put the workspace back on the task branch",
  workspace_reuse_failed: "gave the task a fresh workspace from its own branch",
};

const BLOCK_ACTION: Record<SetupRepairCause, string> = {
  workspace_mismatch: "check the workspace, save or push any work in it, then set the task back to in progress",
  workspace_reuse_failed: "check the saved workspace, save or push any work in it, then set the task back to in progress",
  process_lost: "check why the agent process stops, then set the task back to in progress",
};

export function buildSetupRepairResumeComment(cause: Exclude<SetupRepairCause, "process_lost">) {
  return `Your run stopped because ${CAUSE_TEXT[cause]}. The app fixed it (${FIX_TEXT[cause]}). Please carry on.`;
}

export function buildSetupRepairBlockedComment(cause: SetupRepairCause, reason: string) {
  return `Your run stopped because ${CAUSE_TEXT[cause]}. The app did not retry: ${reason}. The board must act: ${BLOCK_ACTION[cause]}.`;
}

export function buildSetupRepairUnblockAction(cause: SetupRepairCause) {
  return `${BLOCK_ACTION[cause][0]!.toUpperCase()}${BLOCK_ACTION[cause].slice(1)}.`;
}
