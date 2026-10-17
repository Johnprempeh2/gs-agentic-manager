import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { clientAcceptanceLinks, createDb, companies, issues, pipelineCaseEvents, pipelineCases, pipelineStages, pipelines, pushNotifiedDecisions, pushSubscriptions } from "@greatstone/db";
import { startEmbeddedPostgresTestDatabase } from "@greatstone/db/test-embedded-postgres";
import { DEFAULT_NOTIFICATION_PREFERENCES, type DecisionCard, type NotificationPreferences } from "@greatstone/shared";
import { acceptancePushMessage, assignedTaskPushMessage, closedDealPushMessage, type ClientAcceptance, decisionPushMessage, finishedTaskPushMessage, type ClosedDeal, pushNotificationService, type DecisionPushMessage, type FinishedTask } from "../services/push-notifications.js";
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
let assignedTasks: Array<{ id: string; title: string }> = [];
let finishedTasks: FinishedTask[] = [];
let closedDeals: ClosedDeal[] = [];
let acceptances: ClientAcceptance[] = [];
let prefs: NotificationPreferences = { ...DEFAULT_NOTIFICATION_PREFERENCES };
let clock = new Date("2026-10-16T12:00:00Z");
let sent: Array<{ target: PushTarget; message: DecisionPushMessage }> = [];
let sendResult: PushSendResult = { ok: true, status: 201 };

function service() {
  return pushNotificationService(db, {
    keys: () => keys,
    buildFeed: async () => ({ cards: feedCards, count: feedCards.length, assignedTasks }),
    finished: async () => finishedTasks,
    closedDeals: async () => closedDeals,
    acceptances: async () => acceptances,
    preferences: async () => prefs,
    now: () => clock,
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
  assignedTasks = [];
  finishedTasks = [];
  closedDeals = [];
  acceptances = [];
  prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  clock = new Date("2026-10-16T12:00:00Z");
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

describe("notification choices", () => {
  it("tells the user once about a task given to them, linking to their inbox", async () => {
    await service().subscribe(companyId, "john", phone(1));
    assignedTasks = [{ id: "i1", title: "Sign the Indago brief" }];
    expect(await service().notifyNewDecisions()).toBe(1);
    expect(sent[0]!.message).toEqual({ title: "A task was given to you", body: "Sign the Indago brief", url: "/PSH/inbox/mine", tag: "assigned:i1", badge: 0 });
    expect(await service().notifyNewDecisions()).toBe(0);
  });

  it("tells the user once when a task they asked for is done, opening that task", async () => {
    await service().subscribe(companyId, "john", phone(1));
    finishedTasks = [{ id: "i9", identifier: "PSH-9", title: "Draft the Indago one-pager" }];
    expect(await service().notifyNewDecisions()).toBe(1);
    expect(sent[0]!.message).toEqual({
      title: "Done: a task you asked for",
      body: "Draft the Indago one-pager",
      url: "/PSH/issues/PSH-9",
      tag: "finished:i9",
      badge: 0,
    });
    expect(await service().notifyNewDecisions()).toBe(0);
  });

  it("tells the user once when a deal is won, opening that deal", async () => {
    await service().subscribe(companyId, "john", phone(1));
    closedDeals = [{ id: "c1", pipelineId: "p1", title: "Indago rollout", terminalKind: "done" }];
    expect(await service().notifyNewDecisions()).toBe(1);
    expect(sent[0]!.message).toEqual({ title: "Deal won", body: "Indago rollout", url: "/PSH/pipelines/p1/cases/c1", tag: "deal:c1", badge: 0 });
    expect(await service().notifyNewDecisions()).toBe(0);
  });

  it("stays quiet about closed deals when deal alerts are switched off", async () => {
    await service().subscribe(companyId, "john", phone(1));
    prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES, dealsClosed: false };
    closedDeals = [{ id: "c2", pipelineId: "p1", title: "Acme renewal", terminalKind: "cancelled" }];
    expect(await service().notifyNewDecisions()).toBe(0);
    prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES };
    expect(await service().notifyNewDecisions()).toBe(0);
  });

  it("finds client deals closed in the last half hour, except ones the user closed", async () => {
    const pipelineId = randomUUID();
    const stageId = randomUUID();
    await db.insert(pipelines).values({ id: pipelineId, companyId, key: "deals", name: "Deals", requiresOrganisation: true });
    await db.insert(pipelineStages).values({ id: stageId, companyId, pipelineId, key: "won", name: "Won", kind: "done", position: 0 });
    const recent = new Date(clock.getTime() - 5 * 60 * 1000);
    const [theirs, mine, old] = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(pipelineCases).values([
      { id: theirs, companyId, pipelineId, stageId, caseKey: "theirs", title: "Closed by Ben", terminalKind: "done", terminalAt: recent },
      { id: mine, companyId, pipelineId, stageId, caseKey: "mine", title: "Closed by John", terminalKind: "done", terminalAt: recent },
      { id: old, companyId, pipelineId, stageId, caseKey: "old", title: "Closed yesterday", terminalKind: "cancelled", terminalAt: new Date(clock.getTime() - 86_400_000) },
    ]);
    // A case closed on a pipeline that is not a client pipeline is not a deal.
    const otherPipelineId = randomUUID();
    const otherStageId = randomUUID();
    await db.insert(pipelines).values({ id: otherPipelineId, companyId, key: "hiring", name: "Hiring" });
    await db.insert(pipelineStages).values({ id: otherStageId, companyId, pipelineId: otherPipelineId, key: "hired", name: "Hired", kind: "done", position: 0 });
    await db.insert(pipelineCases).values({ companyId, pipelineId: otherPipelineId, stageId: otherStageId, caseKey: "cand", title: "Candidate hired", terminalKind: "done", terminalAt: recent });
    await db.insert(pipelineCaseEvents).values({ companyId, caseId: mine, type: "transitioned", actorType: "user", actorUserId: "john", toStageId: stageId, createdAt: recent });
    const spy = pushNotificationService(db, {
      keys: () => keys,
      buildFeed: async () => ({ cards: [], count: 0, assignedTasks: [] }),
      finished: async () => [],
      preferences: async () => prefs,
      now: () => clock,
      send: async (target, message) => { sent.push({ target, message }); return sendResult; },
    });
    await spy.subscribe(companyId, "john", phone(8));
    await db.delete(pushNotifiedDecisions);
    await spy.notifyNewDecisions();
    const johns = sent.filter((entry) => entry.target.endpoint === phone(8).endpoint).map((entry) => entry.message.body);
    expect(johns).toEqual(["Closed by Ben"]);
    await db.delete(pipelines).where(inArray(pipelines.id, [pipelineId, otherPipelineId]));
  });

  it("tells the user once when a client accepts, naming who accepted", async () => {
    await service().subscribe(companyId, "john", phone(1));
    acceptances = [{ id: "l1", caseId: "c1", pipelineId: "p1", title: "Indago rollout", acceptedName: "Ama Owusu" }];
    expect(await service().notifyNewDecisions()).toBe(1);
    expect(sent[0]!.message).toEqual({
      title: "A client accepted",
      body: "Indago rollout, accepted by Ama Owusu",
      url: "/PSH/pipelines/p1/cases/c1",
      tag: "accepted:l1",
      badge: 0,
    });
    expect(await service().notifyNewDecisions()).toBe(0);
    expect(acceptancePushMessage([acceptances[0]!, { ...acceptances[0]!, id: "l2", title: "Acme" }], 0, "PSH").title).toBe("2 clients accepted");
  });

  it("finds clients who accepted in the last half hour", async () => {
    const pipelineId = randomUUID();
    const stageId = randomUUID();
    const caseId = randomUUID();
    await db.insert(pipelines).values({ id: pipelineId, companyId, key: "accept", name: "Accept", requiresOrganisation: true });
    await db.insert(pipelineStages).values({ id: stageId, companyId, pipelineId, key: "proposal", name: "Proposal", kind: "working", position: 0 });
    await db.insert(pipelineCases).values({ id: caseId, companyId, pipelineId, stageId, caseKey: "ind", title: "Indago" });
    const expires = new Date(clock.getTime() + 86_400_000);
    await db.insert(clientAcceptanceLinks).values([
      { companyId, caseId, tokenHash: randomUUID(), expiresAt: expires, acceptedAt: new Date(clock.getTime() - 60_000), acceptedName: "Ama" },
      { companyId, caseId, tokenHash: randomUUID(), expiresAt: expires, acceptedAt: new Date(clock.getTime() - 3 * 3_600_000), acceptedName: "Old" },
      { companyId, caseId, tokenHash: randomUUID(), expiresAt: expires },
    ]);
    const spy = pushNotificationService(db, {
      keys: () => keys,
      buildFeed: async () => ({ cards: [], count: 0, assignedTasks: [] }),
      finished: async () => [],
      closedDeals: async () => [],
      preferences: async () => prefs,
      now: () => clock,
      send: async (target, message) => { sent.push({ target, message }); return sendResult; },
    });
    await spy.subscribe(companyId, "john", phone(9));
    await db.delete(pushNotifiedDecisions);
    await spy.notifyNewDecisions();
    expect(sent.map((entry) => entry.message.body)).toEqual(["Indago, accepted by Ama"]);
    await db.delete(pipelines).where(eq(pipelines.id, pipelineId));
  });

  it("summarises several closed deals, counting won and lost", () => {
    expect(closedDealPushMessage([
      { id: "a", pipelineId: "p1", title: "One", terminalKind: "done" },
      { id: "b", pipelineId: "p1", title: "Two", terminalKind: "cancelled" },
    ], 2, "PSH")).toEqual({ title: "2 deals closed: 1 won, 1 lost", body: "One and 1 more", url: "/PSH/pipelines/p1", tag: "closed-deals", badge: 2 });
    expect(closedDealPushMessage([{ id: "c", pipelineId: "p1", title: "Three", terminalKind: "cancelled" }], 0, "PSH").title).toBe("Deal lost");
  });

  it("finds tasks the user created that someone else finished in the last half hour", async () => {
    const real = () => pushNotificationService(db, {
      keys: () => keys,
      buildFeed: async () => ({ cards: [], count: 0, assignedTasks: [] }),
      preferences: async () => prefs,
      now: () => clock,
      send: async (target, message) => {
        sent.push({ target, message });
        return sendResult;
      },
    });
    await real().subscribe(companyId, "john", phone(1));
    const minutesAgo = (n: number) => new Date(clock.getTime() - n * 60 * 1000);
    await db.insert(issues).values([
      { companyId, title: "Agent finished this", status: "done", createdByUserId: "john", completedAt: minutesAgo(5) },
      { companyId, title: "John finished it himself", status: "done", createdByUserId: "john", assigneeUserId: "john", completedAt: minutesAgo(5) },
      { companyId, title: "Someone else asked", status: "done", createdByUserId: "ben", completedAt: minutesAgo(5) },
      { companyId, title: "Long ago", status: "done", createdByUserId: "john", completedAt: minutesAgo(90) },
      { companyId, title: "Still open", status: "in_progress", createdByUserId: "john" },
    ]);
    expect(await real().notifyNewDecisions()).toBe(1);
    expect(sent.map((item) => item.message.body)).toEqual(["Agent finished this"]);
    await db.delete(issues);
  });

  it("never sends finished work from before notifications were turned on, nor when switched off", async () => {
    finishedTasks = [{ id: "i1", identifier: "PSH-1", title: "Old work" }];
    await service().subscribe(companyId, "john", phone(1));
    expect(await service().notifyNewDecisions()).toBe(0);
    prefs = { ...prefs, finishedWork: false };
    finishedTasks = [...finishedTasks, { id: "i2", identifier: "PSH-2", title: "New work" }];
    expect(await service().notifyNewDecisions()).toBe(0);
    expect(sent).toEqual([]);
  });

  it("never sends the tasks already assigned when notifications are turned on", async () => {
    assignedTasks = [{ id: "i1", title: "Old task" }];
    await service().subscribe(companyId, "john", phone(1));
    expect(await service().notifyNewDecisions()).toBe(0);
  });

  it("stays silent on a topic switched off, and switching it back on sends no backlog", async () => {
    await service().subscribe(companyId, "john", phone(1));
    prefs = { ...prefs, decisions: false, assignedTasks: false };
    feedCards = [card("task:a")];
    assignedTasks = [{ id: "i1", title: "A task" }];
    expect(await service().notifyNewDecisions()).toBe(0);
    prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES };
    expect(await service().notifyNewDecisions()).toBe(0);
    expect(sent).toEqual([]);
  });

  it("holds everything during quiet hours and sends it once they end", async () => {
    await service().subscribe(companyId, "john", phone(1));
    prefs = { ...prefs, quietHoursStart: 22, quietHoursEnd: 7, timeZone: "Europe/London" };
    clock = new Date("2026-10-16T23:30:00Z"); // 00:30 in London (BST)
    feedCards = [card("task:a", "Approve the budget")];
    expect(await service().notifyNewDecisions()).toBe(0);
    clock = new Date("2026-10-17T06:30:00Z"); // 07:30 in London
    expect(await service().notifyNewDecisions()).toBe(1);
    expect(sent[0]!.message.body).toBe("Approve the budget");
  });

  it("skips team chat pushes when team chat is off or it is quiet hours", async () => {
    await service().subscribe(companyId, "john", phone(1));
    const message = { title: "Ben", body: "Hello", url: "/PSH/chat", tag: "chat" };
    prefs = { ...prefs, teamChat: false };
    expect(await service().sendToUser(companyId, "john", message)).toEqual({ targets: 0, delivered: 0 });
    prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES, quietHoursStart: 9, quietHoursEnd: 17, timeZone: "UTC" };
    expect(await service().sendToUser(companyId, "john", message)).toEqual({ targets: 0, delivered: 0 });
    prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES };
    expect((await service().sendToUser(companyId, "john", message)).delivered).toBe(1);
  });

  it("summarises several finished tasks into one notification for Today", () => {
    const message = finishedTaskPushMessage(
      [{ id: "a", identifier: "PSH-1", title: "One" }, { id: "b", identifier: null, title: "Two" }],
      3,
      "PSH",
    );
    expect(message).toEqual({ title: "2 tasks you asked for are done", body: "One and 1 more", url: "/PSH/today", tag: "finished-tasks", badge: 3 });
  });

  it("summarises several tasks given at once", () => {
    expect(assignedTaskPushMessage([{ id: "a", title: "One" }, { id: "b", title: "Two" }], 3, "GRE")).toEqual({
      title: "2 tasks were given to you",
      body: "One and 1 more",
      url: "/GRE/inbox/mine",
      tag: "assigned-tasks",
      badge: 3,
    });
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
