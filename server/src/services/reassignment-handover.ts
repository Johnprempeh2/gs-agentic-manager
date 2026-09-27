// GRE-36: reassignment hands work over instead of dropping it.
//
// Live data (2026-09-27): 17 of 19 `issue_reassigned` cancellations were a run
// cancelling itself. The agent's last step was "hand this to the reviewer",
// and the PATCH that did it stopped the very run that sent it. The other case
// was a run killed while still preparing, before its provider process started.
//
// decideReassignmentRunStop picks one of three outcomes for the live run of
// the old assignee. buildReassignmentHandover collects what the old run left
// behind so the new assignee does not start from zero.
import { execFile } from "node:child_process";
import { and, desc, eq } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issueComments, issues, type Db } from "@greatstone/db";
import type { ExecutionContinuationEnvelope } from "@greatstone/shared";

/** A self-handoff may finish its current turn for at most this long. */
export const SELF_HANDOFF_GRACE_MS = 2 * 60_000;
const HANDOVER_TEXT_LIMIT = 4_000;
const HANDOVER_FILE_LIMIT = 200;

export type ReassignmentRunStopDecision =
  /** The run asked for the reassignment itself: let it finish, bounded by graceMs. */
  | { kind: "let_finish"; graceMs: number }
  /** The provider never started, so no work is lost and nothing is handed over. */
  | { kind: "withdraw_before_start" }
  /** Another actor took the task from a working run: stop it and hand over. */
  | { kind: "interrupt" };

export function decideReassignmentRunStop(facts: {
  runAgentId: string;
  runId: string;
  runtimeMode: string | null;
  processStartedAt: Date | null;
  actorAgentId: string | null;
  actorRunId: string | null;
}): ReassignmentRunStopDecision {
  // Native runs have their own goal and stop protocol; keep them unchanged.
  if (facts.runtimeMode === "native") return { kind: "interrupt" };
  if (facts.actorRunId === facts.runId && facts.actorAgentId === facts.runAgentId) {
    return { kind: "let_finish", graceMs: SELF_HANDOFF_GRACE_MS };
  }
  if (!facts.processStartedAt) return { kind: "withdraw_before_start" };
  return { kind: "interrupt" };
}

export type ChangedFilesLister = (input: { cwd: string; baseRef: string | null }) => Promise<string[] | null>;

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 5_000, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout));
  });
}

/** Files the branch changed against its base, plus uncommitted and untracked files. */
export const listChangedFilesWithGit: ChangedFilesLister = async ({ cwd, baseRef }) => {
  const base = baseRef ? (await git(cwd, ["merge-base", "HEAD", baseRef]))?.trim() || null : null;
  const [diff, untracked] = await Promise.all([
    git(cwd, ["diff", "--name-only", ...(base ? [base] : ["HEAD"])]),
    git(cwd, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  if (diff === null && untracked === null) return null;
  return parseChangedFiles(`${diff ?? ""}\n${untracked ?? ""}`);
};

export function parseChangedFiles(output: string): string[] {
  const files = [...new Set(output.split("\n").map((line) => line.trim()).filter(Boolean))].sort();
  return files.slice(0, HANDOVER_FILE_LIMIT);
}

const clip = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.slice(0, HANDOVER_TEXT_LIMIT) : null;

/**
 * What the previous assignee's run left behind. Returns null unless the source
 * run belongs to this task and to a different agent. Everything here is
 * low-trust evidence: it is rendered with the other continuation evidence.
 */
export async function buildReassignmentHandover(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string;
  sourceRunId: string | null;
  listChangedFiles?: ChangedFilesLister;
}): Promise<ExecutionContinuationEnvelope["handover"] | null> {
  const { db, companyId, issueId } = input;
  if (!input.sourceRunId) return null;
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, input.sourceRunId)));
  if (!run || run.agentId === input.agentId) return null;
  const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
  if (context.issueId !== issueId) return null;
  const result = (run.resultJson ?? {}) as Record<string, unknown>;
  const nativeResult = (result.nativeResult ?? {}) as Record<string, unknown>;
  const [lastComment] = await db.select({ id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.authorAgentId, run.agentId)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(1);
  const [workspace] = await db.select({
    cwd: executionWorkspaces.cwd, baseRef: executionWorkspaces.baseRef,
    branchName: executionWorkspaces.branchName, providerType: executionWorkspaces.providerType,
  }).from(issues)
    .innerJoin(executionWorkspaces, eq(executionWorkspaces.id, issues.executionWorkspaceId))
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  const changedFiles = workspace?.cwd && workspace.providerType === "local_fs"
    ? await (input.listChangedFiles ?? listChangedFilesWithGit)({ cwd: workspace.cwd, baseRef: workspace.baseRef })
      .catch(() => null)
    : null;
  return {
    fromRunId: run.id,
    fromAgentId: run.agentId,
    runStatus: run.status,
    runSummary: clip(nativeResult.summary) ?? clip(result.summary),
    lastComment: lastComment
      ? { id: lastComment.id, body: clip(lastComment.body) ?? "", createdAt: lastComment.createdAt.toISOString() }
      : null,
    branchName: workspace?.branchName ?? null,
    changedFiles,
  };
}
