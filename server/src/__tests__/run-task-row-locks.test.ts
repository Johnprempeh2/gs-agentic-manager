import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  type Db,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { documentService } from "../services/documents.js";
import { issueService } from "../services/issues.js";

/**
 * Hot run and task rows are the parents of almost every row an agent writes.
 * Each such insert takes FOR KEY SHARE on the parent in its foreign key check,
 * and FOR UPDATE is the only row lock that conflicts with it. These tests pin
 * the writers that used to lock a run or task FOR UPDATE: each runs against a
 * writer that has already referenced the run and only then touches the task,
 * the shape of a document write, and must not deadlock with it.
 */

/** SQLSTATE of a driver error (Drizzle keeps it on `cause`), or the HTTP status. */
function outcome(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return "ok";
  let current: unknown = result.reason;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const { code, status, cause } = current as { code?: unknown; status?: unknown; cause?: unknown };
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    if (typeof status === "number") return `http ${status}`;
    current = cause;
  }
  return String(result.reason);
}

function settledLabel(label: string) {
  return [
    () => `${label} ok`,
    (error: unknown) => `${label} ${outcome({ status: "rejected", reason: error })}`,
  ] as const;
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("run and task row locks", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-run-task-row-locks-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  }, 60_000);

  async function seed(input: { issueStatus?: string; runStatus?: "queued" | "running" } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}` });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Builder", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Lock order", status: input.issueStatus ?? "in_progress", priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: input.runStatus ?? "running",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    return { companyId, agentId, runId, issueId };
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  /**
   * The shape of `documentService.upsertIssueDocument`: the revision row
   * references the run (FOR KEY SHARE on the run row) and only a later
   * statement touches the task, by referencing it (FOR KEY SHARE) or by
   * updating it (FOR NO KEY UPDATE), as comment writes do.
   */
  async function holdRunThenTask(input: Seeded, then: "reference_task" | "update_task" = "reference_task") {
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const done = db.transaction(async (tx) => {
      const [document] = await tx.insert(documents).values({
        companyId: input.companyId, format: "markdown", latestBody: "Note", latestRevisionNumber: 1,
        createdByAgentId: input.agentId,
      }).returning();
      await tx.insert(documentRevisions).values({
        companyId: input.companyId, documentId: document!.id, revisionNumber: 1, format: "markdown",
        body: "Note", createdByAgentId: input.agentId, createdByRunId: input.runId,
      });
      held();
      await gate;
      if (then === "update_task") {
        await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, input.issueId));
      } else {
        await tx.insert(issueDocuments).values({
          companyId: input.companyId, issueId: input.issueId, documentId: document!.id,
          key: `note-${randomUUID().slice(0, 8)}`,
        });
      }
    });
    await holding;
    return { done, release };
  }

  /** Resolve once the operation settles or any backend is queued on a row lock. */
  async function untilSettledOrWaiting(operation: Promise<unknown>) {
    let settled = false;
    operation.then(() => { settled = true; }, () => { settled = true; });
    for (let attempt = 0; attempt < 150 && !settled; attempt += 1) {
      const waiting = await db.execute(sql`select 1 from pg_locks where not granted limit 1`);
      if (waiting.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function raceWithWriter(
    input: Seeded,
    operation: () => Promise<unknown>,
    then: "reference_task" | "update_task" = "reference_task",
  ) {
    const writer = await holdRunThenTask(input, then);
    const running = operation();
    await untilSettledOrWaiting(running);
    writer.release();
    return Promise.allSettled([writer.done, running]);
  }

  it("cancels a stale queued run (task then run lock) without deadlocking the writer", async () => {
    const input = await seed({ issueStatus: "done", runStatus: "queued" });
    const outcomes = await raceWithWriter(input, () => createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      companyId: input.companyId, runId: input.runId, expectedStatus: "queued", now: new Date(),
    }));
    expect(outcomes.map(outcome)).toEqual(["ok", "ok"]);
    expect((outcomes[1] as PromiseFulfilledResult<unknown>).value).toMatchObject({ outcome: "cancelled" });
  }, 15_000);

  it("posts an agent comment with attachments (task then run lock) without deadlocking the writer", async () => {
    const input = await seed();
    const issuesSvc = issueService(db);
    const attachment = await issuesSvc.createAttachment({
      issueId: input.issueId, issueCommentId: null, provider: "local_disk",
      objectKey: `issues/${randomUUID()}/shot.png`, contentType: "image/png", byteSize: 128,
      sha256: "a".repeat(64), originalFilename: "shot.png",
      createdByAgentId: input.agentId, createdByRunId: input.runId,
    });
    const outcomes = await raceWithWriter(input, () => issuesSvc.addComment(
      input.issueId, "Result attached", { agentId: input.agentId, runId: input.runId },
      { attachmentIds: [attachment.id] },
    ));
    expect(outcomes.map(outcome)).toEqual(["ok", "ok"]);
  }, 15_000);

  it("adds an agent attachment to its comment (task, run, comment locks) without deadlocking the writer", async () => {
    const input = await seed();
    const [comment] = await db.insert(issueComments).values({
      companyId: input.companyId, issueId: input.issueId, authorAgentId: input.agentId, authorType: "agent",
      createdByRunId: input.runId, body: "See the attached file",
    }).returning();
    const outcomes = await raceWithWriter(input, () => issueService(db).createAttachment({
      issueId: input.issueId, issueCommentId: comment!.id, provider: "local_disk",
      objectKey: `issues/${randomUUID()}/log.txt`, contentType: "text/plain", byteSize: 64,
      sha256: "b".repeat(64), originalFilename: "log.txt",
      createdByAgentId: input.agentId, createdByRunId: input.runId,
    }));
    expect(outcomes.map(outcome)).toEqual(["ok", "ok"]);
  }, 15_000);

  it("appends a run event after its transaction changed the task without deadlocking the writer", async () => {
    // The shape of the active-run watchdog and run-status writers: the task is
    // already updated when the event append locks the run.
    const input = await seed();
    const outcomes = await raceWithWriter(input, () => db.transaction(async (tx) => {
      await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, input.issueId));
      return appendHeartbeatRunEvent(tx as unknown as Db, {
        companyId: input.companyId, runId: input.runId, agentId: input.agentId,
        eventType: "lifecycle", stream: "system", level: "info", message: "Watchdog note",
      });
    }), "update_task");
    expect(outcomes.map(outcome)).toEqual(["ok", "ok"]);
  }, 15_000);

  it("serves a burst of run events, agent comments and document writes for one run and task", async () => {
    const input = await seed();
    const issuesSvc = issueService(db);
    const docs = documentService(db);
    const rounds = 10;
    const work: Promise<string>[] = [];
    for (let index = 0; index < rounds; index += 1) {
      work.push(appendHeartbeatRunEvent(db, {
        companyId: input.companyId, runId: input.runId, agentId: input.agentId,
        eventType: "log", stream: "stdout", level: "info", message: `step ${index}`,
      }).then(...settledLabel("event")));
      work.push(issuesSvc.addComment(input.issueId, `Progress ${index}`, { agentId: input.agentId, runId: input.runId })
        .then(...settledLabel("comment")));
      work.push(docs.upsertIssueDocument({
        issueId: input.issueId, key: `note-${index}`, format: "markdown", body: "Progress note",
        createdByAgentId: input.agentId, createdByRunId: input.runId,
      }).then(...settledLabel("document")));
    }
    const results = await Promise.all(work);

    expect(results.filter((result) => !result.endsWith(" ok"))).toEqual([]);
    const events = await db.select({ seq: heartbeatRunEvents.seq }).from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, input.runId)).orderBy(asc(heartbeatRunEvents.seq));
    const seqs = events.map((event) => Number(event.seq));
    expect(seqs).toEqual(Array.from({ length: rounds }, (_, offset) => seqs[0]! + offset));
  }, 60_000);
});
