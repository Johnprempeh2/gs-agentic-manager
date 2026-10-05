import { and, asc, eq, gt, isNull, lte, ne } from "drizzle-orm";
import { agents, issues, memoryOperations, memoryStewardGrants, type Db } from "@greatstone/db";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";

export const STEWARD_GRANT_RENEWAL_ORIGIN_KIND = "memory_steward_grant_renewal";
/** The renew reminder goes out this long before a live grant ends (G3, GRE-933). */
export const STEWARD_GRANT_RENEW_NOTICE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The agent that leads the company: role `ceo`, else the agent at the top of
 * the org chart (Everest has role `general` and reports to nobody).
 */
async function findChiefAgent(db: Db, companyId: string) {
  const active = and(eq(agents.companyId, companyId), ne(agents.status, "terminated"));
  const [ceo] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(active, eq(agents.role, "ceo")))
    .orderBy(asc(agents.createdAt))
    .limit(1);
  if (ceo) return ceo;
  const [top] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(active, isNull(agents.reportsTo)))
    .orderBy(asc(agents.createdAt))
    .limit(1);
  return top ?? null;
}

/**
 * One reminder task per live steward grant that ends within three days and
 * has not been renewed, assigned to the company's lead agent (Everest). John
 * renews; the reminder only says so. Safe to run often: a grant gets at most
 * one reminder.
 */
export async function remindStewardGrantRenewals(db: Db, now = new Date()) {
  const ending = await db
    .select()
    .from(memoryStewardGrants)
    .where(
      and(
        eq(memoryStewardGrants.environment, "live"),
        isNull(memoryStewardGrants.revokedAt),
        gt(memoryStewardGrants.expiresAt, now),
        lte(memoryStewardGrants.expiresAt, new Date(now.getTime() + STEWARD_GRANT_RENEW_NOTICE_MS)),
      ),
    );
  let created = 0;
  for (const grant of ending) {
    const [renewed] = await db
      .select({ id: memoryStewardGrants.id })
      .from(memoryStewardGrants)
      .where(
        and(
          eq(memoryStewardGrants.companyId, grant.companyId),
          eq(memoryStewardGrants.agentId, grant.agentId),
          eq(memoryStewardGrants.environment, "live"),
          isNull(memoryStewardGrants.revokedAt),
          gt(memoryStewardGrants.expiresAt, grant.expiresAt),
        ),
      )
      .limit(1);
    if (renewed) continue;
    const [existing] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, grant.companyId),
          eq(issues.originKind, STEWARD_GRANT_RENEWAL_ORIGIN_KIND),
          eq(issues.originId, grant.id),
        ),
      )
      .limit(1);
    if (existing) continue;
    const ceo = await findChiefAgent(db, grant.companyId);
    const [steward] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, grant.agentId))
      .limit(1);
    const ends = grant.expiresAt.toISOString().slice(0, 10);
    const issue = await issueService(db).create(grant.companyId, {
      title: `Renew ${steward?.name ?? "the steward"}'s memory steward grant (ends ${ends})`,
      description: [
        `The live memory steward grant for ${steward?.name ?? grant.agentId} ends on ${grant.expiresAt.toISOString()}.`,
        "",
        "Only John can renew it. Ask John on his release or decision task to run the renew step:",
        "`POST /api/companies/{companyId}/memory/steward/grants/live` with the same agent and scopes, `expiresInDays` at most 30.",
        "",
        `Grant id: ${grant.id}. If John does not renew, the steward review stops when the grant ends; nothing else changes.`,
      ].join("\n"),
      status: "todo",
      priority: "high",
      assigneeAgentId: ceo?.id ?? null,
      originKind: STEWARD_GRANT_RENEWAL_ORIGIN_KIND,
      originId: grant.id,
    });
    await db.insert(memoryOperations).values({
      companyId: grant.companyId,
      operation: "steward_grant_renew_reminder",
      outcome: "ok",
      actorType: "system",
      actorId: "memory-steward-grant-renewal",
      agentId: grant.agentId,
      scopeIds: grant.scopeIds,
      detail: { grantId: grant.id, issueId: issue.id, assigneeAgentId: ceo?.id ?? null, expiresAt: grant.expiresAt.toISOString() },
    });
    if (!ceo) logger.warn({ companyId: grant.companyId, grantId: grant.id }, "steward grant renew reminder has no CEO agent to go to");
    created += 1;
  }
  return { created };
}
