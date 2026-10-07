import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDb, companies, pushNotifiedDecisions, pushSubscriptions } from "@greatstone/db";
import { startEmbeddedPostgresTestDatabase } from "@greatstone/db/test-embedded-postgres";
import type { DecisionCard } from "@greatstone/shared";
import { decisionPushMessage, pushNotificationService, type DecisionPushMessage } from "../services/push-notifications.js";
import { loadOrCreateVapidKeys } from "../services/push-keys.js";
import { generateVapidKeys, type PushSendResult, type PushTarget } from "../services/web-push.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const keys = generateVapidKeys();

const card = (id: string, title = id) => ({ id, title, kind: "blocked", kinds: ["blocked"], task: null, reason: "", waiting: null }) as unknown as DecisionCard;
const phone = (n: number) => ({ endpoint: `https://web.push.apple.com/device-${n}`, p256dh: "p256dh", auth: "auth" });

let feedCards: DecisionCard[] = [];
let sent: Array<{ target: PushTarget; message: DecisionPushMessage }> = [];
let sendResult: PushSendResult = { ok: true, status: 201 };

function service() {
  return pushNotificationService(db, {
    keys: () => keys,
    buildFeed: async () => ({ cards: feedCards, count: feedCards.length }),
    send: async (target, message) => {
      sent.push({ target, message });
      return sendResult;
    },
  });
}

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "gsam-push-tests-"));
  vi.stubEnv("GSAM_HOME", home);
  vi.stubEnv("GSAM_INSTANCE_ID", "push-fixture");
  database = await startEmbeddedPostgresTestDatabase("gsam-push-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Push tests", issuePrefix: "PSH" });
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

beforeEach(async () => {
  await db.delete(pushNotifiedDecisions);
  await db.delete(pushSubscriptions);
  feedCards = [];
  sent = [];
  sendResult = { ok: true, status: 201 };
});

describe("decision push notifications", () => {
  it("turning notifications on never sends the decisions already waiting", async () => {
    feedCards = [card("task:a"), card("task:b")];
    await service().subscribe(companyId, "john", phone(1));
    expect(await service().notifyNewDecisions()).toBe(0);
    expect(sent).toEqual([]);
  });

  it("notifies once for a new decision, links to Decisions and sets the badge", async () => {
    feedCards = [card("task:a")];
    await service().subscribe(companyId, "john", phone(1));
    feedCards = [card("task:a"), card("task:b", "Approve the new hire")];
    expect(await service().notifyNewDecisions()).toBe(1);
    expect(sent[0]!.message).toEqual({ title: "A decision needs you", body: "Approve the new hire", url: "/PSH/decisions", tag: "task:b", badge: 2 });
    // The next round has nothing new.
    expect(await service().notifyNewDecisions()).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("sends one push per internet outage card, worded as a notice (GRE-999)", async () => {
    await service().subscribe(companyId, "john", phone(1));
    const outage = { ...card("outage:1", "GSAM was offline from 14:02 to 15:05"), kind: "outage", kinds: ["outage"], reason: "GSAM was offline from 14:02 to 15:05, 1 h 3 min." } as DecisionCard;
    // The same user has a phone registered in a second company too.
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Push tests 2", issuePrefix: "PS2" });
    await service().subscribe(otherCompanyId, "john", phone(2));
    feedCards = [outage];
    expect(await service().notifyNewDecisions()).toBe(1);
    expect(await service().notifyNewDecisions()).toBe(0);
    // One push in all, from whichever company's round came first.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toMatchObject({ title: "GSAM lost the internet", body: "GSAM was offline from 14:02 to 15:05, 1 h 3 min.", tag: "outage:1", badge: 1 });
  });

  it("never sends an 'at your desk' card to the phone (GRE-450)", async () => {
    await service().subscribe(companyId, "john", phone(1));
    feedCards = [{ ...card("task:wsl", "Restart WSL"), atDesk: { command: "wsl --shutdown" } }];
    expect(await service().notifyNewDecisions()).toBe(0);
    expect(sent).toEqual([]);
  });

  it("forgets a decision that left the feed, so a new one on the same task notifies again", async () => {
    await service().subscribe(companyId, "john", phone(1));
    feedCards = [card("task:a")];
    await service().notifyNewDecisions();
    feedCards = [];
    await service().notifyNewDecisions();
    feedCards = [card("task:a")];
    await service().notifyNewDecisions();
    expect(sent.map((entry) => entry.message.tag)).toEqual(["task:a", "task:a"]);
  });

  it("sends to every phone of that user only, and removes a phone the push service dropped", async () => {
    await service().subscribe(companyId, "john", phone(1));
    await service().subscribe(companyId, "john", phone(2));
    await service().subscribe(companyId, "ben", phone(3));
    feedCards = [card("task:a")];
    sendResult = { ok: false, status: 410, gone: true };
    await service().notifyNewDecisions();
    // Each user builds their own feed; all three phones were tried once.
    expect(sent.map((entry) => entry.target.endpoint).sort()).toEqual([phone(1).endpoint, phone(2).endpoint, phone(3).endpoint]);
    expect(await db.select().from(pushSubscriptions)).toEqual([]);
  });

  it("counts a failure without dropping the phone", async () => {
    await service().subscribe(companyId, "john", phone(1));
    feedCards = [card("task:a")];
    sendResult = { ok: false, status: 500, gone: false };
    await service().notifyNewDecisions();
    const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, phone(1).endpoint));
    expect(row?.failureCount).toBe(1);
  });

  it("unsubscribe only removes the caller's own phone", async () => {
    await service().subscribe(companyId, "john", phone(1));
    expect(await service().unsubscribe(companyId, "ben", phone(1).endpoint)).toBe(false);
    expect(await service().unsubscribe(companyId, "john", phone(1).endpoint)).toBe(true);
    expect(await service().isSubscribed(companyId, "john", phone(1).endpoint)).toBe(false);
  });
});

describe("decision push message", () => {
  it("summarises several decisions that arrive together", () => {
    expect(decisionPushMessage([card("task:a", "One"), card("task:b", "Two"), card("task:c", "Three")], 5, "GRE")).toEqual({
      title: "3 decisions need you",
      body: "One and 2 more",
      url: "/GRE/decisions",
      tag: "decisions",
      badge: 5,
    });
  });
});

describe("VAPID key file", () => {
  it("is created once, owner-only, and reused", async () => {
    const file = path.join(home, "keys", "web-push-vapid.json");
    const first = loadOrCreateVapidKeys(file);
    const second = loadOrCreateVapidKeys(file);
    expect(second).toEqual(first);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
