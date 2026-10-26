import { and, asc, desc, eq, gt, inArray, ne, notInArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, authUsers, companyMemberships, memoryIngestOutbox, memoryRecords, memoryScopes, memorySettings } from "@greatstone/db";
import {
  applyHandoffUpdate,
  diffHandoff,
  emptyHandoff,
  HANDOFF_SINCE_MY_LAST_UPDATE,
  HANDOFF_SOURCE_ID,
  HANDOFF_SOURCE_KIND,
  handoffAuthorForApp,
  MEMORY_MY_WORK_SCOPE_REF,
  mergeHandoffFile,
  NOW_MD_AUTHOR,
  parseHandoffMarkdown,
  renderHandoffMarkdown,
  renderHandoffText,
  type HandoffAuthor,
  type HandoffChange,
  type HandoffConflict,
  type HandoffReadResult,
  type HandoffState,
  type HandoffVersionEvidence,
  type HandoffWriteResult,
  type MorningSummaryHandoff,
  type ReadHandoff,
  type ReconcileHandoffFile,
  type UpdateHandoff,
} from "@greatstone/shared";
import { forbidden, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { enqueueMemoryIngest } from "./ingest-outbox-db.js";
import { insertReviewEvent } from "./review-store.js";
import { detectSensitiveContent, MEMORY_SENSITIVE_CONTENT_CODE, MemorySensitiveContentError } from "./sensitive-content.js";
import {
  isExternalApp,
  memoryEngineDocument,
  personScopeOwner,
  type MemoryCaller,
  type MemoryGatewayService,
  type RecordRow,
  type ScopeRow,
} from "./service.js";

/**
 * The live handoff (GRE-2668, John 26 Oct): one versioned record in a
 * person's own scope (bank `greatstone-<first name>`). Claude Code and Codex
 * (the person's app links) and GSAM agents read and write it through
 * `handoff_read` and `handoff_update`; the Mac sync mirrors it to `NOW.md`.
 *
 * Each update is a new version row (the old one superseded), written with its
 * outbox entry in one transaction, so a write never waits on the memory engine
 * and keeps working while Hindsight is down. The retain is held for a few
 * minutes and replaced by the next version's, so a burst of updates costs one
 * engine call, not one each.
 *
 * Who may write: the person and their app links (any unit), and GSAM agents in
 * a live run (threads and the waiting list only: the focus and notes are the
 * person's). Every version passes the sensitive-content check.
 */

export const HANDOFF_RETAIN_DELAY_MS = 10 * 60 * 1000;
const HANDOFF_SINCE_DEFAULT_MS = 24 * 60 * 60 * 1000;
const HANDOFF_SINCE_MAX_VERSIONS = 200;

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function evidenceOf(row: RecordRow | null): HandoffVersionEvidence | null {
  const evidence = row?.evidence as Partial<HandoffVersionEvidence> | null | undefined;
  return evidence?.handoff ? (evidence as HandoffVersionEvidence) : null;
}

function stateOf(row: RecordRow | null): HandoffState {
  return evidenceOf(row)?.handoff ?? emptyHandoff();
}

function sameAuthor(a: HandoffAuthor | null | undefined, b: HandoffAuthor) {
  if (!a) return false;
  if (b.agentId || a.agentId) return a.agentId === b.agentId;
  return a.tool === b.tool && a.label === b.label;
}

async function latestIn(database: DbOrTransaction, companyId: string, scopeId: string) {
  return database
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.companyId, companyId),
        eq(memoryRecords.scopeId, scopeId),
        eq(memoryRecords.sourceKind, HANDOFF_SOURCE_KIND),
        eq(memoryRecords.sourceId, HANDOFF_SOURCE_ID),
        notInArray(memoryRecords.status, ["superseded", "deleted"]),
      ),
    )
    .orderBy(desc(memoryRecords.version), desc(memoryRecords.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function personFirstName(db: Db, userId: string | null) {
  if (!userId) return "the owner";
  const user = await db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, userId)).then((rows) => rows[0] ?? null);
  return user?.name?.trim().split(/\s+/)[0] || "the owner";
}

/**
 * The company owners' person scopes, the one with the newest handoff first.
 * GSAM agents and the wake payload use it when no person is named.
 */
async function ownerPersonScopes(db: Db, companyId: string) {
  const scopes = (await db.select().from(memoryScopes).where(and(eq(memoryScopes.companyId, companyId), eq(memoryScopes.kind, "person")))).filter(
    (scope) => personScopeOwner(scope) !== null,
  );
  if (scopes.length === 0) return [];
  const owners = new Set(
    (
      await db
        .select({ id: companyMemberships.principalId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.membershipRole, "owner"),
            eq(companyMemberships.status, "active"),
          ),
        )
    ).map((row) => row.id),
  );
  const ranked: Array<{ scope: ScopeRow; latest: RecordRow | null }> = [];
  for (const scope of scopes) {
    if (!owners.has(personScopeOwner(scope)!)) continue;
    ranked.push({ scope, latest: await latestIn(db, companyId, scope.id) });
  }
  return ranked.sort((a, b) => (b.latest?.createdAt.getTime() ?? 0) - (a.latest?.createdAt.getTime() ?? 0));
}

/** John's focus for the wake payload (GRE-2668): the newest owner handoff's focus line, or null. Never throws. */
export async function readOwnerFocus(db: Db, companyId: string) {
  try {
    const enabled = await db
      .select({ enabled: memorySettings.enabled })
      .from(memorySettings)
      .where(eq(memorySettings.companyId, companyId))
      .then((rows) => rows[0]?.enabled === true);
    if (!enabled) return null;
    const [first] = await ownerPersonScopes(db, companyId);
    const focus = stateOf(first?.latest ?? null).focus;
    if (!first || !focus) return null;
    return {
      personName: await personFirstName(db, personScopeOwner(first.scope)),
      text: focus.text.slice(0, 400),
      by: focus.by.label,
      at: focus.at,
    };
  } catch (error) {
    logger.warn({ err: error, companyId }, "handoff focus lookup failed; the wake goes on without it");
    return null;
  }
}

/**
 * The person's own handoff for their digest (morning summary, GRE-2668):
 * focus, threads, waiting list, last tool, and how many parts changed since
 * `since`. Null when they have none or memory is off. Never throws.
 */
export async function personHandoffSummary(db: Db, companyId: string, userId: string, since: Date): Promise<MorningSummaryHandoff | null> {
  try {
    const enabled = await db
      .select({ enabled: memorySettings.enabled })
      .from(memorySettings)
      .where(eq(memorySettings.companyId, companyId))
      .then((rows) => rows[0]?.enabled === true);
    if (!enabled) return null;
    const scope = await db
      .select()
      .from(memoryScopes)
      .where(and(eq(memoryScopes.companyId, companyId), eq(memoryScopes.kind, "person"), eq(memoryScopes.tag, `scope:person:${userId}`)))
      .then((rows) => rows[0] ?? null);
    const latest = scope ? await latestIn(db, companyId, scope.id) : null;
    if (!scope || !latest) return null;
    const state = stateOf(latest);
    const versions = await db
      .select({ evidence: memoryRecords.evidence })
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.scopeId, scope.id),
          eq(memoryRecords.sourceKind, HANDOFF_SOURCE_KIND),
          eq(memoryRecords.sourceId, HANDOFF_SOURCE_ID),
          gt(memoryRecords.createdAt, since),
        ),
      )
      .limit(HANDOFF_SINCE_MAX_VERSIONS);
    const changed = new Set(versions.flatMap((row) => ((row.evidence as Partial<HandoffVersionEvidence> | null)?.changes ?? []).map((change) => change.unit)));
    return {
      focus: state.focus ? { text: state.focus.text, by: state.focus.by.label, at: state.focus.at } : null,
      threadCount: state.threads.length,
      threads: state.threads.slice(0, 5).map((thread) => ({ key: thread.key, refs: thread.refs, title: thread.title, state: thread.state, next: thread.next, by: thread.by.label })),
      waiting: state.waiting?.text ?? null,
      lastTool: state.lastTool ? { by: state.lastTool.by.label, at: state.lastTool.at, doing: state.lastTool.doing } : null,
      changesSince: changed.size,
    };
  } catch (error) {
    logger.warn({ err: error, companyId }, "handoff lookup for the digest failed; it goes out without it");
    return null;
  }
}

export function memoryHandoffService(db: Db, gateway: MemoryGatewayService, options: { now?: () => Date } = {}) {
  const { logOperation, accessFor } = gateway.internals;
  const now = options.now ?? (() => new Date());

  /** Who is writing, as "by <label>": Claude, ChatGPT, "GSAM agent Everest" or "John in GSAM". */
  async function authorFor(caller: MemoryCaller): Promise<HandoffAuthor> {
    if (caller.actorType === "user") return { tool: "gsam", label: `${await personFirstName(db, caller.userId)} in GSAM` };
    const agent = caller.agentId
      ? await db
          .select({ name: agents.name, metadata: agents.metadata })
          .from(agents)
          .where(and(eq(agents.id, caller.agentId), eq(agents.companyId, caller.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    if (isExternalApp(caller)) {
      const app = (agent?.metadata as { memoryConnection?: { app?: string } } | null)?.memoryConnection?.app;
      return handoffAuthorForApp(app, agent?.name ?? "");
    }
    return { tool: "gsam_agent", label: `GSAM agent ${agent?.name ?? "unknown"}`.slice(0, 60), agentId: caller.agentId };
  }

  /**
   * The person scope a call is about. The person and their apps: their own
   * (made on first use). A GSAM agent: the bank it names, else the company
   * owner's. Anyone else: not found.
   */
  async function target(caller: MemoryCaller, person: string | undefined) {
    await gateway.assertEnabled(caller.companyId);
    let scopeId: string | null = null;
    const ownWork = caller.actorType === "user" || isExternalApp(caller);
    if (caller.actorType === "user" && caller.userId && (!person || person === MEMORY_MY_WORK_SCOPE_REF)) {
      scopeId = (await gateway.ensurePersonScope(caller.companyId, caller.userId)).id;
    } else if (person) {
      scopeId = await gateway.resolvePersonScopeRef(caller, person);
    } else if (ownWork) {
      scopeId = await gateway.resolvePersonScopeRef(caller, MEMORY_MY_WORK_SCOPE_REF);
    } else {
      const [first] = await ownerPersonScopes(db, caller.companyId);
      if (first) scopeId = await gateway.resolvePersonScopeRef(caller, first.scope.bankId);
    }
    const scope = scopeId ? await gateway.internals.loadScope(caller.companyId, scopeId) : null;
    if (!scope || scope.kind !== "person") throw notFound("No handoff found: it is made when the person or one of their apps first uses shared memory");
    const access = await accessFor(caller);
    const owner = personScopeOwner(scope);
    return { scope, access, personName: await personFirstName(db, owner), ownWork: ownWork && access.person === owner };
  }

  async function changesSince(caller: MemoryCaller, scope: ScopeRow, since: string | undefined): Promise<HandoffReadResult["changesSince"]> {
    if (!since) return null;
    let from: Date | null = null;
    if (since === HANDOFF_SINCE_MY_LAST_UPDATE) {
      const me = await authorFor(caller);
      const rows = await db
        .select({ createdAt: memoryRecords.createdAt, evidence: memoryRecords.evidence })
        .from(memoryRecords)
        .where(and(eq(memoryRecords.scopeId, scope.id), eq(memoryRecords.sourceKind, HANDOFF_SOURCE_KIND), eq(memoryRecords.sourceId, HANDOFF_SOURCE_ID)))
        .orderBy(desc(memoryRecords.createdAt))
        .limit(HANDOFF_SINCE_MAX_VERSIONS);
      from = rows.find((row) => sameAuthor((row.evidence as Partial<HandoffVersionEvidence> | null)?.by, me))?.createdAt ?? null;
    } else {
      from = new Date(since);
    }
    const start = from ?? new Date(now().getTime() - HANDOFF_SINCE_DEFAULT_MS);
    const versions = await db
      .select({ evidence: memoryRecords.evidence })
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.scopeId, scope.id),
          eq(memoryRecords.sourceKind, HANDOFF_SOURCE_KIND),
          eq(memoryRecords.sourceId, HANDOFF_SOURCE_ID),
          ne(memoryRecords.status, "deleted"),
          gt(memoryRecords.createdAt, start),
        ),
      )
      .orderBy(asc(memoryRecords.createdAt))
      .limit(HANDOFF_SINCE_MAX_VERSIONS);
    const changes: HandoffChange[] = [];
    const conflicts: HandoffConflict[] = [];
    for (const version of versions) {
      const evidence = version.evidence as Partial<HandoffVersionEvidence> | null;
      changes.push(...(evidence?.changes ?? []));
      conflicts.push(...(evidence?.conflicts ?? []));
    }
    return { since: start.toISOString(), versions: versions.length, changes, conflicts };
  }

  function result(scope: ScopeRow, personName: string, row: RecordRow | null): HandoffReadResult {
    const state = stateOf(row);
    const revision = row?.version && evidenceOf(row) ? row.version : 0;
    return {
      bankName: scope.bankId,
      personName,
      revision,
      recordId: row?.id ?? null,
      updatedAt: row?.createdAt.toISOString() ?? null,
      handoff: state,
      markdown: renderHandoffMarkdown(state, { personName, bankName: scope.bankId, revision, writtenAt: (row?.createdAt ?? now()).toISOString() }),
      changesSince: null,
    };
  }

  async function read(caller: MemoryCaller, input: ReadHandoff): Promise<HandoffReadResult> {
    const { scope, access, personName } = await target(caller, input.person);
    if (!access.canRead(scope)) throw notFound("No handoff found: it is made when the person or one of their apps first uses shared memory");
    const row = await latestIn(db, caller.companyId, scope.id);
    await logOperation(caller, "handoff_read", "ok", { scopeIds: [scope.id], recordId: row?.id ?? null });
    return { ...result(scope, personName, row), changesSince: await changesSince(caller, scope, input.since) };
  }

  /**
   * Writes one new version. `compute` runs inside the transaction on the
   * version current at that moment (the scope row is locked), so two tools
   * writing at once each see the other's lines and neither is lost.
   */
  async function writeVersion(
    caller: MemoryCaller,
    scope: ScopeRow,
    personName: string,
    operation: string,
    /** Null: nothing to write. */
    compute: (current: HandoffState) => {
      next: HandoffState;
      by: HandoffAuthor;
      doing: string;
      conflicts: HandoffConflict[];
    } | null,
  ): Promise<HandoffWriteResult> {
    const settings = await gateway.getSettings(caller.companyId);
    const at = now();
    let refused: string[] | null = null;
    const written = await db.transaction(async (tx) => {
      await tx.select({ id: memoryScopes.id }).from(memoryScopes).where(eq(memoryScopes.id, scope.id)).for("update");
      const current = await latestIn(tx, caller.companyId, scope.id);
      const state = stateOf(current);
      const computed = compute(state);
      if (!computed) return { row: current, changed: false, changes: [] as HandoffChange[], conflicts: [] as HandoffConflict[] };
      const { next, by, doing, conflicts } = computed;
      const changes = diffHandoff(state, next);
      const lastToolMoved = !sameAuthor(state.lastTool?.by, by) || state.lastTool?.doing !== next.lastTool?.doing;
      if (changes.length === 0 && conflicts.length === 0 && !lastToolMoved) {
        return { row: current, changed: false, changes, conflicts };
      }
      const revision = (evidenceOf(current) ? current!.version : 0) + 1;
      const content = renderHandoffText(next, personName);
      const title = `${personName}'s handoff, revision ${revision}: ${by.label}, ${doing}`.slice(0, 200);
      const matched = detectSensitiveContent([title, content].join("\n"));
      if (matched.length > 0) {
        refused = matched;
        return null;
      }
      const evidence: HandoffVersionEvidence = { handoff: next, revision, by, doing, changes, conflicts };
      const [inserted] = await tx
        .insert(memoryRecords)
        .values({
          companyId: caller.companyId,
          scopeId: scope.id,
          kind: "source_statement",
          status: "unreviewed",
          entryType: "observation",
          decisionClass: "operational",
          sensitivity: "internal",
          title,
          content,
          entities: [],
          topics: ["handoff"],
          contributorAgentId: caller.agentId,
          contributorUserId: caller.userId,
          runId: caller.runId,
          sourceKind: HANDOFF_SOURCE_KIND,
          sourceId: HANDOFF_SOURCE_ID,
          evidence: evidence as unknown as Record<string, unknown>,
          effectiveFrom: at,
          supersedesId: current?.id ?? null,
          version: revision,
          retainMode: settings.retainMode,
          syncState: "pending",
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (current) {
        await tx
          .update(memoryRecords)
          .set({ status: "superseded", supersededById: inserted!.id, supersededAt: at, updatedAt: at })
          .where(eq(memoryRecords.id, current.id));
        await insertReviewEvent(tx, caller, current, { action: "edit", fromStatus: current.status, toStatus: "superseded", reason: `Handoff update: ${doing}`, relatedRecordId: inserted!.id, now: at });
      }
      await insertReviewEvent(tx, caller, inserted!, { action: "contribute", toStatus: "unreviewed", reason: `Handoff update: ${doing}`, relatedRecordId: current?.id ?? null, now: at });

      // One engine call per quiet spell: an older version not yet sent never will be.
      const older = tx
        .select({ id: memoryRecords.id })
        .from(memoryRecords)
        .where(and(eq(memoryRecords.scopeId, scope.id), eq(memoryRecords.sourceKind, HANDOFF_SOURCE_KIND), ne(memoryRecords.id, inserted!.id)));
      const cancelled = await tx
        .update(memoryIngestOutbox)
        .set({ state: "cancelled", updatedAt: at })
        .where(and(inArray(memoryIngestOutbox.recordId, older), eq(memoryIngestOutbox.op, "retain"), eq(memoryIngestOutbox.state, "pending")))
        .returning({ recordId: memoryIngestOutbox.recordId });
      if (cancelled.length > 0) {
        await tx
          .update(memoryRecords)
          .set({ syncError: "Not sent to the engine: a newer handoff version replaced it first", updatedAt: at })
          .where(inArray(memoryRecords.id, cancelled.map((row) => row.recordId)));
      }
      await enqueueMemoryIngest(tx, {
        companyId: caller.companyId,
        recordId: inserted!.id,
        op: "retain",
        payload: memoryEngineDocument(inserted!, scope, settings.retainMode) as unknown as Record<string, unknown>,
        now: at,
        notBefore: new Date(at.getTime() + HANDOFF_RETAIN_DELAY_MS),
      });
      return { row: inserted!, changed: true, changes, conflicts };
    });
    if (!written) {
      await logOperation(caller, operation, "denied", { scopeIds: [scope.id], detail: { reason: MEMORY_SENSITIVE_CONTENT_CODE, matchedTypes: refused } });
      throw new MemorySensitiveContentError(refused ?? []);
    }
    await logOperation(caller, operation, "ok", {
      scopeIds: [scope.id],
      recordId: written.row?.id ?? null,
      detail: { changed: written.changed, revision: written.row?.version ?? 0, changes: written.changes.length, conflicts: written.conflicts.length },
    });
    return { ...result(scope, personName, written.row), changed: written.changed, changes: written.changes, conflicts: written.conflicts };
  }

  async function update(caller: MemoryCaller, input: UpdateHandoff): Promise<HandoffWriteResult> {
    const { scope, access, personName, ownWork } = await target(caller, input.person);
    const operation = "handoff_update";
    if (ownWork) {
      if (!access.canContribute(scope)) {
        await logOperation(caller, operation, "denied", { scopeIds: [scope.id], detail: { reason: "no_contribute_right" } });
        throw forbidden("This app may read shared memory but not write to it. Allow it to contribute in Memory > Claude and ChatGPT.");
      }
    } else {
      // A GSAM agent in a live run: its own threads and the waiting list, never the person's focus or notes.
      const agentRun = caller.actorType === "agent" && !isExternalApp(caller) && caller.runId !== null && access.canRead(scope);
      if (!agentRun) {
        await logOperation(caller, operation, "denied", { scopeIds: [scope.id], detail: { reason: "not_the_person" } });
        throw notFound("No handoff found: it is made when the person or one of their apps first uses shared memory");
      }
      if (input.focus !== undefined || input.notes !== undefined) {
        await logOperation(caller, operation, "denied", { scopeIds: [scope.id], detail: { reason: "agent_focus_or_notes" } });
        throw forbidden(`Only ${personName} and their own apps set the focus and the notes; agents update threads and the waiting list.`);
      }
    }
    const by = await authorFor(caller);
    const { person: _person, ...change } = input;
    return writeVersion(caller, scope, personName, operation, (current) => ({
      next: applyHandoffUpdate(current, change, by, now()),
      by,
      doing: change.doing,
      conflicts: [],
    }));
  }

  /**
   * The Mac sync sends `NOW.md` back with the revision it last wrote. Edits
   * made in the file while GSAM could not be reached are merged unit by unit;
   * the newer side wins a clash and the clash is recorded on the version.
   */
  async function reconcileFile(caller: MemoryCaller, input: ReconcileHandoffFile): Promise<HandoffWriteResult> {
    const { scope, access, personName, ownWork } = await target(caller, undefined);
    const operation = "handoff_file";
    if (!ownWork || !access.canContribute(scope)) {
      await logOperation(caller, operation, "denied", { scopeIds: [scope.id], detail: { reason: "not_the_person" } });
      throw forbidden("Only the person's own app links send NOW.md back.");
    }
    const parsed = parseHandoffMarkdown(input.text);
    const empty = !input.text.trim();
    const baseRow = input.baseRevision > 0
      ? await db
          .select()
          .from(memoryRecords)
          .where(
            and(
              eq(memoryRecords.scopeId, scope.id),
              eq(memoryRecords.sourceKind, HANDOFF_SOURCE_KIND),
              eq(memoryRecords.sourceId, HANDOFF_SOURCE_ID),
              eq(memoryRecords.version, input.baseRevision),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const base = stateOf(baseRow);
    const by: HandoffAuthor = { ...NOW_MD_AUTHOR, label: "NOW.md (Mac sync)" };
    return writeVersion(caller, scope, personName, operation, (current) => {
      // An empty file is a mistake or a new Mac, never "delete everything".
      if (empty) return null;
      const merged = mergeHandoffFile({ base, server: current, file: parsed, fileChangedAt: input.fileChangedAt, now: now() });
      if (merged.fromFile.length === 0 && merged.conflicts.length === 0) return null;
      return { next: merged.merged, by: merged.merged.lastTool?.by ?? by, doing: "NOW.md edits sent back by the Mac sync", conflicts: merged.conflicts };
    });
  }

  return { read, update, reconcileFile, authorFor };
}

export type MemoryHandoffService = ReturnType<typeof memoryHandoffService>;
