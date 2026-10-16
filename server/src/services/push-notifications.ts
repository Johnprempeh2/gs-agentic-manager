import { and, eq, gte, inArray, isNotNull, ne, or, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { companies, issues, pipelineCaseEvents, pipelineCases, pushNotifiedDecisions, pushSubscriptions } from "@greatstone/db";
import type { DecisionCard, DecisionsFeed, NeedsMeTask, NotificationPreferences } from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { needsMeService } from "./needs-me.js";
import { isHeld, mayNotify, notificationPreferencesService } from "./notification-preferences.js";
import { loadOrCreateVapidKeys } from "./push-keys.js";
import { sendWebPush, type PushSendResult, type PushTarget, type VapidKeys } from "./web-push.js";

/** The push service contact in every VAPID token (RFC 8292 `sub`). */
export const PUSH_SUBJECT = "mailto:info@greatstone.co.uk";

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/** What the phone shows. `url` opens on tap; `badge` sets the app icon count (left alone when absent). */
export interface DecisionPushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
  badge?: number;
}

/**
 * What needs this user now: the Decisions feed (`count` is its count, the
 * same number as the Decisions badge) and the open tasks assigned to them
 * that are not already a decision card.
 */
type FeedBuilder = (
  companyId: string,
  userId: string,
) => Promise<Pick<DecisionsFeed, "cards" | "count"> & { assignedTasks?: Array<Pick<NeedsMeTask, "id" | "title">> }>;
/** A task the user asked for that someone else finished. */
export interface FinishedTask {
  id: string;
  identifier: string | null;
  title: string;
}
type FinishedReader = (companyId: string, userId: string, since: Date) => Promise<FinishedTask[]>;
/** A deal (pipeline case) that someone else just closed as won or lost. */
export interface ClosedDeal {
  id: string;
  pipelineId: string;
  title: string;
  terminalKind: string;
}
type ClosedDealReader = (companyId: string, userId: string, since: Date) => Promise<ClosedDeal[]>;
type PreferencesReader = (companyId: string, userId: string) => Promise<NotificationPreferences>;
type Sender = (target: PushTarget, message: DecisionPushMessage) => Promise<PushSendResult>;

/** Remembered-card id for a task given to the user, kept apart from decision card ids (`task:...`). */
export const assignedTaskCardId = (issueId: string) => `assigned:${issueId}`;

/** Remembered-card id for a finished task the user was told about. */
export const finishedTaskCardId = (issueId: string) => `finished:${issueId}`;

/** Remembered-card id for a closed deal the user was told about. */
export const closedDealCardId = (caseId: string) => `deal:${caseId}`;

/**
 * Only tasks finished this recently are announced: turning this on, or a
 * new server, never sends a backlog. The morning summary lists the rest.
 */
export const FINISHED_WINDOW_MS = 30 * 60 * 1000;

/** One notification for tasks the user asked for that were just finished. */
export function finishedTaskPushMessage(fresh: FinishedTask[], count: number, prefix: string): DecisionPushMessage {
  const first = fresh[0]!;
  if (fresh.length === 1) {
    return {
      title: "Done: a task you asked for",
      body: first.title,
      url: `/${prefix}/issues/${first.identifier ?? first.id}`,
      tag: finishedTaskCardId(first.id),
      badge: count,
    };
  }
  return {
    title: `${fresh.length} tasks you asked for are done`,
    body: `${first.title} and ${fresh.length - 1} more`,
    url: `/${prefix}/today`,
    tag: "finished-tasks",
    badge: count,
  };
}

/** One notification for deals just won or lost. Done stages count as won, cancelled ones as lost. */
export function closedDealPushMessage(fresh: ClosedDeal[], count: number, prefix: string): DecisionPushMessage {
  const first = fresh[0]!;
  if (fresh.length === 1) {
    return {
      title: first.terminalKind === "done" ? "Deal won" : "Deal lost",
      body: first.title,
      url: `/${prefix}/pipelines/${first.pipelineId}/cases/${first.id}`,
      tag: closedDealCardId(first.id),
      badge: count,
    };
  }
  const won = fresh.filter((deal) => deal.terminalKind === "done").length;
  const lost = fresh.length - won;
  const parts = [won > 0 ? `${won} won` : null, lost > 0 ? `${lost} lost` : null].filter(Boolean).join(", ");
  return {
    title: `${fresh.length} deals closed: ${parts}`,
    body: `${first.title} and ${fresh.length - 1} more`,
    url: `/${prefix}/pipelines/${first.pipelineId}`,
    tag: "closed-deals",
    badge: count,
  };
}

/** One notification for tasks newly given to the user. */
export function assignedTaskPushMessage(fresh: Array<Pick<NeedsMeTask, "id" | "title">>, count: number, prefix: string): DecisionPushMessage {
  const first = fresh[0]!;
  if (fresh.length === 1) {
    return { title: "A task was given to you", body: first.title, url: `/${prefix}/inbox/mine`, tag: assignedTaskCardId(first.id), badge: count };
  }
  return {
    title: `${fresh.length} tasks were given to you`,
    body: `${first.title} and ${fresh.length - 1} more`,
    url: `/${prefix}/inbox/mine`,
    tag: "assigned-tasks",
    badge: count,
  };
}

/** One notification per round: the card itself, or a summary when several arrive at once. */
export function decisionPushMessage(fresh: DecisionCard[], count: number, prefix: string): DecisionPushMessage {
  const first = fresh[0]!;
  const url = `/${prefix}/decisions`;
  if (fresh.length === 1 && first.kind === "outage") {
    // An outage notice, not a decision (GRE-999): the card's text says it all.
    return { title: "GSAM lost the internet", body: first.reason, url, tag: first.id, badge: count };
  }
  if (fresh.length === 1) {
    return { title: "A decision needs you", body: first.title, url, tag: first.id, badge: count };
  }
  return {
    title: `${fresh.length} decisions need you`,
    body: `${first.title} and ${fresh.length - 1} more`,
    url,
    tag: "decisions",
    badge: count,
  };
}

export function pushNotificationService(
  db: Db,
  options: {
    keys?: () => VapidKeys;
    buildFeed?: FeedBuilder;
    finished?: FinishedReader;
    closedDeals?: ClosedDealReader;
    send?: Sender;
    preferences?: PreferencesReader;
    now?: () => Date;
  } = {},
) {
  const keys = options.keys ?? (() => loadOrCreateVapidKeys());
  const needsMe = needsMeService(db);
  const buildFeed: FeedBuilder = options.buildFeed ?? (async (companyId, userId) => {
    const built = await needsMe.build(companyId, { userId });
    return { cards: built.decisions, count: built.decisionCount, assignedTasks: built.assignedTasks };
  });
  // Tasks this person created that someone else (an agent or a teammate) finished.
  const readFinished: FinishedReader = options.finished ?? ((companyId, userId, since) =>
    db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.createdByUserId, userId),
        eq(issues.status, "done"),
        isNotNull(issues.completedAt),
        gte(issues.completedAt, since),
        or(isNull(issues.assigneeUserId), ne(issues.assigneeUserId, userId)),
      ))
      .limit(50));
  // Deals closed as won or lost, except ones this person closed themselves.
  const readClosedDeals: ClosedDealReader = options.closedDeals ?? ((companyId, userId, since) =>
    db
      .select({ id: pipelineCases.id, pipelineId: pipelineCases.pipelineId, title: pipelineCases.title, terminalKind: pipelineCases.terminalKind })
      .from(pipelineCases)
      .where(and(
        eq(pipelineCases.companyId, companyId),
        isNotNull(pipelineCases.terminalKind),
        isNotNull(pipelineCases.terminalAt),
        gte(pipelineCases.terminalAt, since),
        sql`not exists (select 1 from ${pipelineCaseEvents} where ${pipelineCaseEvents.caseId} = ${pipelineCases.id} and ${pipelineCaseEvents.actorUserId} = ${userId} and ${pipelineCaseEvents.createdAt} >= ${since.toISOString()})`,
      ))
      .limit(50) as Promise<ClosedDeal[]>);
  const prefsService = notificationPreferencesService(db);
  const readPreferences: PreferencesReader = options.preferences ?? ((companyId, userId) => prefsService.get(companyId, userId));
  const now = options.now ?? (() => new Date());
  const send: Sender = options.send ?? ((target, message) => sendWebPush(target, message, keys(), { subject: PUSH_SUBJECT }));

  async function rememberCards(companyId: string, userId: string, cardIds: string[]) {
    if (cardIds.length === 0) return;
    await db
      .insert(pushNotifiedDecisions)
      .values(cardIds.map((cardId) => ({ companyId, userId, cardId })))
      .onConflictDoNothing();
  }

  async function deliver(companyId: string, userId: string, message: DecisionPushMessage) {
    const targets = await db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.companyId, companyId), eq(pushSubscriptions.userId, userId)));
    let delivered = 0;
    for (const target of targets) {
      let result: PushSendResult;
      try {
        result = await send(target, message);
      } catch (error) {
        logger.warn({ err: error, subscriptionId: target.id }, "web push delivery failed");
        result = { ok: false, status: 0, gone: false };
      }
      if (result.ok) {
        delivered += 1;
        await db.update(pushSubscriptions)
          .set({ lastSuccessAt: new Date(), failureCount: 0, updatedAt: new Date() })
          .where(eq(pushSubscriptions.id, target.id));
      } else if (result.gone) {
        // The phone removed the app or turned notifications off.
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, target.id));
      } else {
        await db.update(pushSubscriptions)
          .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1`, updatedAt: new Date() })
          .where(eq(pushSubscriptions.id, target.id));
      }
    }
    return { targets: targets.length, delivered };
  }

  return {
    publicKey: () => keys().publicKey,

    /**
     * Save this phone for this user and company. The decisions already
     * waiting are marked as seen, so turning notifications on never floods
     * the phone with the backlog.
     */
    async subscribe(companyId: string, userId: string, input: PushSubscriptionInput) {
      const now = new Date();
      const [row] = await db
        .insert(pushSubscriptions)
        .values({ companyId, userId, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent ?? null })
        .onConflictDoUpdate({
          target: [pushSubscriptions.companyId, pushSubscriptions.endpoint],
          set: { userId, p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent ?? null, failureCount: 0, updatedAt: now },
        })
        .returning();
      const feed = await buildFeed(companyId, userId);
      const since = new Date(now.getTime() - FINISHED_WINDOW_MS);
      const finished = await readFinished(companyId, userId, since);
      const closed = await readClosedDeals(companyId, userId, since);
      await rememberCards(companyId, userId, [
        ...feed.cards.map((card) => card.id),
        ...(feed.assignedTasks ?? []).map((task) => assignedTaskCardId(task.id)),
        ...finished.map((task) => finishedTaskCardId(task.id)),
        ...closed.map((deal) => closedDealCardId(deal.id)),
      ]);
      return row!;
    },

    async unsubscribe(companyId: string, userId: string, endpoint: string) {
      const removed = await db
        .delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.companyId, companyId), eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
        .returning({ id: pushSubscriptions.id });
      return removed.length > 0;
    },

    async isSubscribed(companyId: string, userId: string, endpoint: string) {
      const [row] = await db
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.companyId, companyId), eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
      return Boolean(row);
    },

    /**
     * One team chat notification to every phone this user registered for the
     * company, unless they turned team chat off or it is their quiet hours.
     */
    async sendToUser(companyId: string, userId: string, message: DecisionPushMessage) {
      const prefs = await readPreferences(companyId, userId);
      if (!mayNotify(prefs, "teamChat", now())) return { targets: 0, delivered: 0 };
      return deliver(companyId, userId, message);
    },

    /** One message to every phone this user registered, with no preference check (the morning summary checks its own). */
    deliver: (companyId: string, userId: string, message: DecisionPushMessage) => deliver(companyId, userId, message),

    /** A test notification to every phone this user registered for the company. */
    async sendTest(companyId: string, userId: string, prefix: string) {
      return deliver(companyId, userId, {
        title: "Notifications are on",
        body: "You will hear from GS Agentic Manager when something needs you.",
        url: `/${prefix}/decisions`,
        tag: "push-test",
        badge: (await buildFeed(companyId, userId)).count,
      });
    },

    /**
     * One round: for each user with a phone registered, tell them about
     * decisions that appeared since the last round, and forget cards that
     * left the feed. Returns how many notifications went out.
     */
    async notifyNewDecisions(): Promise<number> {
      const audiences = await db
        .selectDistinct({ companyId: pushSubscriptions.companyId, userId: pushSubscriptions.userId, prefix: companies.issuePrefix })
        .from(pushSubscriptions)
        .innerJoin(companies, eq(companies.id, pushSubscriptions.companyId));
      let sent = 0;
      for (const { companyId, userId, prefix } of audiences) {
        try {
          const built = await buildFeed(companyId, userId);
          const prefs = await readPreferences(companyId, userId);
          // During quiet hours or a pause nothing is sent or remembered: what
          // arrived meanwhile goes out in the first round after they end.
          if (isHeld(prefs, now())) continue;
          // "At your desk" cards never go to the phone (GRE-450).
          const feed = { ...built, cards: built.cards.filter((card) => !card.atDesk) };
          const assigned = built.assignedTasks ?? [];
          const known = new Set(
            (await db
              .select({ cardId: pushNotifiedDecisions.cardId })
              .from(pushNotifiedDecisions)
              .where(and(eq(pushNotifiedDecisions.companyId, companyId), eq(pushNotifiedDecisions.userId, userId))))
              .map((row) => row.cardId),
          );
          const since = new Date(now().getTime() - FINISHED_WINDOW_MS);
          const finished = await readFinished(companyId, userId, since);
          const closed = await readClosedDeals(companyId, userId, since);
          const current = new Set([
            ...feed.cards.map((card) => card.id),
            ...assigned.map((task) => assignedTaskCardId(task.id)),
            ...finished.map((task) => finishedTaskCardId(task.id)),
            ...closed.map((deal) => closedDealCardId(deal.id)),
          ]);
          const gone = [...known].filter((cardId) => !current.has(cardId));
          if (gone.length > 0) {
            await db.delete(pushNotifiedDecisions).where(and(
              eq(pushNotifiedDecisions.companyId, companyId),
              eq(pushNotifiedDecisions.userId, userId),
              inArray(pushNotifiedDecisions.cardId, gone),
            ));
          }
          let fresh = feed.cards.filter((card) => !known.has(card.id));
          // An outage is instance-wide and shows in every company: the phone
          // hears about it once per user, not once per company (GRE-999).
          const outageIds = fresh.filter((card) => card.kind === "outage").map((card) => card.id);
          if (outageIds.length > 0) {
            const told = new Set((await db
              .select({ cardId: pushNotifiedDecisions.cardId })
              .from(pushNotifiedDecisions)
              .where(and(eq(pushNotifiedDecisions.userId, userId), inArray(pushNotifiedDecisions.cardId, outageIds))))
              .map((row) => row.cardId));
            if (told.size > 0) {
              await rememberCards(companyId, userId, [...told]);
              fresh = fresh.filter((card) => !told.has(card.id));
            }
          }
          const freshTasks = assigned.filter((task) => !known.has(assignedTaskCardId(task.id)));
          const freshFinished = finished.filter((task) => !known.has(finishedTaskCardId(task.id)));
          const freshClosed = closed.filter((deal) => !known.has(closedDealCardId(deal.id)));
          if (fresh.length === 0 && freshTasks.length === 0 && freshFinished.length === 0 && freshClosed.length === 0) continue;
          // Remember first: a slow or failing push service never repeats a
          // card. A topic switched off is remembered too, so switching it back
          // on never floods the phone with the backlog.
          await rememberCards(companyId, userId, [
            ...fresh.map((card) => card.id),
            ...freshTasks.map((task) => assignedTaskCardId(task.id)),
            ...freshFinished.map((task) => finishedTaskCardId(task.id)),
            ...freshClosed.map((deal) => closedDealCardId(deal.id)),
          ]);
          // An outage notice is about GSAM itself, so it ignores the decisions switch.
          const sendCards = prefs.decisions ? fresh : fresh.filter((card) => card.kind === "outage");
          if (sendCards.length > 0) {
            const { delivered } = await deliver(companyId, userId, decisionPushMessage(sendCards, feed.count, prefix));
            sent += delivered;
          }
          if (prefs.assignedTasks && freshTasks.length > 0) {
            const { delivered } = await deliver(companyId, userId, assignedTaskPushMessage(freshTasks, feed.count, prefix));
            sent += delivered;
          }
          if (prefs.finishedWork && freshFinished.length > 0) {
            const { delivered } = await deliver(companyId, userId, finishedTaskPushMessage(freshFinished, feed.count, prefix));
            sent += delivered;
          }
          if (prefs.finishedWork && freshClosed.length > 0) {
            const { delivered } = await deliver(companyId, userId, closedDealPushMessage(freshClosed, feed.count, prefix));
            sent += delivered;
          }
        } catch (error) {
          logger.warn({ err: error, companyId }, "decision push round failed for one user");
        }
      }
      return sent;
    },
  };
}
