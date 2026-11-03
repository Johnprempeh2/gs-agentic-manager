import { and, eq, inArray } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@greatstone/db";
import { liveDesignBusyAgents, liveDesignWakeMessage, type LiveDesignSession } from "./live-design.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

/**
 * Which agent runs live design, and waking it. Shared by task files (issue
 * routes) and website pages (website routes).
 */

/** A live designer for the company (agent metadata `liveDesigner: true`) not already in a session. */
export async function pickLiveDesigner(db: Db, companyId: string): Promise<string | null> {
  const rows = await db
    .select({ id: agents.id, status: agents.status, metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const designers = rows.filter(
    (a) => (a.metadata as Record<string, unknown> | null)?.liveDesigner === true && !["paused", "terminated", "archived"].includes(a.status),
  );
  // A designer already in a session is not double-booked: the caller's fallback agent steps in instead.
  const busy = liveDesignBusyAgents();
  return designers.find((a) => !busy.has(a.id))?.id ?? null;
}

/** The agent already has a run queued or going: never wake a second one for the same session. */
export async function agentHasActiveRun(db: Db, agentId: string) {
  const rows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
    .limit(1);
  return rows.length > 0;
}

/**
 * Wakes the session's agent. An agent that does not own the task (a designer,
 * or any website page) is woken for the session, not on a task: it reads the
 * page and returns the new one through the session.
 */
export async function wakeLiveDesignAgent(
  heartbeat: Pick<IssueAssignmentWakeupDeps, "wakeup">,
  input: { session: LiveDesignSession; onTaskIssueId: string | null; fileName: string; actorId: string },
) {
  const { session, onTaskIssueId } = input;
  await heartbeat.wakeup(session.agentId, {
    source: "on_demand",
    triggerDetail: "manual",
    reason: "live_design",
    idempotencyKey: `live_design:${session.id}:${Math.floor(Date.now() / 60_000)}`,
    requestedByActorType: "user",
    requestedByActorId: input.actorId,
    payload: { ...(onTaskIssueId ? { issueId: onTaskIssueId } : {}), liveDesignSessionId: session.id },
    contextSnapshot: {
      ...(onTaskIssueId ? { issueId: onTaskIssueId, taskId: onTaskIssueId } : {}),
      wakeReason: "live_design",
      source: "issue.live_design",
      skipIssueComment: true,
      liveDesignSessionId: session.id,
      paperclipAgentMessage: { source: "live_design", sessionId: session.id, text: liveDesignWakeMessage(session.id, input.fileName) },
    },
  });
}
