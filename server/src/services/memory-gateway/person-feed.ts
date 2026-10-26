import { and, desc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  authUsers,
  companyMemberships,
  issueComments,
  issueThreadInteractions,
  issues,
  memoryOperations,
  memoryScopes,
  memorySettings,
} from "@greatstone/db";
import type { SyncMemory } from "@greatstone/shared";
import { logger } from "../../middleware/logger.js";
import { memoryCardService } from "./card-writes.js";
import type { MemoryEngine } from "./engine.js";
import { memoryReviewService } from "./review.js";
import { memoryGatewayService, personScopeOwner, type MemoryCaller } from "./service.js";
import { memoryStewardService } from "./steward-actions.js";
import { memorySyncService } from "./sync.js";

/**
 * GSAM's part of one shared memory (GRE-2668). Every two hours, for each
 * company owner who has a person scope (made when their Claude Code or Codex
 * link first called), the people's comments, their card answers and the tasks
 * that were done or cancelled since the last pass go into that scope. Items
 * are batched into a few entries per pass (each new entry is one retain, one
 * model call) through the sync path, so the daily cap, the hash check and the
 * sensitive-content check apply. Agents' comments are not fed.
 */

export const MEMORY_PERSON_FEED_INTERVAL_MS = 2 * 60 * 60 * 1000;
export const MEMORY_PERSON_FEED_OPERATION = "person_feed";
const ITEMS_PER_PASS = 300;
const ITEM_MAX_CHARS = 1_500;
const ENTRY_MAX_CHARS = 6_000;
/** First pass for a new scope: how far back. */
const FIRST_PASS_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const lastFeedAt = new Map<string, number>();

type FeedItem = { key: string; at: Date; text: string; kind: "comment" | "answer" | "outcome" };

function clip(text: string, max = ITEM_MAX_CHARS) {
  const clean = text.replace(/\s+\n/g, "\n").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)} …[trimmed]`;
}

function stamp(at: Date) {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Turns feed items into sync entries of at most about ENTRY_MAX_CHARS, oldest first. */
export function personFeedEntries(items: FeedItem[]): Array<SyncMemory["entries"][number] & { firstAt: Date }> {
  const sorted = [...items].sort((a, b) => a.at.getTime() - b.at.getTime());
  const batches: FeedItem[][] = [];
  let batch: FeedItem[] = [];
  let size = 0;
  for (const item of sorted) {
    if (batch.length > 0 && size + item.text.length > ENTRY_MAX_CHARS) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(item);
    size += item.text.length + 2;
  }
  if (batch.length > 0) batches.push(batch);
  return batches.map((group) => {
    const count = (kind: FeedItem["kind"]) => group.filter((item) => item.kind === kind).length;
    const day = group[0].at.toISOString().slice(0, 10);
    return {
      source: "gsam" as const,
      sourceId: `gsam:feed:${group[0].key}`.slice(0, 200),
      title: `GSAM activity from ${day}: ${count("comment")} comments, ${count("answer")} card answers, ${count("outcome")} tasks closed`,
      content: [`What John and Ben said and decided in GSAM, and which tasks closed (from ${stamp(group[0].at)}).`, ...group.map((item) => item.text)]
        .join("\n\n")
        .slice(0, 20_000),
      occurredAt: group[0].at,
      origin: { app: "gsam" },
      firstAt: group[0].at,
    };
  });
}

async function collect(db: Db, companyId: string, since: Date) {
  const members = await db
    .select({ id: companyMemberships.principalId, name: authUsers.name })
    .from(companyMemberships)
    .leftJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active")));
  const names = new Map(members.map((member) => [member.id, member.name?.trim() || "A person"]));
  const people = [...names.keys()];
  const items: FeedItem[] = [];
  const label = (issue: { identifier: string | null; title: string; status: string }) =>
    `${issue.identifier ?? "a task"} "${clip(issue.title, 160)}" (${issue.status})`;

  if (people.length > 0) {
    const comments = await db
      .select({ id: issueComments.id, at: issueComments.createdAt, userId: issueComments.authorUserId, body: issueComments.body, identifier: issues.identifier, title: issues.title, status: issues.status })
      .from(issueComments)
      .innerJoin(issues, eq(issues.id, issueComments.issueId))
      .where(
        and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.authorUserId, people),
          isNull(issueComments.authorAgentId),
          isNull(issueComments.deletedAt),
          gt(issueComments.createdAt, since),
        ),
      )
      .orderBy(issueComments.createdAt)
      .limit(ITEMS_PER_PASS);
    for (const row of comments) {
      items.push({
        key: `comment:${row.id}`,
        at: row.at,
        kind: "comment",
        text: `[${stamp(row.at)}] ${names.get(row.userId ?? "") ?? "A person"} commented on ${label(row)}:\n${clip(row.body)}`,
      });
    }

    const answers = await db
      .select({
        id: issueThreadInteractions.id,
        at: issueThreadInteractions.resolvedAt,
        userId: issueThreadInteractions.resolvedByUserId,
        kind: issueThreadInteractions.kind,
        status: issueThreadInteractions.status,
        cardTitle: issueThreadInteractions.title,
        result: issueThreadInteractions.result,
        identifier: issues.identifier,
        title: issues.title,
        issueStatus: issues.status,
      })
      .from(issueThreadInteractions)
      .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          inArray(issueThreadInteractions.resolvedByUserId, people),
          inArray(issueThreadInteractions.status, ["accepted", "rejected", "answered"]),
          isNotNull(issueThreadInteractions.resolvedAt),
          gt(issueThreadInteractions.resolvedAt, since),
        ),
      )
      .orderBy(issueThreadInteractions.resolvedAt)
      .limit(ITEMS_PER_PASS);
    for (const row of answers) {
      if (!row.at) continue;
      items.push({
        key: `card:${row.id}`,
        at: row.at,
        kind: "answer",
        text:
          `[${stamp(row.at)}] ${names.get(row.userId ?? "") ?? "A person"} ${row.status} a ${row.kind.replace(/_/g, " ")} card` +
          `${row.cardTitle ? ` "${clip(row.cardTitle, 200)}"` : ""} on ${label({ identifier: row.identifier, title: row.title, status: row.issueStatus })}.` +
          `${row.result ? `\nAnswer: ${clip(JSON.stringify(row.result))}` : ""}`,
      });
    }
  }

  const closed = await db
    .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status, completedAt: issues.completedAt, cancelledAt: issues.cancelledAt })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        or(and(eq(issues.status, "done"), gt(issues.completedAt, since)), and(eq(issues.status, "cancelled"), gt(issues.cancelledAt, since))),
      ),
    )
    .limit(ITEMS_PER_PASS);
  for (const row of closed) {
    const at = (row.status === "done" ? row.completedAt : row.cancelledAt) ?? null;
    if (!at) continue;
    items.push({ key: `issue:${row.id}:${row.status}`, at, kind: "outcome", text: `[${stamp(at)}] ${row.identifier ?? "A task"} "${clip(row.title, 200)}" was ${row.status === "done" ? "done" : "cancelled"}.` });
  }

  // One pass takes the oldest ITEMS_PER_PASS; the rest follow on the next pass.
  return items.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, ITEMS_PER_PASS);
}

async function lastThrough(db: Db, companyId: string, scopeId: string) {
  const rows = await db
    .select({ at: memoryOperations.createdAt, detail: memoryOperations.detail, scopeIds: memoryOperations.scopeIds })
    .from(memoryOperations)
    .where(and(eq(memoryOperations.companyId, companyId), eq(memoryOperations.operation, MEMORY_PERSON_FEED_OPERATION)))
    .orderBy(desc(memoryOperations.createdAt))
    .limit(50);
  const row = rows.find((candidate) => candidate.scopeIds.includes(scopeId));
  const through = (row?.detail as { through?: unknown } | null)?.through;
  return { ranAt: row?.at ?? null, through: typeof through === "string" ? new Date(through) : null };
}

/** One pass for every company with memory on. Single-flight is the sweep's job. */
export async function runScheduledMemoryPersonFeed(db: Db, options: { engine?: MemoryEngine; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const enabled = await db.select({ companyId: memorySettings.companyId }).from(memorySettings).where(eq(memorySettings.enabled, true));
  let fed = 0;
  for (const { companyId } of enabled) {
    const scopes = (await db.select().from(memoryScopes).where(and(eq(memoryScopes.companyId, companyId), eq(memoryScopes.kind, "person")))).filter(
      (scope) => personScopeOwner(scope) !== null,
    );
    for (const scope of scopes) {
      const userId = personScopeOwner(scope)!;
      const owner = await db
        .select({ role: companyMemberships.membershipRole })
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")))
        .then((rows) => rows[0] ?? null);
      if (owner?.role !== "owner") continue;
      if (!lastFeedAt.has(scope.id)) {
        const last = await lastThrough(db, companyId, scope.id);
        lastFeedAt.set(scope.id, last.ranAt?.getTime() ?? 0);
      }
      if (now.getTime() - (lastFeedAt.get(scope.id) ?? 0) < MEMORY_PERSON_FEED_INTERVAL_MS) continue;
      lastFeedAt.set(scope.id, now.getTime());
      try {
        const gateway = memoryGatewayService(db, options.engine ? { engine: options.engine } : {});
        const reviews = memoryReviewService(db, gateway);
        const cards = memoryCardService(db, gateway, reviews, memoryStewardService(db, gateway, reviews));
        const syncs = memorySyncService(db, gateway, cards);
        const caller: MemoryCaller = {
          companyId,
          actorType: "user",
          actorId: userId,
          agentId: null,
          userId,
          runId: null,
          isBoardAdmin: false,
          app: "gsam_scheduler",
          sessionId: MEMORY_PERSON_FEED_OPERATION,
        };
        const since = (await lastThrough(db, companyId, scope.id)).through ?? new Date(now.getTime() - FIRST_PASS_LOOKBACK_MS);
        const items = await collect(db, companyId, since);
        const entries = personFeedEntries(items);
        let through = items.at(-1)?.at ?? since;
        for (let at = 0; at < entries.length; at += 25) {
          const chunk = entries.slice(at, at + 25);
          const result = await syncs.sync(caller, { entries: chunk.map(({ firstAt: _firstAt, ...entry }) => entry) });
          const firstCapped = result.entries.findIndex((entry) => entry.outcome === "capped");
          if (firstCapped >= 0) {
            // The capped entry and the rest wait for the next pass after the cap resets.
            through = new Date(chunk[firstCapped].firstAt.getTime() - 1);
            break;
          }
        }
        await gateway.internals.logOperation(caller, MEMORY_PERSON_FEED_OPERATION, "ok", {
          scopeIds: [scope.id],
          detail: { through: through.toISOString(), items: items.length, entries: entries.length },
        });
        fed += 1;
      } catch (error) {
        lastFeedAt.set(scope.id, now.getTime() - MEMORY_PERSON_FEED_INTERVAL_MS + 15 * 60 * 1000);
        logger.warn({ err: error, companyId, scopeId: scope.id }, "shared memory GSAM feed failed; it runs again within 15 minutes");
      }
    }
  }
  return { fed };
}
