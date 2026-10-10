import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  chatConversations,
  chatEndpoints,
  chatPublications,
  companyMemberships,
  emailMessages,
  goalCheckIns,
  goalKpiAlerts,
  goalKpiReadings,
  goals,
  goalWhyRequests,
  issueComments,
  issues,
  principalPermissionGrants,
  strategyBoardEmails,
  strategyBoardPacks,
  strategyBoardSettings,
  toolApplications,
  toolConnections,
} from "@greatstone/db";
import type { EmailSendInput, StrategyBoardSettings } from "@greatstone/shared";
import { beforeEach, expect, it } from "vitest";
import { goalRoutes } from "../routes/goals.js";
import { strategyBoardRoutes } from "../routes/strategy-board.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import {
  BOARD_EMAIL_MAX_ATTEMPTS,
  meetingReminderDue,
  parseReadingLines,
  replyBody,
  runScheduledStrategyBoardEmails,
  storeBoardEmailReply,
} from "../services/strategy-board-email.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
const TODAY = dayOffset(0);

/** Records what the board asked the email service to send. */
function fakeSender(opts: { failTimes?: number } = {}) {
  const sent: Array<{ companyId: string; input: EmailSendInput }> = [];
  let failures = opts.failTimes ?? 0;
  return {
    sent,
    async queueBoardSend(companyId: string, input: EmailSendInput) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("This email inbox is not active");
      }
      sent.push({ companyId, input });
      return { id: input.idempotencyKey, issueId: randomUUID(), conversationId: randomUUID(), outcome: "queued", error: null, providerMessageId: null };
    },
  };
}

describeEmbeddedPostgres("board email (GRE-1187)", () => {
  const ctx = useEmbeddedPostgres("gsam-strategy-board-email-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(emailMessages);
      await db.delete(chatPublications);
      await db.delete(chatConversations);
      await db.delete(strategyBoardEmails);
      await db.delete(strategyBoardSettings);
      await db.delete(strategyBoardPacks);
      await db.delete(goalKpiAlerts);
      await db.delete(goalWhyRequests);
      await db.delete(goalKpiReadings);
      await db.delete(goalCheckIns);
      await db.delete(issueComments);
      await db.delete(issues);
      await db.update(goals).set({ parentId: null });
      await db.delete(goals);
      await db.delete(chatEndpoints);
      await db.delete(toolConnections);
      await db.delete(toolApplications);
      await db.delete(agents);
      await db.delete(principalPermissionGrants);
      await db.delete(authUsers);
      await resetCompanyIssueFixtures(db);
    },
  });

  beforeEach(async () => {
    const settings = instanceSettingsService(ctx.db);
    await settings.updateExperimental({ enableStrategyBoard: true, enableChatConnectors: true });
    await settings.updateGeneral({ strategyBoardEmail: { meetingReminders: true, slippageAlerts: true, whyRequests: true } });
  });

  async function addPerson(companyId: string, role: "owner" | "admin" | "operator" | "viewer", name: string, email: string | null = `${name}@example.test`) {
    const userId = `user-${name}-${randomUUID().slice(0, 6)}`;
    await ctx.db.insert(authUsers).values({ id: userId, name, email: email ?? `${userId}@placeholder.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    if (email === null) await ctx.db.update(authUsers).set({ email: "" }).where(eq(authUsers.id, userId));
    await ctx.db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role, updatedAt: new Date() });
    const actor: BoardActor = {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
      isInstanceAdmin: false,
    };
    return { userId, actor, email };
  }

  async function seedSecretaryInbox(companyId: string, status: "active" | "paused" = "active") {
    const [agent] = await ctx.db
      .insert(agents)
      .values({ companyId, name: "Board secretary", role: "general", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    const [application] = await ctx.db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `agentmail-${randomUUID()}`, name: "AgentMail", type: "mcp", status: "active" })
      .returning();
    const [connection] = await ctx.db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name: "Board mail",
        uid: `board-mail-${randomUUID()}`,
        connectionKind: "managed",
        ownership: "customer",
        transport: "mcp_remote",
        authKind: "oauth",
        credentialPolicy: "per_user",
        status: "active",
        enabled: true,
      })
      .returning();
    const [endpoint] = await ctx.db
      .insert(chatEndpoints)
      .values({
        companyId,
        connectionId: connection.id,
        provider: "agentmail",
        publicId: randomUUID(),
        publicationMode: "explicit",
        externalExecutionPolicy: "agent",
        assignedAgentId: agent.id,
        status,
        botExternalId: `secretary-${randomUUID().slice(0, 6)}@agentmail.test`,
      })
      .returning();
    return endpoint;
  }

  /** Revenue 100 → 200 over 200 days, so the plan today is 150; 100 is red. */
  async function seedKpi(companyId: string, title: string, owner: { ownerUserId?: string; ownerAgentId?: string }) {
    const [kpi] = await ctx.db
      .insert(goals)
      .values({
        companyId,
        title,
        kind: "kpi",
        level: "task",
        status: "active",
        unit: "k",
        baselineValue: 100,
        baselineDate: dayOffset(-100),
        targetValue: 200,
        targetDate: dayOffset(100),
        ...owner,
      })
      .returning();
    return kpi;
  }

  function app(actor: BoardActor) {
    return routeApp(ctx.db, actor, goalRoutes, strategyBoardRoutes);
  }

  async function postReading(actor: BoardActor, goalId: string, value: number) {
    const res = await request(app(actor)).post(`/api/goals/${goalId}/readings`).send({ value, readingDate: TODAY });
    expect(res.status).toBe(201);
  }

  async function configure(owner: BoardActor, companyId: string, body: Record<string, unknown>) {
    const res = await request(app(owner)).patch(`/api/companies/${companyId}/strategy-board/settings`).send(body);
    expect(res.status).toBe(200);
    return res.body as StrategyBoardSettings;
  }

  async function sweep(sender: ReturnType<typeof fakeSender>) {
    return runScheduledStrategyBoardEmails(ctx.db, { sender, force: true, publicBaseUrl: "https://board.example.test" });
  }

  async function seedBoardWithChair(name: string) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    const chair = await addPerson(seeded.companyId, "viewer", "chair");
    const members = await request(app(seeded.actor))
      .put(`/api/companies/${seeded.companyId}/strategy-board/members`)
      .send({ members: [{ userId: chair.userId, chair: true }] });
    expect(members.status).toBe(200);
    const inbox = await seedSecretaryInbox(seeded.companyId);
    await configure(seeded.actor, seeded.companyId, { secretaryEndpointId: inbox.id });
    return { ...seeded, chair, inbox };
  }

  // ---- Slippage alerts to the chair ----

  it("emails the chair once per red spell, not again while it stays red, and again after it recovers", async () => {
    const { companyId, actor: owner, chair, inbox } = await seedBoardWithChair("Slip");
    const kpi = await seedKpi(companyId, "Revenue", { ownerUserId: (await addPerson(companyId, "operator", "ama")).userId });
    const sender = fakeSender();

    await postReading(owner, kpi.id, 100);
    await sweep(sender);
    expect(sender.sent).toHaveLength(1);
    const [alert] = await ctx.db.select().from(goalKpiAlerts).where(eq(goalKpiAlerts.goalId, kpi.id));
    expect(sender.sent[0]).toMatchObject({
      companyId,
      input: { endpointId: inbox.id, to: [chair.email], subject: "KPI turned red: Revenue", parentIssueId: alert.alertIssueId },
    });
    expect(sender.sent[0].input.text).toContain(`${alert.gapPercent}% behind plan: 100 k against a plan of 150 k`);
    expect(sender.sent[0].input.text).toContain(`https://board.example.test/`);

    // Still red: a new reading and two more sweeps send nothing.
    await postReading(owner, kpi.id, 105);
    await sweep(sender);
    await sweep(sender);
    expect(sender.sent).toHaveLength(1);

    // Recovers, then red again: a new spell, one more email.
    await postReading(owner, kpi.id, 150);
    await sweep(sender);
    expect(sender.sent).toHaveLength(1);
    await postReading(owner, kpi.id, 100);
    await sweep(sender);
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1].input.to).toEqual([chair.email]);

    const log = await request(app(owner)).get(`/api/companies/${companyId}/strategy-board/emails`);
    expect(log.status).toBe(200);
    expect(log.body).toHaveLength(2);
    expect(log.body.every((row: { kind: string; status: string }) => row.kind === "slippage_alert" && row.status === "queued")).toBe(true);
  });

  // ---- "Why?" requests to the owner ----

  it("emails a \"Why?\" request to the KPI owner once, and never to an agent owner", async () => {
    const { companyId, chair } = await seedBoardWithChair("Why");
    const ama = await addPerson(companyId, "operator", "ama");
    const agentOwned = await seedKpi(companyId, "Margin", {
      ownerAgentId: (await ctx.db.select().from(agents).where(eq(agents.companyId, companyId)))[0].id,
    });
    const kpi = await seedKpi(companyId, "Revenue", { ownerUserId: ama.userId });
    const asked = await request(app(chair.actor)).post(`/api/goals/${kpi.id}/why-requests`).send({ question: "Why is revenue behind?\nWhat now?" });
    expect(asked.status).toBe(201);
    expect((await request(app(chair.actor)).post(`/api/goals/${agentOwned.id}/why-requests`).send({ question: "And margin?" })).status).toBe(201);
    const sender = fakeSender({});
    await sweep(sender);
    const whyEmails = sender.sent.filter((s) => s.input.subject?.startsWith("The board asks why"));
    expect(whyEmails).toHaveLength(1);
    expect(whyEmails[0].input).toMatchObject({ to: [ama.email], subject: "The board asks why: Revenue", parentIssueId: asked.body.ownerIssueId });
    expect(whyEmails[0].input.text).toContain("> Why is revenue behind?\n> What now?");
    await sweep(sender);
    expect(sender.sent.filter((s) => s.input.subject?.startsWith("The board asks why"))).toHaveLength(1);
  });

  // ---- Meeting reminders to owners ----

  it("reminds each owner once before the board meeting, with reply codes for their KPIs and the actions due", async () => {
    const { companyId, actor: owner } = await seedBoardWithChair("Meet");
    const ama = await addPerson(companyId, "operator", "ama");
    const kofi = await addPerson(companyId, "operator", "kofi");
    const revenue = await seedKpi(companyId, "Revenue", { ownerUserId: ama.userId });
    const clients = await seedKpi(companyId, "Clients", { ownerUserId: ama.userId });
    await seedKpi(companyId, "Uptime", { ownerUserId: kofi.userId });
    await seedKpi(companyId, "Margin", { ownerAgentId: (await ctx.db.select().from(agents).where(eq(agents.companyId, companyId)))[0].id });
    await ctx.db.insert(goals).values([
      { companyId, title: "Open Accra office", kind: "initiative", level: "team", status: "active", ownerUserId: ama.userId, targetDate: dayOffset(3) },
      { companyId, title: "Next year's launch", kind: "initiative", level: "team", status: "active", ownerUserId: ama.userId, targetDate: dayOffset(200) },
    ]);
    const sender = fakeSender();

    // Ten days out with a seven-day lead: not yet.
    await configure(owner, companyId, { nextMeetingDate: dayOffset(10), reminderLeadDays: 7 });
    await sweep(sender);
    expect(sender.sent).toHaveLength(0);

    // Five days out: one reminder to each person who owns live work.
    await configure(owner, companyId, { nextMeetingDate: dayOffset(5) });
    await sweep(sender);
    const reminders = sender.sent.filter((s) => s.input.subject === `Board meeting on ${dayOffset(5)}: your readings and actions`);
    expect(reminders.map((r) => r.input.to?.[0]).sort()).toEqual([ama.email, kofi.email].sort());
    const toAma = reminders.find((r) => r.input.to?.[0] === ama.email)!.input.text;
    expect(toAma).toContain("- K1 Clients: no reading yet.");
    expect(toAma).toContain("- K2 Revenue: no reading yet.");
    expect(toAma).toContain(`- Open Accra office (due ${dayOffset(3)})`);
    expect(toAma).not.toContain("Next year's launch");
    expect(toAma).not.toContain("Uptime");
    const [logged] = await ctx.db
      .select()
      .from(strategyBoardEmails)
      .where(and(eq(strategyBoardEmails.companyId, companyId), eq(strategyBoardEmails.recipientUserId, ama.userId)));
    expect(logged).toMatchObject({ kind: "meeting_reminder", meetingDate: dayOffset(5), kpiCodes: { K1: clients.id, K2: revenue.id } });
    // All reminders sit under one record task for the meeting.
    expect(new Set(reminders.map((r) => r.input.parentIssueId)).size).toBe(1);

    // Later sweeps before the meeting: nothing new. A new meeting date: new reminders.
    await sweep(sender);
    expect(sender.sent).toHaveLength(2);
    await configure(owner, companyId, { nextMeetingDate: dayOffset(6) });
    await sweep(sender);
    expect(sender.sent).toHaveLength(4);
  });

  it("works out the reminder window from the meeting date and the lead days", () => {
    expect(meetingReminderDue("2026-10-03", "2026-10-10", 7)).toBe(true);
    expect(meetingReminderDue("2026-10-02", "2026-10-10", 7)).toBe(false);
    expect(meetingReminderDue("2026-10-10", "2026-10-10", 7)).toBe(true);
    expect(meetingReminderDue("2026-10-11", "2026-10-10", 7)).toBe(false);
    expect(meetingReminderDue("2026-10-10", null, 7)).toBe(false);
  });

  // ---- When nothing is sent ----

  it("sends nothing while enableStrategyBoard is off, for a kind turned off, or with no secretary inbox", async () => {
    const { companyId, actor: owner } = await seedBoardWithChair("Off");
    const ama = await addPerson(companyId, "operator", "ama");
    const kpi = await seedKpi(companyId, "Revenue", { ownerUserId: ama.userId });
    await configure(owner, companyId, { nextMeetingDate: dayOffset(2) });
    await postReading(owner, kpi.id, 100);
    const sender = fakeSender();

    await instanceSettingsService(ctx.db).updateExperimental({ enableStrategyBoard: false });
    expect((await sweep(sender)).size).toBe(0);
    expect(sender.sent).toHaveLength(0);
    await instanceSettingsService(ctx.db).updateExperimental({ enableStrategyBoard: true });

    // Slippage alerts off: only the meeting reminder goes.
    await instanceSettingsService(ctx.db).updateGeneral({ strategyBoardEmail: { meetingReminders: true, slippageAlerts: false, whyRequests: true } });
    await sweep(sender);
    expect(sender.sent.map((s) => s.input.subject)).toEqual([`Board meeting on ${dayOffset(2)}: your readings and actions`]);

    // No secretary inbox: nothing, even with every kind on.
    await instanceSettingsService(ctx.db).updateGeneral({ strategyBoardEmail: { meetingReminders: true, slippageAlerts: true, whyRequests: true } });
    await configure(owner, companyId, { secretaryEndpointId: null });
    await sweep(sender);
    expect(sender.sent).toHaveLength(1);
  });

  it("skips a paused secretary inbox and a person with no email address", async () => {
    const { companyId, actor: owner, inbox } = await seedBoardWithChair("Paused");
    const noEmail = await addPerson(companyId, "operator", "ghost", null);
    await seedKpi(companyId, "Revenue", { ownerUserId: noEmail.userId });
    await configure(owner, companyId, { nextMeetingDate: dayOffset(1) });
    const sender = fakeSender();
    await sweep(sender);
    expect(sender.sent).toHaveLength(0);
    expect(await ctx.db.select().from(strategyBoardEmails).where(eq(strategyBoardEmails.companyId, companyId))).toHaveLength(0);

    const ama = await addPerson(companyId, "operator", "ama");
    await seedKpi(companyId, "Clients", { ownerUserId: ama.userId });
    await ctx.db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, inbox.id));
    const results = await sweep(sender);
    expect(results.get(companyId)).toMatchObject({ skipped: "secretary_inactive" });
    expect(sender.sent).toHaveLength(0);
  });

  it("retries a failed send with the same key, then stops after the last attempt", async () => {
    const { companyId, actor: owner } = await seedBoardWithChair("Retry");
    const ama = await addPerson(companyId, "operator", "ama");
    await seedKpi(companyId, "Revenue", { ownerUserId: ama.userId });
    await configure(owner, companyId, { nextMeetingDate: dayOffset(1) });

    const flaky = fakeSender({ failTimes: 1 });
    await sweep(flaky);
    let [row] = await ctx.db.select().from(strategyBoardEmails).where(eq(strategyBoardEmails.companyId, companyId));
    expect(row).toMatchObject({ status: "failed", attempts: 1, lastError: "This email inbox is not active" });
    await sweep(flaky);
    [row] = await ctx.db.select().from(strategyBoardEmails).where(eq(strategyBoardEmails.companyId, companyId));
    expect(row).toMatchObject({ status: "queued", attempts: 2, publicationId: row.id });
    expect(flaky.sent).toHaveLength(1);
    expect(flaky.sent[0].input.idempotencyKey).toBe(row.id);

    const broken = fakeSender({ failTimes: 99 });
    await ctx.db.delete(strategyBoardEmails);
    for (let i = 0; i < BOARD_EMAIL_MAX_ATTEMPTS + 2; i += 1) await sweep(broken);
    [row] = await ctx.db.select().from(strategyBoardEmails).where(eq(strategyBoardEmails.companyId, companyId));
    expect(row).toMatchObject({ status: "failed", attempts: BOARD_EMAIL_MAX_ATTEMPTS });
  });

  // ---- Who may change the settings ----

  it("lets only company owners change board email settings, and only to the company's own inbox", async () => {
    const { companyId, actor: owner } = await seedCompanyWithBoardAccess(ctx.db, "Perms");
    const admin = await addPerson(companyId, "admin", "admin");
    const viewer = await addPerson(companyId, "viewer", "viewer");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    const otherInbox = await seedSecretaryInbox(other.companyId);
    const inbox = await seedSecretaryInbox(companyId);

    expect((await request(app(admin.actor)).get(`/api/companies/${companyId}/strategy-board/settings`)).status).toBe(200);
    expect((await request(app(viewer.actor)).get(`/api/companies/${companyId}/strategy-board/settings`)).status).toBe(403);
    expect((await request(app(viewer.actor)).get(`/api/companies/${companyId}/strategy-board/emails`)).status).toBe(403);
    expect((await request(app(admin.actor)).patch(`/api/companies/${companyId}/strategy-board/settings`).send({ secretaryEndpointId: inbox.id })).status).toBe(403);
    expect((await request(app(other.actor)).patch(`/api/companies/${companyId}/strategy-board/settings`).send({ secretaryEndpointId: inbox.id })).status).toBe(403);
    const foreign = await request(app(owner)).patch(`/api/companies/${companyId}/strategy-board/settings`).send({ secretaryEndpointId: otherInbox.id });
    expect(foreign.status).toBe(422);
    expect(foreign.body.details?.code ?? foreign.body.code).toBe("board_secretary_inbox_invalid");
    expect((await request(app(owner)).patch(`/api/companies/${companyId}/strategy-board/settings`).send({ reminderLeadDays: 99 })).status).toBe(400);

    const saved = await configure(owner, companyId, { secretaryEndpointId: inbox.id, nextMeetingDate: "2026-12-01" });
    expect(saved).toEqual({ companyId, secretaryEndpointId: inbox.id, nextMeetingDate: "2026-12-01", reminderLeadDays: 7 });

    await instanceSettingsService(ctx.db).updateExperimental({ enableStrategyBoard: false });
    expect((await request(app(owner)).get(`/api/companies/${companyId}/strategy-board/settings`)).status).toBe(403);
    const rows = await ctx.db.select().from(strategyBoardSettings).where(inArray(strategyBoardSettings.companyId, [companyId, other.companyId]));
    expect(rows).toHaveLength(1);
  });

  // ---- Replies stored on the plan (GRE-1196) ----

  /**
   * Stands in for the email service: each board email gets its own task,
   * thread and send, as `queueBoardSend` makes them.
   */
  function threadingSender() {
    const sent: Array<{ companyId: string; input: EmailSendInput; conversationId: string; issueId: string }> = [];
    return {
      sent,
      async queueBoardSend(companyId: string, input: EmailSendInput) {
        const task = await issueService(ctx.db).create(companyId, { title: input.subject!, parentId: input.parentIssueId, status: "done", priority: "medium" });
        const [conversation] = await ctx.db
          .insert(chatConversations)
          .values({ companyId, endpointId: input.endpointId, issueId: task.id, externalConversationId: "secretary", externalThreadId: `thread-${input.idempotencyKey}`, externalLabel: input.subject!, isDirectMessage: true })
          .returning();
        await ctx.db.insert(chatPublications).values({
          id: input.idempotencyKey,
          companyId,
          endpointId: input.endpointId,
          conversationId: conversation.id,
          issueId: task.id,
          idempotencyKey: `email:${input.idempotencyKey}`,
          payload: { text: input.text },
        });
        sent.push({ companyId, input, conversationId: conversation.id, issueId: task.id });
        return { id: input.idempotencyKey, issueId: task.id, conversationId: conversation.id, outcome: "queued", error: null, providerMessageId: null };
      },
    };
  }

  /** An email that came into a board thread, as the email service retains it. */
  async function reply(thread: { companyId: string; input: EmailSendInput; conversationId: string }, from: string, text: string, senderAuthenticated = true) {
    const providerMessageId = `reply-${randomUUID()}`;
    await ctx.db.insert(emailMessages).values({
      companyId: thread.companyId,
      endpointId: thread.input.endpointId,
      conversationId: thread.conversationId,
      providerMessageId,
      envelope: { from, to: ["secretary@agentmail.test"], cc: [], bcc: [], replyTo: [], subject: `Re: ${thread.input.subject}` },
      text,
      direction: "inbound",
      timestamp: new Date(),
    });
    const input = { companyId: thread.companyId, conversationId: thread.conversationId, providerMessageId, senderAuthenticated };
    return { input, result: await storeBoardEmailReply(ctx.db, input) };
  }

  async function threadComments(issueId: string) {
    return (await ctx.db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).map((c) => c.body);
  }

  it("stores the owner's reply to a \"Why?\" email as the answer and closes the owner's task", async () => {
    const { companyId, chair } = await seedBoardWithChair("WhyReply");
    const ama = await addPerson(companyId, "operator", "ama");
    const kpi = await seedKpi(companyId, "Revenue", { ownerUserId: ama.userId });
    const asked = await request(app(chair.actor)).post(`/api/goals/${kpi.id}/why-requests`).send({ question: "Why is revenue behind?" });
    expect(asked.status).toBe(201);
    const sender = threadingSender();
    await sweep(sender);
    const thread = sender.sent.find((s) => s.input.subject === "The board asks why: Revenue")!;

    const { input, result } = await reply(thread, `Ama <${ama.email!.toUpperCase()}>`, "Two clients paid late.\nIt is back on plan in May.\n\nOn Mon, Board secretary wrote:\n> A board member asks you");
    expect(result).toEqual({ stored: "why_answer" });
    const [why] = await ctx.db.select().from(goalWhyRequests).where(eq(goalWhyRequests.id, asked.body.id));
    expect(why).toMatchObject({ status: "answered", answer: "Two clients paid late.\nIt is back on plan in May.", answeredByUserId: ama.userId });
    expect((await issueService(ctx.db).getById(asked.body.ownerIssueId))?.status).toBe("done");
    expect(await threadComments(thread.issueId)).toContain("Stored on the plan: this reply is the answer to the board's \"Why?\" request.");

    // The same message again (a retried delivery) changes nothing.
    expect(await storeBoardEmailReply(ctx.db, input)).toEqual({ stored: "nothing", reason: "already_answered" });
    expect((await ctx.db.select().from(goalWhyRequests).where(eq(goalWhyRequests.id, asked.body.id)))[0].answer).toBe(why.answer);
  });

  it("stores \"K1: 12500\" lines in a reminder reply as owner-reported readings on the KPI the reminder named", async () => {
    const { companyId, actor: owner } = await seedBoardWithChair("Readings");
    const ama = await addPerson(companyId, "operator", "ama");
    const revenue = await seedKpi(companyId, "Revenue", { ownerUserId: ama.userId });
    const clients = await seedKpi(companyId, "Clients", { ownerUserId: ama.userId });
    await configure(owner, companyId, { nextMeetingDate: dayOffset(3) });
    const sender = threadingSender();
    await sweep(sender);
    const thread = sender.sent.find((s) => s.input.to?.[0] === ama.email)!;
    // K1 is Clients and K2 is Revenue (sorted by title).
    expect(thread.input.text).toContain("- K1 Clients");

    const text = "Here you go:\nK1: 42\nk2 = 12,500.5 k\nK9: 7\nK1 is up because of the Accra office.\n> - K1 Clients: no reading yet.";
    const { input, result } = await reply(thread, ama.email!, text);
    expect(result).toEqual({ stored: "readings", readings: 2 });
    const readings = await ctx.db.select().from(goalKpiReadings).where(inArray(goalKpiReadings.goalId, [revenue.id, clients.id]));
    expect(readings.map((r) => [r.goalId, r.value, r.source, r.recordedByUserId, r.readingDate]).sort()).toEqual(
      [
        [clients.id, 42, "owner_reported", ama.userId, TODAY],
        [revenue.id, 12500.5, "owner_reported", ama.userId, TODAY],
      ].sort(),
    );
    expect((await ctx.db.select().from(goals).where(eq(goals.id, revenue.id)))[0].currentValue).toBe(12500.5);
    const notes = await threadComments(thread.issueId);
    expect(notes.find((n) => n.startsWith("Stored on the plan as owner-reported readings"))).toContain("- K2 Revenue: 12500.5 k");

    // A retried delivery does not add the readings twice.
    expect(await storeBoardEmailReply(ctx.db, input)).toEqual({ stored: "nothing", reason: "no_readings" });
    expect(await ctx.db.select().from(goalKpiReadings).where(inArray(goalKpiReadings.goalId, [revenue.id, clients.id]))).toHaveLength(2);
  });

  it("does not store a reply from anyone but the person the board emailed", async () => {
    const { companyId, actor: owner, chair } = await seedBoardWithChair("Stranger");
    const ama = await addPerson(companyId, "operator", "ama");
    const kpi = await seedKpi(companyId, "Revenue", { ownerUserId: ama.userId });
    const asked = await request(app(chair.actor)).post(`/api/goals/${kpi.id}/why-requests`).send({ question: "Why?" });
    await configure(owner, companyId, { nextMeetingDate: dayOffset(3) });
    const sender = threadingSender();
    await sweep(sender);
    const whyThread = sender.sent.find((s) => s.input.subject === "The board asks why: Revenue")!;
    const reminderThread = sender.sent.find((s) => s.input.subject?.startsWith("Board meeting on"))!;

    expect((await reply(whyThread, "someone@else.test", "Because.")).result).toEqual({ stored: "nothing", reason: "unknown_sender" });
    expect((await reply(reminderThread, `Ama <ama@else.test>`, "K1: 500")).result).toEqual({ stored: "nothing", reason: "unknown_sender" });
    expect((await ctx.db.select().from(goalWhyRequests).where(eq(goalWhyRequests.id, asked.body.id)))[0].status).toBe("open");
    expect(await ctx.db.select().from(goalKpiReadings).where(eq(goalKpiReadings.goalId, kpi.id))).toHaveLength(0);
    expect(await threadComments(whyThread.issueId)).toContain(
      "Not stored on the plan: this reply did not come from the person the board emailed, so it stays in this email thread only.",
    );
  });

  it("does not store a reply whose From matches the owner when AgentMail did not report DMARC pass (GRE-1215)", async () => {
    const { companyId, actor: owner, chair } = await seedBoardWithChair("Forged");
    const ama = await addPerson(companyId, "operator", "ama");
    const kpi = await seedKpi(companyId, "Revenue", { ownerUserId: ama.userId });
    const asked = await request(app(chair.actor)).post(`/api/goals/${kpi.id}/why-requests`).send({ question: "Why?" });
    await configure(owner, companyId, { nextMeetingDate: dayOffset(3) });
    const sender = threadingSender();
    await sweep(sender);
    const whyThread = sender.sent.find((s) => s.input.subject === "The board asks why: Revenue")!;
    const reminderThread = sender.sent.find((s) => s.input.subject?.startsWith("Board meeting on"))!;

    // A forged From header that matches the owner exactly.
    expect((await reply(whyThread, `Ama <${ama.email}>`, "Because.", false)).result).toEqual({ stored: "nothing", reason: "sender_not_authenticated" });
    expect((await reply(reminderThread, ama.email!, "K1: 500", false)).result).toEqual({ stored: "nothing", reason: "sender_not_authenticated" });
    expect((await ctx.db.select().from(goalWhyRequests).where(eq(goalWhyRequests.id, asked.body.id)))[0].status).toBe("open");
    expect((await issueService(ctx.db).getById(asked.body.ownerIssueId))?.status).not.toBe("done");
    expect(await ctx.db.select().from(goalKpiReadings).where(eq(goalKpiReadings.goalId, kpi.id))).toHaveLength(0);
    expect((await threadComments(whyThread.issueId)).some((n) => n.startsWith("Not stored on the plan: the email system could not confirm"))).toBe(true);

    // The owner's authenticated reply on the same thread is still stored.
    expect((await reply(whyThread, ama.email!, "Two clients paid late.")).result).toEqual({ stored: "why_answer" });
  });

  it("stores nothing, without failing, for a reply with no reading lines, a slippage alert reply, or with the board switched off", async () => {
    const { companyId, actor: owner, chair } = await seedBoardWithChair("Quiet");
    const ama = await addPerson(companyId, "operator", "ama");
    const kpi = await seedKpi(companyId, "Revenue", { ownerUserId: ama.userId });
    await postReading(owner, kpi.id, 100);
    await configure(owner, companyId, { nextMeetingDate: dayOffset(3) });
    const sender = threadingSender();
    await sweep(sender);
    const reminderThread = sender.sent.find((s) => s.input.subject?.startsWith("Board meeting on"))!;
    const alertThread = sender.sent.find((s) => s.input.subject === "KPI turned red: Revenue")!;
    const before = await ctx.db.select().from(goalKpiReadings).where(eq(goalKpiReadings.goalId, kpi.id));

    expect((await reply(reminderThread, ama.email!, "Thanks, I will send the numbers on Friday.")).result).toEqual({ stored: "nothing", reason: "no_readings" });
    expect((await reply(reminderThread, ama.email!, "")).result).toEqual({ stored: "nothing", reason: "no_readings" });
    expect((await reply(alertThread, chair.email!, "K1: 999")).result).toEqual({ stored: "nothing", reason: "not_stored_kind" });
    await instanceSettingsService(ctx.db).updateExperimental({ enableStrategyBoard: false });
    expect((await reply(reminderThread, ama.email!, "K1: 120")).result).toEqual({ stored: "nothing", reason: "switch_off" });
    await instanceSettingsService(ctx.db).updateExperimental({ enableStrategyBoard: true });

    expect(await ctx.db.select().from(goalKpiReadings).where(eq(goalKpiReadings.goalId, kpi.id))).toHaveLength(before.length);
    // An email thread the board did not send is not touched.
    expect(await storeBoardEmailReply(ctx.db, { companyId, conversationId: randomUUID(), providerMessageId: "x", senderAuthenticated: true })).toEqual({ stored: "nothing", reason: "not_board_thread" });
  });

  it("reads reading lines and the reply text above the quoted email", () => {
    expect(parseReadingLines("K1: 12500\nk2=1,250.75 clients\n - K3 Revenue: 5\n> K4: 9\nK5: soon\nK1: 13000")).toEqual([
      { code: "K1", value: 13000 },
      { code: "K2", value: 1250.75 },
    ]);
    expect(parseReadingLines("")).toEqual([]);
    expect(replyBody("Late payments.\n\n-----Original Message-----\nHello")).toBe("Late payments.");
    expect(replyBody("> quoted only")).toBe("");
  });
});
