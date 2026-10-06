import { and, asc, count, desc, eq, gte, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  issues,
  memoryConflicts,
  memoryExtractedFacts,
  memoryLinkLeads,
  memoryRecords,
  memoryRelationships,
  memoryReviewEvents,
  memoryScopes,
} from "@greatstone/db";
import {
  MEMORY_ACTIVITY_NOTE,
  MEMORY_CONFLICT_NOTE,
  MEMORY_GRAPH_NOTE,
  MEMORY_LINK_LEAD_NOTE,
  type MemoryLinkBasis,
  MEMORY_RECORD_STATUSES,
  type MemoryActivityCounts,
  type MemoryActivityCountsQuery,
  type MemoryActivityFeed,
  type MemoryActivityQuery,
  type MemoryActorRef,
  type MemoryContributorActivity,
  type MemoryExtractedFact,
  type MemoryGraph,
  type MemoryGraphEdge,
  type MemoryGraphEdgeDetail,
  type MemoryGraphEdgeType,
  type MemoryGraphNode,
  type MemoryGraphNodeDetail,
  type MemoryGraphQuery,
  type MemoryProvenance,
  type MemoryRecordStatus,
  type MemoryReviewEvent,
  type MemoryReviewEventAction,
  type MemoryScopeKind,
  type MemorySourceRef,
  type MemoryEntryType,
  type MemoryDecisionClass,
} from "@greatstone/shared";
import { notFound } from "../../errors.js";
import { LINK_CHECK_NAME, LINK_LEAD_SOURCE_KIND } from "./link-check.js";
import { toRecord, toScope, type MemoryCaller, type MemoryGatewayService, type RecordRow, type ScopeRow } from "./service.js";

// Memory graph and contribution activity read API (GRE-864, plan section 8).
//
// Read only. Every query starts from the scopes the caller may read, so a
// hidden record never adds a node, an edge, a label, a count or a feed row.
// Edges come only from stored rows: a stated relationship, a supersession
// link, an open conflict found by the contribution check, or an open lead
// found by the link check. An edge is returned only when both of its ends are
// readable records in the result.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A task key such as `GRE-646`. */
const ISSUE_KEY_RE = /^[a-z][a-z0-9]*-\d+$/i;
const EXCERPT_LENGTH = 280;

/** Steps a person or agent takes on someone's record (plan 8.3: reviewer/editor role). */
const REVIEWER_ACTIONS: readonly MemoryReviewEventAction[] = [
  "approve",
  "dispute",
  "supersede",
  "superseded_by",
  "conflict_resolved",
  "delete",
];
/** Steps a check takes; the actor on the row is whoever triggered it, not a reviewer. */
const CHECK_ACTIONS: readonly MemoryReviewEventAction[] = ["conflict_flagged"];

const EDGE_MEANINGS: Record<MemoryGraphEdgeType, string> = {
  supports: "The author stated that the first entry supports the second.",
  contradicts: "The author stated that the first entry contradicts the second.",
  refines: "The author stated that the first entry refines or narrows the second.",
  depends_on: "The author stated that the first entry depends on the second.",
  same_subject: "The author stated that both entries are about the same subject.",
  supersedes: "A reviewer replaced the second entry with the first. The second is kept as history.",
  possible_conflict: `The first entry may conflict with the approved second entry. ${MEMORY_CONFLICT_NOTE}`,
};

const CONFLICT_CHECK_NAME = "Conflict check";
const LINK_LEAD_MEANING = `Both entries may be about the same subject. ${MEMORY_LINK_LEAD_NOTE} The owner or a memory reviewer can confirm it as a stated link or dismiss it.`;

function basisTerms(basis: MemoryLinkBasis | null) {
  if (!basis) return [];
  return [...basis.entities, ...basis.topics, ...basis.values, ...(basis.sameSource ? ["same source"] : [])];
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function actorRef(agentId: string | null, userId: string | null): MemoryActorRef {
  if (agentId) return { actorType: "agent", agentId, userId: null, name: null };
  if (userId) return { actorType: "user", agentId: null, userId, name: null };
  return { actorType: "system", agentId: null, userId: null, name: null };
}

function systemRef(name: string): MemoryActorRef {
  return { actorType: "system", agentId: null, userId: null, name };
}

function toEvent(row: typeof memoryReviewEvents.$inferSelect): MemoryReviewEvent {
  return {
    id: row.id,
    recordId: row.recordId,
    scopeId: row.scopeId,
    action: row.action as MemoryReviewEventAction,
    fromStatus: row.fromStatus as MemoryRecordStatus | null,
    toStatus: row.toStatus as MemoryRecordStatus | null,
    actorType: row.actorType,
    actorId: row.actorId,
    agentId: row.agentId,
    userId: row.userId,
    runId: row.runId,
    reason: row.reason,
    relatedRecordId: row.relatedRecordId,
    createdAt: row.createdAt,
  };
}

function toFact(row: typeof memoryExtractedFacts.$inferSelect): MemoryExtractedFact {
  return {
    id: row.id,
    recordId: row.recordId,
    engineUnitId: row.engineUnitId,
    factType: row.factType,
    contributorAgentId: row.contributorAgentId,
    contributorUserId: row.contributorUserId,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function eventActor(row: { agentId: string | null; userId: string | null; actorType: string }) {
  if (row.actorType === "system") return systemRef("System");
  return actorRef(row.agentId, row.userId);
}

export function memoryGraphService(db: Db, gateway: MemoryGatewayService) {
  const { accessFor, logOperation } = gateway.internals;

  /** Scopes the caller may read, narrowed by the scope and project filters. */
  async function readableScopes(caller: MemoryCaller, filters: { scopeId?: string; projectId?: string } = {}) {
    await gateway.assertEnabled(caller.companyId);
    const access = await accessFor(caller);
    const all = (await db.select().from(memoryScopes).where(eq(memoryScopes.companyId, caller.companyId))).filter((scope) =>
      access.canRead(scope),
    );
    const selected = all.filter(
      (scope) =>
        (!filters.scopeId || scope.id === filters.scopeId) && (!filters.projectId || scope.projectId === filters.projectId),
    );
    return { all, selected, byId: new Map(all.map((scope) => [scope.id, scope])) };
  }

  /** Fills `name` on every agent ref, from this company's agents only. */
  async function nameAgents(companyId: string, refs: MemoryActorRef[]) {
    const ids = [...new Set(refs.map((ref) => ref.agentId).filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return;
    const names = new Map(
      (
        await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, ids)))
      ).map((row) => [row.id, row.name]),
    );
    for (const ref of refs) ref.name = ref.agentId ? (names.get(ref.agentId) ?? null) : ref.name;
  }

  function recordFilters(
    caller: MemoryCaller,
    scopeIds: string[],
    query: { agentId?: string; userId?: string; q?: string; status?: string[] },
  ): SQL[] {
    const conditions: SQL[] = [eq(memoryRecords.companyId, caller.companyId), inArray(memoryRecords.scopeId, scopeIds)];
    if (query.agentId) conditions.push(eq(memoryRecords.contributorAgentId, query.agentId));
    if (query.userId) conditions.push(eq(memoryRecords.contributorUserId, query.userId));
    if (query.status && query.status.length > 0) conditions.push(inArray(memoryRecords.status, query.status));
    if (query.q) {
      // Title, content and source id, so a search for the source issue finds the memory (plan 8.3.3).
      const pattern = `%${escapeLike(query.q)}%`;
      conditions.push(
        or(
          sql`coalesce(${memoryRecords.title}, '') ilike ${pattern}`,
          sql`coalesce(${memoryRecords.content}, '') ilike ${pattern}`,
          sql`coalesce(${memoryRecords.sourceId}, '') ilike ${pattern}`,
          // A task key finds the same records as the task id (GRE-929). Only
          // this company's tasks; the scope check above still applies.
          ...(ISSUE_KEY_RE.test(query.q)
            ? [
                sql`${memoryRecords.sourceId} in (select ${issues.id}::text from ${issues} where ${issues.companyId} = ${caller.companyId} and ${issues.identifier} = ${query.q.toUpperCase()})`,
              ]
            : []),
        )!,
      );
    }
    return conditions;
  }

  async function openConflictCounts(companyId: string, recordIds: string[]) {
    const counts = new Map<string, number>();
    if (recordIds.length === 0) return counts;
    const rows = await db
      .select({ recordId: memoryConflicts.recordId, approvedRecordId: memoryConflicts.approvedRecordId })
      .from(memoryConflicts)
      .where(
        and(
          eq(memoryConflicts.companyId, companyId),
          eq(memoryConflicts.state, "open"),
          or(inArray(memoryConflicts.recordId, recordIds), inArray(memoryConflicts.approvedRecordId, recordIds)),
        ),
      );
    for (const row of rows) {
      counts.set(row.recordId, (counts.get(row.recordId) ?? 0) + 1);
      counts.set(row.approvedRecordId, (counts.get(row.approvedRecordId) ?? 0) + 1);
    }
    return counts;
  }

  function toNode(row: RecordRow, scope: ScopeRow, conflicts: Map<string, number>): MemoryGraphNode {
    return {
      id: row.id,
      scopeId: scope.id,
      scopeKind: scope.kind as MemoryScopeKind,
      scopeName: scope.name,
      title: row.title,
      excerpt: (row.content ?? "").slice(0, EXCERPT_LENGTH),
      status: row.status as MemoryRecordStatus,
      entryType: row.entryType as MemoryEntryType,
      decisionClass: row.decisionClass as MemoryDecisionClass,
      contributor: actorRef(row.contributorAgentId, row.contributorUserId),
      source: { kind: row.sourceKind, id: row.sourceId, runId: row.runId },
      openConflictCount: conflicts.get(row.id) ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function toNodes(companyId: string, rows: RecordRow[], scopes: Map<string, ScopeRow>) {
    const conflicts = await openConflictCounts(companyId, rows.map((row) => row.id));
    return rows.map((row) => toNode(row, scopes.get(row.scopeId)!, conflicts));
  }

  /**
   * Every stored edge whose two ends are both in `nodes`. The caller has
   * already checked that each node is a readable, non-deleted record.
   */
  async function edgesBetween(companyId: string, nodes: Map<string, RecordRow>): Promise<MemoryGraphEdge[]> {
    const ids = [...nodes.keys()];
    if (ids.length === 0) return [];
    const edges: MemoryGraphEdge[] = [];

    const relationships = await db
      .select()
      .from(memoryRelationships)
      .where(
        and(
          eq(memoryRelationships.companyId, companyId),
          inArray(memoryRelationships.fromRecordId, ids),
          inArray(memoryRelationships.toRecordId, ids),
        ),
      )
      .orderBy(asc(memoryRelationships.createdAt));
    // A stated link confirmed from a link check lead keeps what the check matched.
    const confirmedLeadIds = relationships
      .filter((row) => row.sourceKind === LINK_LEAD_SOURCE_KIND && row.sourceId && UUID_RE.test(row.sourceId))
      .map((row) => row.sourceId!);
    const confirmedBasis = new Map(
      (confirmedLeadIds.length === 0
        ? []
        : await db
            .select({ id: memoryLinkLeads.id, basis: memoryLinkLeads.basis })
            .from(memoryLinkLeads)
            .where(and(eq(memoryLinkLeads.companyId, companyId), inArray(memoryLinkLeads.id, confirmedLeadIds)))
      ).map((row) => [row.id, row.basis]),
    );
    for (const row of relationships) {
      edges.push({
        id: `rel:${row.id}`,
        from: row.fromRecordId,
        to: row.toRecordId,
        type: row.type as MemoryGraphEdgeType,
        kind: "explicit",
        origin: "relationship",
        author: actorRef(row.authorAgentId, row.authorUserId),
        source: { kind: row.sourceKind, id: row.sourceId, runId: row.runId },
        basis: (row.sourceKind === LINK_LEAD_SOURCE_KIND && row.sourceId ? confirmedBasis.get(row.sourceId) : null) ?? null,
        createdAt: row.createdAt,
      });
    }

    // Supersession: the replacement points at the record it replaced. The
    // reviewer who did it is on the `supersede` review event.
    const replacements = [...nodes.values()].filter((row) => row.supersedesId && nodes.has(row.supersedesId));
    if (replacements.length > 0) {
      const events = await db
        .select()
        .from(memoryReviewEvents)
        .where(
          and(
            eq(memoryReviewEvents.companyId, companyId),
            eq(memoryReviewEvents.action, "supersede"),
            inArray(memoryReviewEvents.recordId, replacements.map((row) => row.id)),
          ),
        )
        .orderBy(desc(memoryReviewEvents.createdAt));
      for (const row of replacements) {
        const event = events.find((candidate) => candidate.recordId === row.id && candidate.relatedRecordId === row.supersedesId);
        edges.push({
          id: `sup:${row.id}`,
          from: row.id,
          to: row.supersedesId!,
          type: "supersedes",
          kind: "explicit",
          origin: "supersession",
          author: event ? eventActor(event) : systemRef("Unknown reviewer"),
          source: { kind: null, id: null, runId: event?.runId ?? null },
          basis: null,
          createdAt: event?.createdAt ?? row.supersededAt ?? row.updatedAt,
        });
      }
    }

    // Inferred: open conflicts found by the contribution check. A conflict
    // opened by a stated `contradicts` is already the explicit edge above.
    const conflicts = await db
      .select()
      .from(memoryConflicts)
      .where(
        and(
          eq(memoryConflicts.companyId, companyId),
          eq(memoryConflicts.state, "open"),
          eq(memoryConflicts.origin, "contribution_check"),
          inArray(memoryConflicts.recordId, ids),
          inArray(memoryConflicts.approvedRecordId, ids),
        ),
      )
      .orderBy(asc(memoryConflicts.detectedAt));
    for (const row of conflicts) {
      edges.push({
        id: `cfl:${row.id}`,
        from: row.recordId,
        to: row.approvedRecordId,
        type: "possible_conflict",
        kind: "inferred",
        origin: "conflict_check",
        author: systemRef(CONFLICT_CHECK_NAME),
        source: { kind: "memory_conflict", id: row.id, runId: null },
        basis: null,
        createdAt: row.detectedAt,
      });
    }

    // Inferred: open leads from the link check. Confirmed ones are the stated edge above.
    const leads = await db
      .select()
      .from(memoryLinkLeads)
      .where(
        and(
          eq(memoryLinkLeads.companyId, companyId),
          eq(memoryLinkLeads.state, "open"),
          inArray(memoryLinkLeads.fromRecordId, ids),
          inArray(memoryLinkLeads.toRecordId, ids),
        ),
      )
      .orderBy(asc(memoryLinkLeads.detectedAt));
    for (const row of leads) {
      edges.push({
        id: `lnk:${row.id}`,
        from: row.fromRecordId,
        to: row.toRecordId,
        type: "same_subject",
        kind: "inferred",
        origin: "link_check",
        author: systemRef(LINK_CHECK_NAME),
        source: { kind: LINK_LEAD_SOURCE_KIND, id: row.id, runId: null },
        basis: row.basis,
        createdAt: row.detectedAt,
      });
    }
    return edges;
  }

  async function graph(caller: MemoryCaller, query: MemoryGraphQuery): Promise<MemoryGraph> {
    const scopes = await readableScopes(caller, query);
    const scopeIds = scopes.selected.map((scope) => scope.id);
    const rows =
      scopeIds.length === 0
        ? []
        : await db
            .select()
            .from(memoryRecords)
            .where(
              and(
                ...recordFilters(caller, scopeIds, query),
                ne(memoryRecords.status, "deleted"),
              ),
            )
            .orderBy(desc(memoryRecords.updatedAt), desc(memoryRecords.id))
            .limit(query.limit + 1);
    const truncated = rows.length > query.limit;
    const kept = rows.slice(0, query.limit);
    const nodes = await toNodes(caller.companyId, kept, scopes.byId);
    const edges = await edgesBetween(caller.companyId, new Map(kept.map((row) => [row.id, row])));
    await nameAgents(caller.companyId, [...nodes.map((node) => node.contributor), ...edges.map((edge) => edge.author)]);
    await logOperation(caller, "graph", "ok", {
      scopeIds,
      detail: { nodes: nodes.length, edges: edges.length, truncated },
    });
    return { note: MEMORY_GRAPH_NOTE, nodes, edges, scopes: scopes.all.map(toScope), truncated };
  }

  /** A record the caller may read, or 404 with an audit row. Same answer for "missing" and "not yours". */
  async function loadReadableRecord(caller: MemoryCaller, recordId: string, operation: string) {
    const scopes = await readableScopes(caller);
    const row = UUID_RE.test(recordId)
      ? await db
          .select()
          .from(memoryRecords)
          .where(and(eq(memoryRecords.id, recordId), eq(memoryRecords.companyId, caller.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const scope = row ? scopes.byId.get(row.scopeId) : undefined;
    if (!row || !scope) {
      await logOperation(caller, operation, "denied", { recordId: row ? row.id : null, detail: { requestedId: recordId.slice(0, 100) } });
      throw notFound("Memory record not found");
    }
    return { row, scope, scopes };
  }

  /** Readable, non-deleted records among these ids. */
  async function readableRows(caller: MemoryCaller, ids: string[], scopes: Map<string, ScopeRow>) {
    const unique = [...new Set(ids)];
    if (unique.length === 0 || scopes.size === 0) return [];
    return db
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.companyId, caller.companyId),
          inArray(memoryRecords.id, unique),
          inArray(memoryRecords.scopeId, [...scopes.keys()]),
          ne(memoryRecords.status, "deleted"),
        ),
      );
  }

  async function nodeDetail(caller: MemoryCaller, recordId: string): Promise<MemoryGraphNodeDetail> {
    const operation = "graph_node";
    const { row, scope, scopes } = await loadReadableRecord(caller, recordId, operation);

    // Candidate neighbours from every edge store; only readable ones are kept.
    const neighbourIds = new Set<string>();
    if (row.status !== "deleted") {
      const relationships = await db
        .select({ fromRecordId: memoryRelationships.fromRecordId, toRecordId: memoryRelationships.toRecordId })
        .from(memoryRelationships)
        .where(
          and(
            eq(memoryRelationships.companyId, caller.companyId),
            or(eq(memoryRelationships.fromRecordId, row.id), eq(memoryRelationships.toRecordId, row.id)),
          ),
        );
      relationships.forEach((rel) => neighbourIds.add(rel.fromRecordId === row.id ? rel.toRecordId : rel.fromRecordId));
      const conflicts = await db
        .select({ recordId: memoryConflicts.recordId, approvedRecordId: memoryConflicts.approvedRecordId })
        .from(memoryConflicts)
        .where(
          and(
            eq(memoryConflicts.companyId, caller.companyId),
            eq(memoryConflicts.state, "open"),
            eq(memoryConflicts.origin, "contribution_check"),
            or(eq(memoryConflicts.recordId, row.id), eq(memoryConflicts.approvedRecordId, row.id)),
          ),
        );
      conflicts.forEach((c) => neighbourIds.add(c.recordId === row.id ? c.approvedRecordId : c.recordId));
      const leads = await db
        .select({ fromRecordId: memoryLinkLeads.fromRecordId, toRecordId: memoryLinkLeads.toRecordId })
        .from(memoryLinkLeads)
        .where(
          and(
            eq(memoryLinkLeads.companyId, caller.companyId),
            eq(memoryLinkLeads.state, "open"),
            or(eq(memoryLinkLeads.fromRecordId, row.id), eq(memoryLinkLeads.toRecordId, row.id)),
          ),
        );
      leads.forEach((lead) => neighbourIds.add(lead.fromRecordId === row.id ? lead.toRecordId : lead.fromRecordId));
      const replacedBy = await db
        .select({ id: memoryRecords.id })
        .from(memoryRecords)
        .where(and(eq(memoryRecords.companyId, caller.companyId), eq(memoryRecords.supersedesId, row.id)));
      replacedBy.forEach((r) => neighbourIds.add(r.id));
      if (row.supersedesId) neighbourIds.add(row.supersedesId);
    }
    neighbourIds.delete(row.id);
    const neighbourRows = await readableRows(caller, [...neighbourIds], scopes.byId);
    const edgeNodes = new Map<string, RecordRow>(neighbourRows.map((r) => [r.id, r]));
    if (row.status !== "deleted") edgeNodes.set(row.id, row);
    const edges = (await edgesBetween(caller.companyId, edgeNodes)).filter((edge) => edge.from === row.id || edge.to === row.id);
    const linked = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
    const neighbours = neighbourRows.filter((r) => linked.has(r.id));

    // Supersession chain, both ways, stopping at the first record the caller cannot read.
    const chainRows: RecordRow[] = [row];
    const seen = new Set([row.id]);
    const loadChainRow = async (id: string) => {
      const found = await db
        .select()
        .from(memoryRecords)
        .where(and(eq(memoryRecords.id, id), eq(memoryRecords.companyId, caller.companyId)))
        .then((rows) => rows[0] ?? null);
      return found && scopes.byId.has(found.scopeId) ? found : null;
    };
    for (let cursor = row.supersedesId; cursor && !seen.has(cursor) && chainRows.length < 100; ) {
      const previous = await loadChainRow(cursor);
      if (!previous) break;
      chainRows.unshift(previous);
      seen.add(previous.id);
      cursor = previous.supersedesId;
    }
    for (let cursor = row.supersededById; cursor && !seen.has(cursor) && chainRows.length < 200; ) {
      const next = await loadChainRow(cursor);
      if (!next) break;
      chainRows.push(next);
      seen.add(next.id);
      cursor = next.supersededById;
    }

    const events = await db
      .select()
      .from(memoryReviewEvents)
      .where(and(eq(memoryReviewEvents.companyId, caller.companyId), eq(memoryReviewEvents.recordId, row.id)))
      .orderBy(asc(memoryReviewEvents.createdAt));
    const facts = await db
      .select()
      .from(memoryExtractedFacts)
      .where(and(eq(memoryExtractedFacts.companyId, caller.companyId), eq(memoryExtractedFacts.recordId, row.id)))
      .orderBy(desc(memoryExtractedFacts.lastSeenAt))
      .limit(500);
    const contributeEvent = events.find((event) => event.action === "contribute");
    const provenance: MemoryProvenance = {
      contributor: {
        ...actorRef(row.contributorAgentId, row.contributorUserId),
        runId: row.runId,
        at: contributeEvent?.createdAt ?? row.createdAt,
      },
      reviewers: events
        .filter((event) => (REVIEWER_ACTIONS as readonly string[]).includes(event.action))
        .map((event) => ({
          action: event.action as MemoryReviewEventAction,
          actor: eventActor(event),
          runId: event.runId,
          fromStatus: event.fromStatus as MemoryRecordStatus | null,
          toStatus: event.toStatus as MemoryRecordStatus | null,
          reason: event.reason,
          relatedRecordId: event.relatedRecordId,
          at: event.createdAt,
        })),
      checks: events
        .filter((event) => (CHECK_ACTIONS as readonly string[]).includes(event.action))
        .map((event) => ({
          action: event.action as MemoryReviewEventAction,
          relatedRecordId: event.relatedRecordId,
          reason: event.reason,
          at: event.createdAt,
        })),
      extraction: { facts: facts.map(toFact) },
    };

    const allRows = [row, ...neighbourRows, ...chainRows];
    const conflicts = await openConflictCounts(caller.companyId, [...new Set(allRows.map((r) => r.id))]);
    const node = toNode(row, scope, conflicts);
    const result: MemoryGraphNodeDetail = {
      node,
      record: toRecord(row, scope),
      provenance,
      chain: chainRows.map((r) => toNode(r, scopes.byId.get(r.scopeId)!, conflicts)),
      edges,
      neighbours: neighbours.map((r) => toNode(r, scopes.byId.get(r.scopeId)!, conflicts)),
    };
    await nameAgents(caller.companyId, [
      node.contributor,
      provenance.contributor,
      ...provenance.reviewers.map((step) => step.actor),
      ...result.chain.map((n) => n.contributor),
      ...result.neighbours.map((n) => n.contributor),
      ...edges.map((edge) => edge.author),
    ]);
    await logOperation(caller, operation, "ok", { scopeIds: [scope.id], recordId: row.id, detail: { edges: edges.length } });
    return result;
  }

  async function edgeDetail(caller: MemoryCaller, edgeId: string): Promise<MemoryGraphEdgeDetail> {
    const operation = "graph_edge";
    const scopes = await readableScopes(caller);
    const [prefix, id] = edgeId.split(":", 2);
    const denied = async (): Promise<never> => {
      await logOperation(caller, operation, "denied", { detail: { requestedId: edgeId.slice(0, 100) } });
      throw notFound("Memory connection not found");
    };
    if (!id || !UUID_RE.test(id)) return denied();

    let ends: [string, string] | null = null;
    let statedNote: string | null = null;
    let sharedTerms: string[] = [];
    let conflictState: MemoryGraphEdgeDetail["conflictState"] = null;
    let leadId: string | null = null;
    if (prefix === "lnk") {
      const lead = await db
        .select()
        .from(memoryLinkLeads)
        .where(and(eq(memoryLinkLeads.id, id), eq(memoryLinkLeads.companyId, caller.companyId), eq(memoryLinkLeads.state, "open")))
        .then((rows) => rows[0] ?? null);
      if (lead) {
        ends = [lead.fromRecordId, lead.toRecordId];
        sharedTerms = basisTerms(lead.basis);
        leadId = lead.id;
      }
    } else if (prefix === "rel") {
      const rel = await db
        .select()
        .from(memoryRelationships)
        .where(and(eq(memoryRelationships.id, id), eq(memoryRelationships.companyId, caller.companyId)))
        .then((rows) => rows[0] ?? null);
      if (rel) {
        ends = [rel.fromRecordId, rel.toRecordId];
        statedNote = rel.note;
      }
    } else if (prefix === "sup") {
      const replacement = await db
        .select({ id: memoryRecords.id, supersedesId: memoryRecords.supersedesId })
        .from(memoryRecords)
        .where(and(eq(memoryRecords.id, id), eq(memoryRecords.companyId, caller.companyId)))
        .then((rows) => rows[0] ?? null);
      if (replacement?.supersedesId) ends = [replacement.id, replacement.supersedesId];
    } else if (prefix === "cfl") {
      const row = await db
        .select()
        .from(memoryConflicts)
        .where(
          and(
            eq(memoryConflicts.id, id),
            eq(memoryConflicts.companyId, caller.companyId),
            eq(memoryConflicts.origin, "contribution_check"),
            eq(memoryConflicts.state, "open"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (row) {
        ends = [row.recordId, row.approvedRecordId];
        sharedTerms = row.sharedTerms;
        conflictState = row.state as MemoryGraphEdgeDetail["conflictState"];
      }
    }
    if (!ends) return denied();
    const rows = await readableRows(caller, ends, scopes.byId);
    if (rows.length !== 2) return denied();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const edge = (await edgesBetween(caller.companyId, byId)).find((candidate) => candidate.id === edgeId);
    if (!edge) return denied();
    const conflicts = await openConflictCounts(caller.companyId, ends);
    const from = toNode(byId.get(edge.from)!, scopes.byId.get(byId.get(edge.from)!.scopeId)!, conflicts);
    const to = toNode(byId.get(edge.to)!, scopes.byId.get(byId.get(edge.to)!.scopeId)!, conflicts);
    await nameAgents(caller.companyId, [edge.author, from.contributor, to.contributor]);
    await logOperation(caller, operation, "ok", { scopeIds: [from.scopeId], recordId: from.id, detail: { edgeId } });
    return {
      note: MEMORY_GRAPH_NOTE,
      edge,
      meaning: edge.origin === "link_check" ? LINK_LEAD_MEANING : EDGE_MEANINGS[edge.type],
      from,
      to,
      statedNote,
      sharedTerms: sharedTerms.length > 0 ? sharedTerms : basisTerms(edge.basis),
      conflictState,
      leadId,
    };
  }

  function windowFilters(query: { from?: Date; to?: Date }, column: typeof memoryRecords.createdAt | typeof memoryRelationships.createdAt | typeof memoryReviewEvents.createdAt) {
    const conditions: SQL[] = [];
    if (query.from) conditions.push(gte(column, query.from));
    if (query.to) conditions.push(lt(column, query.to));
    return conditions;
  }

  /** Contributions newest first. `to` is exclusive. Deleted records appear as tombstones. */
  async function activity(caller: MemoryCaller, query: MemoryActivityQuery): Promise<MemoryActivityFeed> {
    const scopes = await readableScopes(caller, query);
    const scopeIds = scopes.selected.map((scope) => scope.id);
    const empty = async () => {
      await logOperation(caller, "activity", "ok", { scopeIds, detail: { returned: 0 } });
      return { items: [], nextCursor: null };
    };
    if (scopeIds.length === 0) return empty();
    const conditions = [...recordFilters(caller, scopeIds, query), ...windowFilters(query, memoryRecords.createdAt)];
    if (query.cursor) {
      // Keyset paging on (created_at, id); a cursor outside the caller's view ends the feed.
      const anchor = UUID_RE.test(query.cursor)
        ? await db
            .select({ id: memoryRecords.id, scopeId: memoryRecords.scopeId })
            .from(memoryRecords)
            .where(and(eq(memoryRecords.id, query.cursor), eq(memoryRecords.companyId, caller.companyId)))
            .then((rows) => rows[0] ?? null)
        : null;
      if (!anchor || !scopes.byId.has(anchor.scopeId)) return empty();
      conditions.push(
        sql`(${memoryRecords.createdAt}, ${memoryRecords.id}) < (select r.created_at, r.id from memory_records r where r.id = ${anchor.id})`,
      );
    }
    const rows = await db
      .select()
      .from(memoryRecords)
      .where(and(...conditions))
      .orderBy(desc(memoryRecords.createdAt), desc(memoryRecords.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const ids = page.map((row) => row.id);
    const events =
      ids.length === 0
        ? []
        : await db
            .select()
            .from(memoryReviewEvents)
            .where(and(eq(memoryReviewEvents.companyId, caller.companyId), inArray(memoryReviewEvents.recordId, ids)))
            .orderBy(asc(memoryReviewEvents.createdAt));
    const factCounts = new Map(
      (ids.length === 0
        ? []
        : await db
            .select({ recordId: memoryExtractedFacts.recordId, n: count() })
            .from(memoryExtractedFacts)
            .where(and(eq(memoryExtractedFacts.companyId, caller.companyId), inArray(memoryExtractedFacts.recordId, ids)))
            .groupBy(memoryExtractedFacts.recordId)
      ).map((row) => [row.recordId, Number(row.n)]),
    );
    const items = page.map((row) => {
      const scope = scopes.byId.get(row.scopeId)!;
      return {
        record: toRecord(row, scope),
        scopeName: scope.name,
        contributor: actorRef(row.contributorAgentId, row.contributorUserId),
        source: { kind: row.sourceKind, id: row.sourceId, runId: row.runId } satisfies MemorySourceRef,
        history: events.filter((event) => event.recordId === row.id).map(toEvent),
        extractedFactCount: factCounts.get(row.id) ?? 0,
      };
    });
    await nameAgents(caller.companyId, items.map((item) => item.contributor));
    await logOperation(caller, "activity", "ok", { scopeIds, detail: { returned: items.length } });
    return { items, nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null };
  }

  /**
   * Activity per contributor. `contributionCount` uses exactly the feed's
   * filters, so the drill-down returns the same records. Sorted by name.
   */
  async function activityCounts(caller: MemoryCaller, query: MemoryActivityCountsQuery): Promise<MemoryActivityCounts> {
    const scopes = await readableScopes(caller, query);
    const scopeIds = scopes.selected.map((scope) => scope.id);
    const rows = new Map<string, MemoryContributorActivity>();
    const rowFor = (agentId: string | null, userId: string | null) => {
      const key = agentId ? `agent:${agentId}` : userId ? `user:${userId}` : "system";
      let entry = rows.get(key);
      if (!entry) {
        entry = {
          contributor: actorRef(agentId, userId),
          contributionCount: 0,
          contributionCountByStatus: Object.fromEntries(MEMORY_RECORD_STATUSES.map((status) => [status, 0])) as Record<MemoryRecordStatus, number>,
          relationshipsStatedCount: 0,
          reviewActionCount: 0,
        };
        rows.set(key, entry);
      }
      return entry;
    };

    if (scopeIds.length > 0) {
      const contributions = await db
        .select({
          agentId: memoryRecords.contributorAgentId,
          userId: memoryRecords.contributorUserId,
          status: memoryRecords.status,
          n: count(),
        })
        .from(memoryRecords)
        .where(and(...recordFilters(caller, scopeIds, query), ...windowFilters(query, memoryRecords.createdAt)))
        .groupBy(memoryRecords.contributorAgentId, memoryRecords.contributorUserId, memoryRecords.status);
      for (const row of contributions) {
        const entry = rowFor(row.agentId, row.userId);
        entry.contributionCount += Number(row.n);
        const status = row.status as MemoryRecordStatus;
        if (status in entry.contributionCountByStatus) entry.contributionCountByStatus[status] += Number(row.n);
      }

      // `scope_id` is the from end; a link may cross scopes, so the to end is checked too.
      const readableIds = scopes.all.map((scope) => scope.id);
      const stated = await db
        .select({ agentId: memoryRelationships.authorAgentId, userId: memoryRelationships.authorUserId, n: count() })
        .from(memoryRelationships)
        .where(
          and(
            eq(memoryRelationships.companyId, caller.companyId),
            inArray(memoryRelationships.scopeId, scopeIds),
            inArray(
              memoryRelationships.toRecordId,
              db
                .select({ id: memoryRecords.id })
                .from(memoryRecords)
                .where(and(eq(memoryRecords.companyId, caller.companyId), inArray(memoryRecords.scopeId, readableIds))),
            ),
            ...windowFilters(query, memoryRelationships.createdAt),
          ),
        )
        .groupBy(memoryRelationships.authorAgentId, memoryRelationships.authorUserId);
      for (const row of stated) rowFor(row.agentId, row.userId).relationshipsStatedCount += Number(row.n);

      const reviewed = await db
        .select({ agentId: memoryReviewEvents.agentId, userId: memoryReviewEvents.userId, n: count() })
        .from(memoryReviewEvents)
        .where(
          and(
            eq(memoryReviewEvents.companyId, caller.companyId),
            inArray(memoryReviewEvents.scopeId, scopeIds),
            inArray(memoryReviewEvents.action, [...REVIEWER_ACTIONS].filter((action) => action !== "superseded_by")),
            ...windowFilters(query, memoryReviewEvents.createdAt),
          ),
        )
        .groupBy(memoryReviewEvents.agentId, memoryReviewEvents.userId);
      for (const row of reviewed) rowFor(row.agentId, row.userId).reviewActionCount += Number(row.n);
    }

    const contributors = [...rows.values()];
    await nameAgents(caller.companyId, contributors.map((row) => row.contributor));
    const label = (ref: MemoryActorRef) => (ref.name ?? ref.userId ?? ref.agentId ?? "").toLowerCase();
    contributors.sort((a, b) => label(a.contributor).localeCompare(label(b.contributor)));
    await logOperation(caller, "activity_counts", "ok", { scopeIds, detail: { contributors: contributors.length } });
    return { note: MEMORY_ACTIVITY_NOTE, contributors };
  }

  return { graph, nodeDetail, edgeDetail, activity, activityCounts };
}

export type MemoryGraphService = ReturnType<typeof memoryGraphService>;
