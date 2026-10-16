import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  companyMemberships,
  heartbeatRuns,
  issueComments,
  issueParticipants,
  issueReadStates,
  issues,
} from "@greatstone/db";
import { TEAM_CHAT_ORIGIN_KIND, type TeamChatSummary } from "@greatstone/shared";
import { beforeEach, expect, it, vi } from "vitest";

// Wakes are recorded instead of run: the comment route queues them after it answers.
const wakes = vi.hoisted(() => [] as Array<{ agentId: string; reason?: string }>);
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => {
      const real = actual.heartbeatService(...args);
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "wakeup") {
            return async (agentId: string, wakeup?: { reason?: string }) => {
              wakes.push({ agentId, reason: wakeup?.reason });
              return null;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

const { errorHandler } = await import("../middleware/index.js");
const { issueRoutes } = await import("../routes/issues.js");
const { teamChatRoutes } = await import("../routes/team-chats.js");
const { buildPaperclipTaskMarkdown } = await import("../services/heartbeat.js");
const { instanceSettingsService } = await import("../services/instance-settings.js");
const { issueService } = await import("../services/issues.js");
const { TEAM_CHAT_DIRECTIVE, teamChatService } = await import("../services/team-chats.js");
const {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} = await import("./helpers/route-test-harness.js");
type BoardActor = import("./helpers/route-test-harness.js").BoardActor;

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

describeEmbeddedPostgres("team chats", () => {
  const ctx = useEmbeddedPostgres("gsam-team-chats-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(issueReadStates);
      await db.delete(issueParticipants);
      await db.delete(issueComments);
      await db.delete(agentWakeupRequests);
      await db.delete(issues);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  beforeEach(async () => {
    wakes.length = 0;
    await instanceSettingsService(ctx.db).updateExperimental({ enableTeamChat: true });
  });

  async function ensureUser(userId: string) {
    await ctx.db
      .insert(authUsers)
      .values({ id: userId, name: userId, email: `${userId}@test.local`, createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
  }

  async function addPerson(companyId: string, name: string, role = "operator") {
    const userId = `user-${name}-${randomUUID().slice(0, 6)}`;
    await ensureUser(userId);
    await ctx.db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role, updatedAt: new Date(),
    });
    const actor: BoardActor = {
      type: "board", source: "session", userId, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }], isInstanceAdmin: false,
    };
    return { userId, actor };
  }

  async function addAgent(companyId: string, name: string, status = "idle") {
    const [agent] = await ctx.db
      .insert(agents)
      .values({ companyId, name, role: "general", status, adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    return agent!;
  }

  const app = (actor: BoardActor) => routeApp(ctx.db, actor, teamChatRoutes as never, issueRoutes);

  function agentApp(companyId: string, agentId: string, runId: string, viewerUserId: string) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent", agentId, companyId, runId, source: "agent_jwt",
        onBehalfOfUserId: viewerUserId,
        onBehalfOfMemberships: [{ companyId, membershipRole: "operator", status: "active" }],
      };
      next();
    });
    server.use("/api", issueRoutes(ctx.db, {} as never));
    server.use(errorHandler);
    return server;
  }

  async function runFor(companyId: string, agentId: string, issueId: string) {
    const [run] = await ctx.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "running", contextSnapshot: { issueId } })
      .returning();
    return run!;
  }

  /** An owner, Alice and Carol in a group with agents A and B; Bob and agent C are outside it. */
  async function seed() {
    const { companyId, actor: owner, userId: ownerId } = await seedCompanyWithBoardAccess(ctx.db, "TeamChat");
    await ensureUser(ownerId);
    const alice = await addPerson(companyId, "alice");
    const carol = await addPerson(companyId, "carol");
    const bob = await addPerson(companyId, "bob");
    const a = await addAgent(companyId, "Atlas");
    const b = await addAgent(companyId, "Beacon");
    const c = await addAgent(companyId, "Comet");
    const created = await request(app(alice.actor))
      .post(`/api/companies/${companyId}/team-chats`)
      .send({ title: "Launch", userIds: [carol.userId], agentIds: [a.id, b.id] });
    expect(created.status).toBe(201);
    const chat = created.body as TeamChatSummary;
    return { companyId, owner, alice, carol, bob, a, b, c, chat };
  }

  const say = (actor: BoardActor, chatId: string, body: string) =>
    request(app(actor)).post(`/api/issues/${chatId}/comments`).send({ body });
  const mention = (agent: { id: string; name: string }) => `[@${agent.name}](agent://${agent.id})`;

  it("lets members in and keeps everyone else out", async () => {
    const { companyId, owner, alice, carol, bob, chat } = await seed();
    expect(chat.kind).toBe("group");
    expect(chat.members.map((m) => m.type).sort()).toEqual(["agent", "agent", "user", "user"]);

    expect((await request(app(carol.actor)).get(`/api/issues/${chat.id}`)).status).toBe(200);
    expect((await say(carol.actor, chat.id, "hi all")).status).toBe(201);

    expect((await request(app(bob.actor)).get(`/api/issues/${chat.id}`)).status).toBe(404);
    expect((await request(app(bob.actor)).get(`/api/issues/${chat.id}/comments`)).status).toBe(404);
    expect((await say(bob.actor, chat.id, "let me in")).status).toBe(404);
    expect((await request(app(bob.actor)).get(`/api/team-chats/${chat.id}`)).status).toBe(404);
    expect((await request(app(bob.actor)).get(`/api/companies/${companyId}/team-chats`)).body).toEqual([]);

    // Owners can open it to moderate.
    expect((await request(app(owner)).get(`/api/issues/${chat.id}/comments`)).status).toBe(200);

    // A chat takes messages only.
    expect((await request(app(alice.actor)).patch(`/api/issues/${chat.id}`).send({ status: "done" })).status).toBe(422);

    // Members must belong to the company; agents must be live.
    const stranger = await request(app(alice.actor))
      .post(`/api/companies/${companyId}/team-chats`)
      .send({ title: "Nope", userIds: ["user-not-here"] });
    expect(stranger.status).toBe(422);
    const gone = await addAgent(companyId, "Retired", "terminated");
    const retired = await request(app(alice.actor))
      .post(`/api/companies/${companyId}/team-chats`)
      .send({ title: "Nope", agentIds: [gone.id] });
    expect(retired.status).toBe(422);
  });

  it("reuses the one direct message between two people", async () => {
    const { companyId, alice, carol } = await seed();
    const first = await request(app(alice.actor)).post(`/api/companies/${companyId}/team-chats/direct`).send({ userId: carol.userId });
    expect(first.status).toBe(201);
    expect(first.body.kind).toBe("direct");
    const again = await request(app(alice.actor)).post(`/api/companies/${companyId}/team-chats/direct`).send({ userId: carol.userId });
    const reverse = await request(app(carol.actor)).post(`/api/companies/${companyId}/team-chats/direct`).send({ userId: alice.userId });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(reverse.body.id).toBe(first.body.id);
    const add = await request(app(alice.actor)).post(`/api/team-chats/${first.body.id}/members`).send({ userIds: [] });
    expect(add.status).toBe(422);
  });

  it("wakes nobody without a mention, and only the mentioned member agent with one", async () => {
    const { alice, a, b, c, chat } = await seed();
    expect((await say(alice.actor, chat.id, "morning, no asks")).status).toBe(201);
    await settle();
    expect(wakes).toEqual([]);

    expect((await say(alice.actor, chat.id, `${mention(a)} can you check the launch date?`)).status).toBe(201);
    await vi.waitFor(() => expect(wakes).toEqual([{ agentId: a.id, reason: "issue_comment_mentioned" }]));
    await settle();
    expect(wakes.some((wake) => wake.agentId === b.id)).toBe(false);

    // A mention of an agent outside the chat wakes nobody and leaves a note.
    wakes.length = 0;
    expect((await say(alice.actor, chat.id, `${mention(c)} are you there?`)).status).toBe(201);
    await settle();
    expect(wakes).toEqual([]);
    const notes = await ctx.db.select().from(issueComments).where(and(eq(issueComments.issueId, chat.id), eq(issueComments.authorType, "system")));
    expect(notes.map((n) => n.body).join("\n")).toContain("Comet is not in this chat");
  });

  it("stops agent-to-agent mentions after three hops until a person speaks", async () => {
    const { companyId, alice, a, b, chat } = await seed();
    const runA = await runFor(companyId, a.id, chat.id);
    const runB = await runFor(companyId, b.id, chat.id);
    const fromA = (body: string) => request(agentApp(companyId, a.id, runA.id, alice.userId)).post(`/api/issues/${chat.id}/comments`).send({ body });
    const fromB = (body: string) => request(agentApp(companyId, b.id, runB.id, alice.userId)).post(`/api/issues/${chat.id}/comments`).send({ body });

    expect((await say(alice.actor, chat.id, `${mention(a)} plan the launch with Beacon`)).status).toBe(201);
    await vi.waitFor(() => expect(wakes.map((w) => w.agentId)).toEqual([a.id]));

    for (const [post, target, hop] of [[fromA, b, 1], [fromB, a, 2], [fromA, b, 3]] as const) {
      wakes.length = 0;
      const res = await post(`${mention(target)} hop ${hop}`);
      expect(res.status).toBe(201);
      await vi.waitFor(() => expect(wakes.map((w) => w.agentId)).toEqual([target.id]));
    }

    wakes.length = 0;
    expect((await fromB(`${mention(a)} hop 4`)).status).toBe(201);
    await settle();
    expect(wakes).toEqual([]);
    const notes = await ctx.db.select().from(issueComments).where(and(eq(issueComments.issueId, chat.id), eq(issueComments.authorType, "system")));
    expect(notes.some((n) => n.body.includes("3 times in a row"))).toBe(true);

    // A person speaking resets the count.
    expect((await say(alice.actor, chat.id, `${mention(a)} carry on`)).status).toBe(201);
    await vi.waitFor(() => expect(wakes.map((w) => w.agentId)).toEqual([a.id]));
    wakes.length = 0;
    expect((await fromA(`${mention(b)} one more`)).status).toBe(201);
    await vi.waitFor(() => expect(wakes.map((w) => w.agentId)).toEqual([b.id]));
  });

  it("keeps team chats out of task lists and inbox counts, and counts unread per chat", async () => {
    const { companyId, alice, carol, chat } = await seed();
    await say(carol.actor, chat.id, "news for Alice");
    const svc = issueService(ctx.db);
    const listed = await request(app(alice.actor)).get(`/api/companies/${companyId}/issues`);
    expect(listed.status).toBe(200);
    expect(listed.body.map((issue: { id: string }) => issue.id)).not.toContain(chat.id);
    const touched = await svc.list(companyId, { touchedByUserId: carol.userId });
    expect(touched.map((issue) => issue.id)).not.toContain(chat.id);
    expect(await svc.countUnreadTouchedByUser(companyId, carol.userId)).toBe(0);
    const [row] = await ctx.db.select({ originKind: issues.originKind, assignee: issues.assigneeAgentId }).from(issues).where(eq(issues.id, chat.id));
    expect(row).toEqual({ originKind: TEAM_CHAT_ORIGIN_KIND, assignee: null });

    const mine = await request(app(alice.actor)).get(`/api/companies/${companyId}/team-chats`);
    expect(mine.body.find((c: TeamChatSummary) => c.id === chat.id).unreadCount).toBe(1);
    await request(app(alice.actor)).post(`/api/issues/${chat.id}/read`).send({});
    const after = await request(app(alice.actor)).get(`/api/companies/${companyId}/team-chats`);
    expect(after.body.find((c: TeamChatSummary) => c.id === chat.id).unreadCount).toBe(0);
  });

  it("pushes DMs and @mentions to the person, at most once per chat per window", async () => {
    const { companyId, alice, carol, bob } = await seed();
    const sendToUser = vi.fn(async () => ({ targets: 1, delivered: 1 }));
    let clock = 1_000_000;
    const chats = teamChatService(ctx.db, { push: { sendToUser }, now: () => clock });
    const dm = await chats.ensureDirect(companyId, alice.userId, carol.userId);
    const dmIssue = (await ctx.db.select().from(issues).where(eq(issues.id, dm.chat.id)))[0]!;

    await chats.notifyPeople(dmIssue, { body: "lunch?" }, { type: "user", id: alice.userId });
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect(sendToUser).toHaveBeenCalledWith(companyId, carol.userId, expect.objectContaining({ body: "lunch?", tag: `chat:${dm.chat.id}` }));

    await chats.notifyPeople(dmIssue, { body: "still there?" }, { type: "user", id: alice.userId });
    expect(sendToUser).toHaveBeenCalledTimes(1);
    clock += 3 * 60_000;
    await chats.notifyPeople(dmIssue, { body: "ok later" }, { type: "user", id: alice.userId });
    expect(sendToUser).toHaveBeenCalledTimes(2);

    // An @mention on an ordinary task pushes and puts the task in the inbox.
    const svc = issueService(ctx.db);
    const task = await svc.create(companyId, { title: "Ordinary task", status: "todo", createdByUserId: alice.userId });
    const body = `[@bob](user://${bob.userId}) please review`;
    await svc.addComment(task.id, body, { userId: alice.userId });
    await chats.notifyPeople(task, { body }, { type: "user", id: alice.userId });
    expect(sendToUser).toHaveBeenLastCalledWith(companyId, bob.userId, expect.objectContaining({ title: expect.stringContaining("mentioned you") }));
    const inbox = await svc.list(companyId, { touchedByUserId: bob.userId });
    expect(inbox.map((issue) => issue.id)).toContain(task.id);
  });

  it("pushes every group message to the other people, minus the author and those who muted it, unless mentioned", async () => {
    const { companyId, alice, carol, chat } = await seed();
    const sendToUser = vi.fn(async () => ({ targets: 1, delivered: 1 }));
    let clock = 1_000_000;
    const chats = teamChatService(ctx.db, { push: { sendToUser }, now: () => clock });
    const issue = (await ctx.db.select().from(issues).where(eq(issues.id, chat.id)))[0]!;

    await chats.notifyPeople(issue, { id: "c-1", body: "standup in 5" }, { type: "user", id: alice.userId });
    expect(sendToUser.mock.calls.map((call) => call[1])).toEqual([carol.userId]);
    expect(sendToUser).toHaveBeenLastCalledWith(companyId, carol.userId, expect.objectContaining({
      title: `${alice.userId} in Launch`,
      url: expect.stringMatching(new RegExp(`/messages/${chat.id}#comment-c-1$`)),
    }));

    // Carol mutes the chat through the route: plain messages stop, mentions still reach her.
    const muted = await request(app(carol.actor)).put(`/api/team-chats/${chat.id}/mute`).send({ muted: true });
    expect(muted.status).toBe(200);
    expect((muted.body as TeamChatSummary).muted).toBe(true);
    expect(((await request(app(alice.actor)).get(`/api/team-chats/${chat.id}`)).body as TeamChatSummary).muted).toBe(false);
    sendToUser.mockClear();
    clock += 3 * 60_000;
    await chats.notifyPeople(issue, { body: "anyone?" }, { type: "user", id: alice.userId });
    expect(sendToUser).not.toHaveBeenCalled();
    await chats.notifyPeople(issue, { body: `[@carol](user://${carol.userId}) you?` }, { type: "user", id: alice.userId });
    expect(sendToUser).toHaveBeenCalledWith(companyId, carol.userId, expect.objectContaining({ title: `${alice.userId} mentioned you in Launch` }));

    // Unmuting brings plain messages back; muting is for members only.
    await request(app(carol.actor)).put(`/api/team-chats/${chat.id}/mute`).send({ muted: false });
    sendToUser.mockClear();
    clock += 3 * 60_000;
    await chats.notifyPeople(issue, { body: "back on" }, { type: "user", id: alice.userId });
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect((await request(app(alice.actor)).put(`/api/team-chats/${chat.id}/mute`).send({ muted: "yes" })).status).toBe(400);
  });

  it("flags team chat messages in the activity feed without their words", async () => {
    const { alice, chat } = await seed();
    await say(alice.actor, chat.id, "secret plans");
    const [row] = await ctx.db.select().from(activityLog).where(and(eq(activityLog.entityId, chat.id), eq(activityLog.action, "issue.comment_added")));
    expect(row?.details).toMatchObject({ teamChat: true });
    expect(JSON.stringify(row?.details)).not.toContain("secret plans");
  });

  it("gives a woken agent the directive and the recent thread", async () => {
    const { alice, a, chat } = await seed();
    await say(alice.actor, chat.id, `${mention(a)} what is the launch date?`);
    const transcript = await teamChatService(ctx.db).transcript(chat.id);
    expect(transcript).toContain("what is the launch date?");
    expect(transcript).toContain(`agent://${a.id}`);
    const markdown = buildPaperclipTaskMarkdown({
      issue: { id: chat.id, identifier: chat.identifier, title: chat.title },
      teamChatContext: transcript,
    });
    expect(markdown).toContain(TEAM_CHAT_DIRECTIVE);
    expect(markdown).toContain("what is the launch date?");
  });

  it("migration: the participants table refuses an unknown member type", async () => {
    const { companyId, chat } = await seed();
    await expect(
      ctx.db.insert(issueParticipants).values({ companyId, issueId: chat.id, principalType: "robot" as never, principalId: "x" }),
    ).rejects.toThrow();
  });

  it("answers 403 not_entitled with the switch off", async () => {
    const { companyId, alice } = await seed();
    await instanceSettingsService(ctx.db).updateExperimental({ enableTeamChat: false });
    const res = await request(app(alice.actor)).get(`/api/companies/${companyId}/team-chats`);
    expect(res.status).toBe(403);
  });
});
