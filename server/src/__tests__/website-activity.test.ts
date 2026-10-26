import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, principalPermissionGrants, websiteActivityCursors, websiteActivityEvents, websiteSite } from "@greatstone/db";
import type { WebsiteActivityBatch, WebsiteActivityEvent } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { websiteActivityService } from "../services/website/activity.js";
import { websiteDataBridgeRoutes } from "../routes/website-data-bridge.js";
import { errorHandler } from "../middleware/error-handler.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe.sequential : describe.skip;

describeDb("website activity pull", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("website-activity-");
    db = createDb(tempDb.connectionString);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function site() {
    const [company] = await db.insert(companies).values({ name: "Test", issuePrefix: `T${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [row] = await db.insert(websiteSite).values({ companyId: company!.id, name: "Test", domain: "example.test", netlifySiteId: randomUUID() }).returning();
    return row!;
  }
  const organisationId = randomUUID();
  function event(sequence: number, id = randomUUID()): WebsiteActivityEvent {
    return { sequence: String(sequence), id, organisationId, kind: "interview.started", subjectId: `interview:${sequence}`,
      label: "Interview started", occurredAt: "2026-10-25T12:00:00.000Z" };
  }
  function batch(items: WebsiteActivityEvent[], cursor: string): WebsiteActivityBatch {
    return { items, nextCursor: items.at(-1)?.sequence ?? cursor };
  }

  it("commits ordered pages and resumes after the durable cursor", async () => {
    const row = await site();
    const calls: string[] = [];
    const service = websiteActivityService(db, { read: async (_site, cursor) => {
      calls.push(cursor);
      return cursor === "0" ? batch([event(1), event(3)], cursor)
        : cursor === "3" ? batch([event(4)], cursor) : batch([], cursor);
    } });
    expect(await service.pullSite(row)).toBe(2);
    expect(await service.pullSite(row)).toBe(1);
    expect(await service.pullSite(row)).toBe(0);
    expect(calls).toEqual(["0", "3", "4"]);
    const events = await db.select().from(websiteActivityEvents).where(eq(websiteActivityEvents.siteId, row.id)).orderBy(asc(websiteActivityEvents.sequence));
    expect(events.map((item) => Number(item.sequence))).toEqual([1, 3, 4]);
    expect((await service.list(row.companyId, organisationId)).items.map((item) => item.sequence)).toEqual(["4", "3", "1"]);
  });

  it("rejects a skipped cursor and leaves the page replayable", async () => {
    const row = await site();
    const service = websiteActivityService(db, { read: async () => ({ items: [event(1)], nextCursor: "2" }) });
    await expect(service.pullSite(row)).rejects.toThrow(/cursor/);
    expect(await db.select().from(websiteActivityEvents).where(eq(websiteActivityEvents.siteId, row.id))).toHaveLength(0);
    const [cursor] = await db.select().from(websiteActivityCursors).where(eq(websiteActivityCursors.siteId, row.id));
    expect(cursor!.sequence).toBe(0n);
  });

  it("refuses an unordered page without saving a partial stream", async () => {
    const row = await site();
    const service = websiteActivityService(db, { read: async () => batch([event(5), event(4)], "0") });
    await expect(service.pullSite(row)).rejects.toThrow(/unordered/);
    expect(await db.select().from(websiteActivityEvents).where(eq(websiteActivityEvents.siteId, row.id))).toHaveLength(0);
  });

  it("rolls back duplicate source IDs and keeps the prior cursor", async () => {
    const row = await site();
    const id = randomUUID();
    let page = 0;
    const service = websiteActivityService(db, { read: async (_site, cursor) => {
      page += 1;
      return page === 1 ? batch([event(1, id)], cursor) : batch([event(2, id)], cursor);
    } });
    expect(await service.pullSite(row)).toBe(1);
    await expect(service.pullSite(row)).rejects.toThrow();
    const [cursor] = await db.select().from(websiteActivityCursors).where(and(
      eq(websiteActivityCursors.companyId, row.companyId), eq(websiteActivityCursors.siteId, row.id),
    ));
    expect(cursor!.sequence).toBe(1n);
    expect(await db.select().from(websiteActivityEvents).where(eq(websiteActivityEvents.siteId, row.id))).toHaveLength(1);
  });

  it("pages a client stream without losing events at equal timestamps", async () => {
    const row = await site();
    const events = Array.from({ length: 101 }, (_, index) => event(index + 1));
    const service = websiteActivityService(db, { read: async (_site, cursor) => cursor === "0"
      ? batch(events.slice(0, 100), cursor) : batch(events.slice(100), cursor) });
    expect(await service.pullSite(row)).toBe(101);
    const first = await service.list(row.companyId, organisationId);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const [at, siteId, sequence] = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as [string, string, string];
    const second = await service.list(row.companyId, organisationId, { occurredAt: new Date(at), siteId, sequence: BigInt(sequence) });
    expect(second.items.map((item) => item.sequence)).toEqual(["1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("requires website:view and returns events only from sites in the caller's scope", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const first = await site();
    const [second] = await db.insert(websiteSite).values({ companyId: first.companyId, name: "Other", domain: "other.test", netlifySiteId: randomUUID() }).returning();
    const [agent] = await db.insert(agents).values({ companyId: first.companyId, name: "Viewer", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    await db.insert(companyMemberships).values({ companyId: first.companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    const actor = { type: "agent" as const, agentId: agent!.id, companyId: first.companyId, source: "agent_key" as const };
    const app = express();
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", websiteDataBridgeRoutes(db));
    app.use(errorHandler);
    const path = `/api/companies/${first.companyId}/website/activity/${organisationId}`;
    const firstEvent = event(1);
    const secondEvent = event(2);
    await db.insert(websiteActivityEvents).values([
      { companyId: first.companyId, siteId: first.id, sequence: 1n, id: firstEvent.id, organisationId, kind: firstEvent.kind, subjectId: firstEvent.subjectId, label: firstEvent.label, occurredAt: new Date(firstEvent.occurredAt) },
      { companyId: first.companyId, siteId: second!.id, sequence: 2n, id: secondEvent.id, organisationId, kind: secondEvent.kind, subjectId: secondEvent.subjectId, label: secondEvent.label, occurredAt: new Date(secondEvent.occurredAt) },
    ]);
    await request(app).get(path).expect(403);
    await db.insert(principalPermissionGrants).values({ companyId: first.companyId, principalType: "agent", principalId: agent!.id, permissionKey: "website:view", scope: { siteIds: [first.id] } });
    const allowed = await request(app).get(path).expect(200);
    expect(allowed.body.items.map((item: { siteId: string }) => item.siteId)).toEqual([first.id]);
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: false });
    const disabled = await request(app).get(path).expect(403);
    expect(disabled.body.details?.code ?? disabled.body.code).toBe("not_entitled");
  });
});
