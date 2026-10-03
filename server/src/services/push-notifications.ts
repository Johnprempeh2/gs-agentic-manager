import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { companies, pushNotifiedDecisions, pushSubscriptions } from "@greatstone/db";
import type { DecisionCard, DecisionsFeed } from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { decisionsFeedService } from "./decisions-feed.js";
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

/** What the phone shows. `url` opens on tap; `badge` sets the app icon count. */
export interface DecisionPushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
  badge: number;
}

type FeedBuilder = (companyId: string, userId: string) => Promise<Pick<DecisionsFeed, "cards" | "count">>;
type Sender = (target: PushTarget, message: DecisionPushMessage) => Promise<PushSendResult>;

/** One notification per round: the card itself, or a summary when several arrive at once. */
export function decisionPushMessage(fresh: DecisionCard[], count: number, prefix: string): DecisionPushMessage {
  const first = fresh[0]!;
  const url = `/${prefix}/decisions`;
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
  options: { keys?: () => VapidKeys; buildFeed?: FeedBuilder; send?: Sender } = {},
) {
  const keys = options.keys ?? (() => loadOrCreateVapidKeys());
  const feeds = decisionsFeedService(db);
  const buildFeed: FeedBuilder = options.buildFeed ?? ((companyId, userId) => feeds.build(companyId, { userId }));
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
      await rememberCards(companyId, userId, feed.cards.map((card) => card.id));
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

    /** A test notification to every phone this user registered for the company. */
    async sendTest(companyId: string, userId: string, prefix: string) {
      return deliver(companyId, userId, {
        title: "Notifications are on",
        body: "You will hear from GS Agentic Manager when a decision needs you.",
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
          // "At your desk" cards never go to the phone (GRE-450).
          const feed = { ...built, cards: built.cards.filter((card) => !card.atDesk) };
          const known = new Set(
            (await db
              .select({ cardId: pushNotifiedDecisions.cardId })
              .from(pushNotifiedDecisions)
              .where(and(eq(pushNotifiedDecisions.companyId, companyId), eq(pushNotifiedDecisions.userId, userId))))
              .map((row) => row.cardId),
          );
          const current = new Set(feed.cards.map((card) => card.id));
          const gone = [...known].filter((cardId) => !current.has(cardId));
          if (gone.length > 0) {
            await db.delete(pushNotifiedDecisions).where(and(
              eq(pushNotifiedDecisions.companyId, companyId),
              eq(pushNotifiedDecisions.userId, userId),
              inArray(pushNotifiedDecisions.cardId, gone),
            ));
          }
          const fresh = feed.cards.filter((card) => !known.has(card.id));
          if (fresh.length === 0) continue;
          // Remember first: a slow or failing push service never repeats a card.
          await rememberCards(companyId, userId, fresh.map((card) => card.id));
          const { delivered } = await deliver(companyId, userId, decisionPushMessage(fresh, feed.count, prefix));
          sent += delivered;
        } catch (error) {
          logger.warn({ err: error, companyId }, "decision push round failed for one user");
        }
      }
      return sent;
    },
  };
}
