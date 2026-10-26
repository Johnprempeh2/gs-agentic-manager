import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { websiteActivityCursors, websiteActivityEvents, websiteSite } from "@greatstone/db";
import { websiteActivityBatchSchema, type WebsiteActivityBatch } from "@greatstone/shared";
import { websiteDataBridgeService } from "./data-bridge.js";

export interface WebsiteActivityReader {
  read(site: typeof websiteSite.$inferSelect, cursor: string): Promise<WebsiteActivityBatch>;
}

/** Cursor and events commit together. A failed page is fetched again verbatim. */
export function websiteActivityService(db: Db, reader: WebsiteActivityReader) {
  async function pullSite(site: typeof websiteSite.$inferSelect) {
    await db.insert(websiteActivityCursors).values({ companyId: site.companyId, siteId: site.id }).onConflictDoNothing();
    let inserted = 0;
    for (let page = 0; page < 200; page += 1) {
      const [current] = await db.select({ sequence: websiteActivityCursors.sequence }).from(websiteActivityCursors).where(and(
        eq(websiteActivityCursors.companyId, site.companyId), eq(websiteActivityCursors.siteId, site.id),
      ));
      const cursor = String(current!.sequence);
      const batch = websiteActivityBatchSchema.parse(await reader.read(site, cursor));
      let last = BigInt(cursor);
      for (const item of batch.items) {
        const sequence = BigInt(item.sequence);
        if (sequence <= last) throw new Error("Website activity page is unordered or replays an acknowledged event");
        last = sequence;
      }
      if (batch.nextCursor !== String(last)) throw new Error("Website activity cursor does not name the last event");
      if (batch.items.length === 0) return inserted;
      const committed = await db.transaction(async (tx) => {
        const [locked] = await tx.select({ sequence: websiteActivityCursors.sequence }).from(websiteActivityCursors).where(and(
          eq(websiteActivityCursors.companyId, site.companyId), eq(websiteActivityCursors.siteId, site.id),
        )).for("update");
        if (locked?.sequence !== BigInt(cursor)) return false;
        await tx.insert(websiteActivityEvents).values(batch.items.map((item) => ({
          companyId: site.companyId, siteId: site.id, sequence: BigInt(item.sequence), id: item.id,
          organisationId: item.organisationId, kind: item.kind, subjectId: item.subjectId,
          label: item.label, occurredAt: new Date(item.occurredAt),
        })));
        await tx.update(websiteActivityCursors).set({ sequence: last, updatedAt: new Date() }).where(and(
          eq(websiteActivityCursors.companyId, site.companyId), eq(websiteActivityCursors.siteId, site.id),
        ));
        return true;
      });
      if (!committed) continue;
      inserted += batch.items.length;
      if (batch.items.length < 100) return inserted;
    }
    throw new Error("Website activity pull exceeded its page limit");
  }

  return {
    pullSite,
    async list(companyId: string, organisationId: string, cursor?: { occurredAt: Date; siteId: string; sequence: bigint }, siteIds?: string[]) {
      if (siteIds?.length === 0) return { items: [], nextCursor: null };
      const rows = await db.select().from(websiteActivityEvents).where(and(
        eq(websiteActivityEvents.companyId, companyId), eq(websiteActivityEvents.organisationId, organisationId),
        ...(siteIds ? [inArray(websiteActivityEvents.siteId, siteIds)] : []),
        ...(cursor ? [or(
          lt(websiteActivityEvents.occurredAt, cursor.occurredAt),
          and(eq(websiteActivityEvents.occurredAt, cursor.occurredAt), lt(websiteActivityEvents.siteId, cursor.siteId)),
          and(eq(websiteActivityEvents.occurredAt, cursor.occurredAt), eq(websiteActivityEvents.siteId, cursor.siteId),
            lt(websiteActivityEvents.sequence, cursor.sequence)),
        )] : []),
      )).orderBy(desc(websiteActivityEvents.occurredAt), desc(websiteActivityEvents.siteId), desc(websiteActivityEvents.sequence)).limit(101);
      const items = rows.slice(0, 100).map((row) => ({ ...row, sequence: String(row.sequence) }));
      const last = rows[99];
      return { items, nextCursor: rows.length > 100 && last
        ? Buffer.from(JSON.stringify([last.occurredAt.toISOString(), last.siteId, String(last.sequence)])).toString("base64url")
        : null };
    },
  };
}

export function startWebsiteActivityScheduler(db: Db, onError: (error: unknown, siteId: string) => void) {
  const bridge = websiteDataBridgeService(db);
  const service = websiteActivityService(db, { read: async (site, cursor) =>
    (await bridge.client(site)).activity(cursor, { type: "system", id: "website-activity-pull" }) });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const sites = await db.select().from(websiteSite).where(and(
        isNull(websiteSite.archivedAt), isNotNull(websiteSite.dataBridgeReadSecretId),
      ));
      for (const site of sites) {
        try { await service.pullSite(site); } catch (error) { onError(error, site.id); }
      }
    } catch (error) { onError(error, ""); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 5 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
