import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  heartbeatRunEvents,
  issueComments,
  issueThreadInteractions,
  issues,
  runIdentityContexts,
  type Db,
} from "@greatstone/db";
import { conflict, forbidden } from "../errors.js";
import { isDeadlockDetected } from "../db-errors.js";
import { isUuidLike } from "@greatstone/shared";
import { queuedCommentIdsFromRunContext, queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";

export const QUEUED_INTERRUPT_SPENT = "queued_interrupt_spent";

/** Resolve an explicit click from persisted receipts, never caller context or message authors. */
export async function explicitOperatorRunIdentity(
  executor: Pick<Db, "select">,
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "contextSnapshot" | "wakeupRequestId">,
) {
  const [request] = run.wakeupRequestId ? await executor.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, run.companyId),
    eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.runId, run.id),
  )) : [];
  if (request?.payload?.manualUserWake === true) {
    if (request.requestedByActorType !== "user" || !request.requestedByActorId) {
      throw forbidden("Manual wake requires an authenticated user");
    }
    return { actorId: request.requestedByActorId, cause: "manual_user_wake" };
  }
  const prefix = "queued-comment-interrupt:";
  if (!request?.idempotencyKey?.startsWith(prefix)) return null;
  const queueId = request.idempotencyKey.slice(prefix.length);
  // The key only locates a candidate. The consumed queue, actor, run, company,
  // agent, task, and delivered messages must all independently agree.
  if (!isUuidLike(queueId)) {
    throw forbidden("Queued-message interrupt authority is unavailable");
  }
  const [receipt] = await executor.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, queueId), eq(agentWakeupRequests.companyId, run.companyId),
    eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.runId, run.id),
    eq(agentWakeupRequests.status, "coalesced"),
  ));
  // Another run already consumed this queue: nothing is left to deliver.
  if (!receipt) throw forbidden("Queued-message interrupt authority is unavailable", { code: QUEUED_INTERRUPT_SPENT });
  const marker = receipt.payload?.queuedCommentInterrupt;
  const actorId = marker && typeof marker === "object" && "actorId" in marker ? marker.actorId : null;
  const ids = queuedCommentIdsFromWakePayload(receipt?.payload);
  const deliveredIds = queuedCommentIdsFromRunContext(run.contextSnapshot);
  // A decision answer queued without a typed message is delivered by the run too.
  const answerOnly = !ids.length && receipt.payload?.mutation === "interaction" &&
    typeof receipt.payload?.interactionId === "string";
  if (typeof actorId !== "string" || !actorId || (!ids.length && !answerOnly) ||
      receipt.payload?.issueId !== run.contextSnapshot?.issueId ||
      !ids.every(id => deliveredIds.includes(id)) ||
      request.requestedByActorType !== "user" || request.requestedByActorId !== actorId) {
    throw forbidden("Queued-message interrupt authority is unavailable");
  }
  return { actorId, cause: "queued_comment_interrupt" };
}

export type RunIdentityContext = typeof runIdentityContexts.$inferSelect;
type Executor = Pick<Db, "select" | "insert" | "update">;

/**
 * Identity changes lock the task row, then the run row, with FOR NO KEY UPDATE.
 *
 * Never FOR UPDATE here. Every insert of a row that references a run or a task
 * (document revisions, comments, audit rows, events) takes FOR KEY SHARE on the
 * parent row in its foreign key check, and FOR UPDATE is the only row lock that
 * conflicts with FOR KEY SHARE. A writer that references the run before the task
 * then waits for this task lock while this transaction waits for the writer's
 * run key share: a deadlock (live, 2 to 3 Oct 2026). NO KEY UPDATE still excludes
 * every other identity transaction and every UPDATE of these rows.
 */
const IDENTITY_ROW_LOCK = "no key update" as const;

/** The task a run is bound to, or `invalid` when the stored reference is malformed. */
function identityTaskId(
  run: Pick<typeof heartbeatRuns.$inferSelect, "contextSnapshot" | "nativeIssueId">,
): string | null | "invalid" {
  const issueId = run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.nativeIssueId;
  if (issueId === undefined || issueId === null) return null;
  return typeof issueId === "string" && isUuidLike(issueId) ? issueId : "invalid";
}

/** Match task mutation ordering: lock the task before the run, never the reverse. */
async function lockIdentityTask(
  executor: Pick<Db, "select">,
  companyId: string,
  runId: string,
) {
  const [run] = await executor
    .select({
      contextSnapshot: heartbeatRuns.contextSnapshot,
      nativeIssueId: heartbeatRuns.nativeIssueId,
    })
    .from(heartbeatRuns)
    .where(
      and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)),
    );
  const issueId = run ? identityTaskId(run) : null;
  if (issueId === "invalid") throw forbidden("Run task identity is invalid");
  if (issueId)
    await executor
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .for(IDENTITY_ROW_LOCK);
}

async function append(
  executor: Executor,
  input: {
    companyId: string;
    runId: string;
    responsibleUserId: string | null;
    messageId?: string | null;
    parentContextId?: string | null;
    cause: string;
    correlationId: string;
    status?: "accepted" | "pending";
  },
) {
  const [existing] = await executor
    .select()
    .from(runIdentityContexts)
    .where(
      and(
        eq(runIdentityContexts.runId, input.runId),
        eq(runIdentityContexts.correlationId, input.correlationId),
      ),
    );
  if (existing) return existing;
  const [last] = await executor
    .select()
    .from(runIdentityContexts)
    .where(eq(runIdentityContexts.runId, input.runId))
    .orderBy(desc(runIdentityContexts.revision))
    .limit(1);
  const [created] = await executor
    .insert(runIdentityContexts)
    .values({
      ...input,
      revision: (last?.revision ?? 0) + 1,
      acceptedAt: input.status === "pending" ? null : new Date(),
    })
    .returning();
  if (!created) throw new Error("Failed to persist run identity");
  if (created.status === "accepted") await activate(executor, created);
  return created;
}

async function activate(executor: Executor, context: RunIdentityContext) {
  const [run] = await executor
    .update(heartbeatRuns)
    .set({
      responsibleUserId: context.responsibleUserId,
      activeIdentityContextId: context.id,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(heartbeatRuns.id, context.runId),
        eq(heartbeatRuns.companyId, context.companyId),
      ),
    )
    .returning();
  const issueId = run?.contextSnapshot?.issueId ?? run?.contextSnapshot?.taskId;
  if (typeof issueId === "string")
    await executor
      .update(issues)
      .set({ continuationIdentityContextId: context.id })
      .where(
        and(eq(issues.id, issueId), eq(issues.companyId, context.companyId)),
      );
}

/** Called only for newly dispatched runs. Historical rows are never backfilled. */
export async function initializeRunIdentity(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    responsibleUserId: string | null;
    messageIds?: string[];
    issueId?: string | null;
    interactionId?: string | null;
    parentRunId?: string | null;
    parentContextId?: string | null;
    cause: string;
  },
) {
  return db.transaction(async (tx) => {
    await lockIdentityTask(tx, input.companyId, input.runId);
    const [run] = await tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
        ),
      )
      .for(IDENTITY_ROW_LOCK);
    if (!run) throw forbidden("Run identity does not belong to this company");
    if (run.activeIdentityContextId) {
      const [current] = await tx
        .select()
        .from(runIdentityContexts)
        .where(eq(runIdentityContexts.id, run.activeIdentityContextId));
      return current!;
    }
    const operatorIdentity = await explicitOperatorRunIdentity(tx, run);
    const [parent] = input.parentRunId
      ? await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, input.parentRunId),
              eq(heartbeatRuns.companyId, input.companyId),
            ),
          )
      : [];
    const [interaction] =
      input.interactionId && input.issueId
        ? await tx
            .select()
            .from(issueThreadInteractions)
            .where(
              and(
                eq(issueThreadInteractions.id, input.interactionId),
                eq(issueThreadInteractions.companyId, input.companyId),
                eq(issueThreadInteractions.issueId, input.issueId),
              ),
            )
        : [];
    const parentId = operatorIdentity ? null : (
      interaction?.sourceIdentityContextId ?? input.parentContextId ?? parent?.activeIdentityContextId
    );
    const [origin] = parentId
      ? await tx
          .select()
          .from(runIdentityContexts)
          .where(
            and(
              eq(runIdentityContexts.id, parentId),
              eq(runIdentityContexts.companyId, input.companyId),
              eq(runIdentityContexts.status, "accepted"),
            ),
          )
      : [];
    if (parentId && !origin)
      throw forbidden("Originating execution identity is unavailable");
    let current = await append(tx, {
      companyId: input.companyId,
      runId: input.runId,
      responsibleUserId: operatorIdentity?.actorId ?? (origin ? origin.responsibleUserId : input.responsibleUserId),
      parentContextId: origin?.id ?? null,
      cause:
        operatorIdentity ? operatorIdentity.cause : origin?.cause === "company_default" ? "company_default" : input.cause,
      correlationId: "dispatch",
    });
    const ids = [...new Set(input.messageIds ?? [])];
    const comments =
      ids.length && input.issueId
        ? await tx
            .select()
            .from(issueComments)
            .where(
              and(
                eq(issueComments.companyId, input.companyId),
                eq(issueComments.issueId, input.issueId),
                inArray(issueComments.id, ids),
              ),
            )
        : [];
    for (const id of ids) {
      const comment = comments.find((c) => c.id === id);
      if (!comment?.authorUserId) continue;
      current = await append(tx, {
        companyId: input.companyId,
        runId: input.runId,
        responsibleUserId: operatorIdentity?.actorId ?? comment.authorUserId,
        messageId: id,
        parentContextId: current.id,
        cause: operatorIdentity?.cause ?? "instruction",
        correlationId: `message:${id}`,
      });
    }
    return current;
  });
}

/** Caller holds the task and run row locks, in that order. Reserve before delivery so acquisitions cannot guess. */
export async function prepareSteeredIdentity(
  executor: Executor,
  input: {
    companyId: string;
    runId: string;
    messageId: string;
    issueId: string;
    source?: "comment" | "interaction";
  },
) {
  const [run] = await executor
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
      ),
    );
  const [comment] = input.source === "interaction" ? [] : await executor
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.id, input.messageId),
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
      ),
    );
  const [interaction] = input.source === "interaction" ? await executor.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, input.messageId),
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    inArray(issueThreadInteractions.status, ["accepted", "answered", "rejected"]),
  )) : [];
  const responsibleUserId = interaction?.resolvedByUserId ?? comment?.authorUserId;
  if (!run || !responsibleUserId)
    throw forbidden("Steering requires an authenticated message author");
  if (
    run.status !== "running" ||
    (run.contextSnapshot?.issueId !== input.issueId &&
      run.contextSnapshot?.taskId !== input.issueId)
  ) {
    throw conflict("Steering targets a different or inactive execution");
  }
  return append(executor, {
    companyId: input.companyId,
    runId: input.runId,
    responsibleUserId,
    messageId: input.messageId,
    parentContextId: run.activeIdentityContextId,
    cause: "steering",
    correlationId: `${input.source === "interaction" ? "interaction" : "message"}:${input.messageId}`,
    status: "pending",
  });
}

export async function reserveSteeredIdentity(
  db: Db,
  input: Parameters<typeof prepareSteeredIdentity>[1],
) {
  return db.transaction(async (tx) => {
    await lockIdentityTask(tx, input.companyId, input.runId);
    const [run] = await tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
        ),
      )
      .for(IDENTITY_ROW_LOCK);
    // Processes started before the broker rollout keep their original environment.
    if (!run?.activeIdentityContextId) return null;
    const [pending] = await tx
      .select()
      .from(runIdentityContexts)
      .where(
        and(
          eq(runIdentityContexts.runId, run.id),
          eq(runIdentityContexts.status, "pending"),
        ),
      )
      .limit(1);
    if (pending && pending.messageId !== input.messageId) {
      if (await storedSteeringAcknowledgement(tx, pending))
        await acceptSteeredIdentity(tx, pending);
      else
        throw conflict(
          "A prior steering acknowledgement must be reconciled first",
        );
    }
    const [existing] = await tx
      .select()
      .from(runIdentityContexts)
      .where(
        and(
          eq(runIdentityContexts.runId, run.id),
          eq(runIdentityContexts.messageId, input.messageId),
          eq(runIdentityContexts.status, "accepted"),
        ),
      );
    if (existing) return existing;
    const context = await prepareSteeredIdentity(tx, input);
    if (context.status === "rejected") {
      await tx
        .update(runIdentityContexts)
        .set({ status: "pending" })
        .where(eq(runIdentityContexts.id, context.id));
      return { ...context, status: "pending" };
    }
    return context;
  });
}

export async function rejectSteeredIdentity(
  db: Db,
  context: RunIdentityContext,
) {
  await db
    .update(runIdentityContexts)
    .set({ status: "rejected" })
    .where(
      and(
        eq(runIdentityContexts.id, context.id),
        eq(runIdentityContexts.status, "pending"),
      ),
    );
}

export async function acceptSteeredIdentity(
  executor: Executor,
  context: RunIdentityContext,
) {
  // A replay must not reactivate a historical identity after later instructions.
  const [accepted] = await executor
    .update(runIdentityContexts)
    .set({ status: "accepted", acceptedAt: new Date() })
    .where(
      and(
        eq(runIdentityContexts.id, context.id),
        eq(runIdentityContexts.status, "pending"),
      ),
    )
    .returning();
  if (accepted) await activate(executor, accepted);
}

type RunIdentityInput = { companyId: string; runId: string; agentId: string };

/**
 * The current identity of a running run, read without row locks, or null when
 * the locked path must decide (a pending steering identity, a run that is not
 * this agent's running run, or a malformed task reference).
 *
 * One statement is one snapshot. Steering commits its pending identity before
 * it delivers the message, and acceptance clears the pending row and activates
 * the new identity in one transaction. A snapshot without a pending row
 * therefore shows either the identity from before the message was delivered or
 * the accepted one, exactly what the locked read would return.
 */
async function readSettledRunIdentity(db: Pick<Db, "select">, input: RunIdentityInput) {
  const [row] = await db
    .select({
      run: heartbeatRuns,
      context: runIdentityContexts,
      steeringPending: sql<boolean>`exists (
        select 1 from run_identity_contexts pending_identity
        where pending_identity.run_id = ${heartbeatRuns.id}
          and pending_identity.status = 'pending'
      )`,
    })
    .from(heartbeatRuns)
    .leftJoin(
      runIdentityContexts,
      and(
        eq(runIdentityContexts.id, heartbeatRuns.activeIdentityContextId),
        eq(runIdentityContexts.runId, heartbeatRuns.id),
      ),
    )
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ),
    );
  if (
    !row ||
    row.run.status !== "running" ||
    row.steeringPending === true ||
    identityTaskId(row.run) === "invalid"
  )
    return null;
  return { run: row.run, context: row.context ?? null };
}

const IDENTITY_CAPTURE_ATTEMPTS = 3;

/**
 * Resolve the identity a running run acts for. Agents call this for every git
 * credential, runtime tool and API request, often dozens of times a second, so
 * the common case is a lock-free snapshot. Only a pending steering identity
 * (or an error case) takes the task and run locks.
 */
export async function captureRunIdentity(db: Db, input: RunIdentityInput) {
  const settled = await readSettledRunIdentity(db, input);
  if (settled) return settled;
  // The locked transaction is idempotent and Postgres rolls a deadlock victim
  // back whole, so a bounded retry is safe. It is a backstop, not the fix.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await captureRunIdentityLocked(db, input);
    } catch (error) {
      if (attempt >= IDENTITY_CAPTURE_ATTEMPTS || !isDeadlockDetected(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.floor(Math.random() * 25)));
    }
  }
}

async function captureRunIdentityLocked(db: Db, input: RunIdentityInput) {
  // Lock acquisition serializes with steering delivery and its durable acknowledgement.
  return db.transaction(async (tx) => {
    await lockIdentityTask(tx, input.companyId, input.runId);
    const [run] = await tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
        ),
      )
      .for(IDENTITY_ROW_LOCK);
    if (!run || run.status !== "running")
      throw forbidden(
        "Credential acquisition requires this agent's active run",
      );
    const [pending] = await tx
      .select()
      .from(runIdentityContexts)
      .where(
        and(
          eq(runIdentityContexts.runId, run.id),
          eq(runIdentityContexts.status, "pending"),
        ),
      )
      .limit(1);
    if (pending) {
      const acknowledgement = await storedSteeringAcknowledgement(tx, pending);
      if (!acknowledgement)
        throw conflict(
          "Message acceptance is being reconciled; retry credential acquisition",
        );
      await acceptSteeredIdentity(tx, pending);
      run.activeIdentityContextId = pending.id;
      run.responsibleUserId = pending.responsibleUserId;
    }
    const [context] = run.activeIdentityContextId
      ? await tx
          .select()
          .from(runIdentityContexts)
          .where(
            and(
              eq(runIdentityContexts.id, run.activeIdentityContextId),
              eq(runIdentityContexts.runId, run.id),
            ),
          )
      : [];
    return { run, context: context ?? null };
  });
}

export async function listRunIdentityContexts(
  db: Db,
  companyId: string,
  runId: string,
) {
  return db
    .select()
    .from(runIdentityContexts)
    .where(
      and(
        eq(runIdentityContexts.companyId, companyId),
        eq(runIdentityContexts.runId, runId),
      ),
    )
    .orderBy(asc(runIdentityContexts.revision));
}

/** Late native acknowledgements settle reservations even when the HTTP caller timed out. */
export async function reconcileSteeredIdentity(
  db: Db,
  context: RunIdentityContext,
) {
  await db.transaction(async (tx) => {
    await lockIdentityTask(tx, context.companyId, context.runId);
    const [run] = await tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, context.runId),
          eq(heartbeatRuns.companyId, context.companyId),
        ),
      )
      .for(IDENTITY_ROW_LOCK);
    if (!run) return;
    await acceptSteeredIdentity(tx, context);
  });
}

/** Only events validated and persisted by the native control-plane transport count. */
export async function storedSteeringAcknowledgement(
  executor: Pick<Db, "select">,
  context: Pick<RunIdentityContext, "companyId" | "runId" | "messageId">,
) {
  if (!context.messageId) return null;
  const [receipt] = await executor
    .select({ payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents)
    .where(
      and(
        eq(heartbeatRunEvents.companyId, context.companyId),
        eq(heartbeatRunEvents.runId, context.runId),
        eq(heartbeatRunEvents.eventType, "item.completed"),
        sql`${heartbeatRunEvents.sourceEventId} is not null`,
        sql`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'kind' = 'steering_acknowledgement'`,
        sql`${heartbeatRunEvents.payload}->'prpEvent'->>'itemId' like ${`%:steer:${context.messageId}`}`,
      ),
    )
    .limit(1);
  const event = receipt?.payload?.prpEvent as { turnId?: string } | undefined;
  return typeof event?.turnId === "string" ? { turnId: event.turnId } : null;
}
