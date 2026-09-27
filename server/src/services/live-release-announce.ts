// Announces a live start on a new commit (GRE-50). Called once per new commit
// by live-release.ts recordLiveStart; every step is safe to repeat.
//
//   1. One "instance.live_released" activity entry per active company.
//   2. Each issue waiting for a release (a monitor with serviceName
//      LIVE_RELEASE_MONITOR_SERVICE_NAME) whose ref is now live is woken once,
//      through its monitor, with the live commit in the wake payload.
//   3. Each pending agent-made "is it released?" card whose answer is now known
//      is withdrawn, and the issue's agent is woken once to continue. A card
//      asks about a release when its idempotencyKey ends in `release:<ref>`
//      (for example `confirmation:<issueId>:release:<sha>` or
//      `live-release:<rc-tag>`). Cards with no ref, or a ref live does not
//      contain yet, stay open.
import { and, eq, isNotNull, like, sql } from "drizzle-orm";
import { activityLog, companies, issueThreadInteractions, issues, type Db } from "@greatstone/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { heartbeatService } from "./heartbeat.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import type { LiveReleaseEvent } from "./live-release.js";

export const LIVE_RELEASE_ACTIVITY_ACTION = "instance.live_released";
export const LIVE_RELEASE_WAKE_REASON = "live_release";
const ACTOR_ID = "live_release";
const RELEASE_QUESTION_KEY_RE = /(?:^|:)(?:live-)?release:([0-9a-f]{7,40}|rc-\d{4}-\d{2}-\d{2}\.\d+)$/i;

/** The commit or rc-* tag an "is it released?" card asks about, from its idempotencyKey. */
export function parseReleaseQuestionRef(idempotencyKey: string | null | undefined): string | null {
  return RELEASE_QUESTION_KEY_RE.exec(idempotencyKey ?? "")?.[1] ?? null;
}

export async function announceLiveRelease(
  db: Db,
  event: LiveReleaseEvent,
  isRefLive: (ref: string) => boolean | null,
  opts: { heartbeat?: Pick<ReturnType<typeof heartbeatService>, "wakeLiveReleaseMonitors" | "wakeup"> } = {},
) {
  const heartbeat = opts.heartbeat ?? heartbeatService(db);
  const liveRelease = {
    commit: event.commit,
    tag: event.tag,
    startedAt: event.startedAt,
    previousCommit: event.previousCommit,
  };

  const activeCompanies = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
  for (const company of activeCompanies) {
    const [already] = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, company.id),
          eq(activityLog.action, LIVE_RELEASE_ACTIVITY_ACTION),
          sql`${activityLog.details} ->> 'commit' = ${event.commit}`,
        ),
      )
      .limit(1);
    if (already) continue;
    await logActivity(db, {
      companyId: company.id,
      actorType: "system",
      actorId: ACTOR_ID,
      action: LIVE_RELEASE_ACTIVITY_ACTION,
      entityType: "release",
      entityId: event.commit,
      details: { ...event },
    });
  }

  const { triggeredIssueIds } = await heartbeat.wakeLiveReleaseMonitors({ liveRelease, isRefLive });
  const woken = new Set(triggeredIssueIds);

  const pendingCards = await db
    .select({
      interaction: issueThreadInteractions,
      issue: {
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      },
    })
    .from(issueThreadInteractions)
    .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
    .innerJoin(companies, eq(companies.id, issues.companyId))
    .where(
      and(
        eq(companies.status, "active"),
        eq(issueThreadInteractions.status, "pending"),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        isNotNull(issueThreadInteractions.createdByAgentId),
        like(issueThreadInteractions.idempotencyKey, "%release:%"),
      ),
    );

  const interactions = issueThreadInteractionService(db);
  const withdrawnByIssue = new Map<string, { issue: (typeof pendingCards)[number]["issue"]; interactionIds: string[] }>();
  for (const { interaction, issue } of pendingCards) {
    const ref = parseReleaseQuestionRef(interaction.idempotencyKey);
    if (!ref || isRefLive(ref) !== true) continue;
    const reason = `Answered by the platform: live now runs ${event.commit.slice(0, 9)}${event.tag ? ` (${event.tag})` : ""}, which contains ${ref}.`;
    try {
      await interactions.withdrawInteraction(issue, interaction.id, { reason }, {});
    } catch (err) {
      logger.warn({ err, interactionId: interaction.id, issueId: issue.id }, "live release: could not withdraw an answered release card");
      continue;
    }
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: ACTOR_ID,
      action: "issue.thread_interaction_withdrawn",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: "cancelled",
        reason,
        liveRelease,
      },
    });
    const entry = withdrawnByIssue.get(issue.id) ?? { issue, interactionIds: [] };
    entry.interactionIds.push(interaction.id);
    withdrawnByIssue.set(issue.id, entry);
  }

  for (const { issue, interactionIds } of withdrawnByIssue.values()) {
    if (woken.has(issue.id) || !issue.assigneeAgentId || issue.assigneeUserId) continue;
    if (issue.status === "done" || issue.status === "cancelled") continue;
    try {
      await heartbeat.wakeup(issue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: LIVE_RELEASE_WAKE_REASON,
        idempotencyKey: `live-release:${issue.id}:${event.commit}`,
        payload: { issueId: issue.id, liveRelease, withdrawnInteractionIds: interactionIds },
        requestedByActorType: "system",
        requestedByActorId: ACTOR_ID,
        contextSnapshot: {
          issueId: issue.id,
          source: "live_release",
          wakeReason: LIVE_RELEASE_WAKE_REASON,
          liveRelease,
          withdrawnInteractionIds: interactionIds,
        },
      });
      woken.add(issue.id);
    } catch (err) {
      logger.warn({ err, issueId: issue.id }, "live release: could not wake the agent of an answered release card");
    }
  }

  return { companies: activeCompanies.length, wokenIssueIds: [...woken], withdrawnIssueIds: [...withdrawnByIssue.keys()] };
}
