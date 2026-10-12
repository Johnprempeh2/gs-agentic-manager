import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  chatConversations,
  chatEndpoints,
  companies,
  companyMemberships,
  createDb,
  emailMessages,
  issueComments,
  issueLabels,
  issueThreadInteractions,
  issues,
  labels,
  projects,
  supportQueues,
  supportTickets,
  toolApplications,
  toolConnections,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { supportQueueService, suggestSupportPriority } from "../services/support-queue.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres support queue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Wed 7 Oct 2026 10:00 BST.
const RECEIVED = new Date("2026-10-07T09:00:00.000Z");
const JOHN = "user-john";

describe("suggestSupportPriority", () => {
  it("starts outages on P1, questions on P3 and the rest on P2", () => {
    expect(suggestSupportPriority("Site is down", "Nobody can log in")).toBe("P1");
    expect(suggestSupportPriority("Report export broken", "The CSV is empty")).toBe("P2");
    expect(suggestSupportPriority("Quick question", "How do we add a user?")).toBe("P3");
  });
});

describeEmbeddedPostgres("client support queue", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-support-queue-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(emailMessages);
    await db.delete(chatConversations);
    await db.delete(chatEndpoints);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(supportTickets);
    await db.delete(supportQueues);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueLabels);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const [triage, bedrock, ridge, cover] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const projectId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Support", issuePrefix: `S${companyId.slice(0, 5).toUpperCase()}` });
    await db.insert(agents).values([
      { id: triage, companyId, name: "Triage", role: "general", status: "idle", adapterType: "codex_local" },
      { id: bedrock, companyId, name: "Bedrock", role: "engineer", status: "idle", adapterType: "codex_local" },
      { id: ridge, companyId, name: "Ridge", role: "engineer", status: "idle", adapterType: "codex_local" },
      { id: cover, companyId, name: "Cover", role: "general", status: "idle", adapterType: "codex_local" },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Client support" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: JOHN, membershipRole: "owner" });
    const wakeup = vi.fn(async () => null);
    let clock = RECEIVED;
    const svc = supportQueueService(db, { wakeup: wakeup as never, now: () => clock });
    const queue = await svc.configureQueue(companyId, {
      clientCode: "tst",
      projectId,
      triageAgentId: triage,
      installAgentId: bedrock,
      reliabilityAgentId: ridge,
      coverAgentId: cover,
      p1UserId: JOHN,
    });
    return { companyId, projectId, triage, bedrock, ridge, cover, wakeup, svc, queue, setNow: (at: Date) => { clock = at; } };
  }

  async function interactionsFor(issueId: string) {
    return db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
  }

  it("files one ticket per priority with the client code, owner and clock, and sends P1 to John at once", async () => {
    const s = await seed();
    expect(s.queue.clientCode).toBe("TST");
    const p1 = await s.svc.intake(s.companyId, "TST", { subject: "Site is down", body: "Nobody can log in", from: "ops@example.test", receivedAt: RECEIVED });
    const p2 = await s.svc.intake(s.companyId, "TST", { subject: "Export broken", body: "The CSV is empty", receivedAt: RECEIVED });
    const p3 = await s.svc.intake(s.companyId, "TST", { subject: "Question", body: "How do we add a user?", receivedAt: RECEIVED });

    const rows = await db.select().from(issues).where(eq(issues.projectId, s.projectId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.title.startsWith("[TST] ")).toBe(true);
      expect(row.assigneeAgentId).toBe(s.triage);
    }
    expect([p1, p2, p3].map((t) => t.ticket.priority)).toEqual(["P1", "P2", "P3"]);
    expect([p1, p2, p3].map((t) => t.issue.priority)).toEqual(["critical", "high", "medium"]);
    // Wed 10:00 BST: P1 due 14:00 BST, P2 due Thu 10:00 BST, P3 due Fri 10:00 BST.
    expect(p1.ticket.dueAt.toISOString()).toBe("2026-10-07T13:00:00.000Z");
    expect(p2.ticket.dueAt.toISOString()).toBe("2026-10-08T09:00:00.000Z");
    expect(p3.ticket.dueAt.toISOString()).toBe("2026-10-09T09:00:00.000Z");
    // Warnings at 75%: P1 Wed 13:00, P2 Wed 16:23, P3 Thu 14:15 BST.
    expect(p1.ticket.warnAt.toISOString()).toBe("2026-10-07T12:00:00.000Z");
    expect(p2.ticket.warnAt.toISOString()).toBe("2026-10-07T15:23:00.000Z");
    expect(p3.ticket.warnAt.toISOString()).toBe("2026-10-08T13:15:00.000Z");

    const [label] = await db.select().from(labels).where(eq(labels.companyId, s.companyId));
    expect(label!.name).toBe("client:TST");
    expect(await db.select().from(issueLabels).where(eq(issueLabels.labelId, label!.id))).toHaveLength(3);

    const p1Alerts = await interactionsFor(p1.issue.id);
    expect(p1Alerts).toHaveLength(1);
    expect(p1Alerts[0]!.addresseeUserId).toBe(JOHN);
    expect(p1Alerts[0]!.status).toBe("pending");
    expect(await interactionsFor(p2.issue.id)).toHaveLength(0);
    expect(await interactionsFor(p3.issue.id)).toHaveLength(0);
    expect(s.wakeup).toHaveBeenCalledTimes(3);
    expect(s.wakeup.mock.calls.every((call) => (call as unknown[])[0] === s.triage)).toBe(true);
  });

  it("routes install faults to Bedrock, reliability to Ridge, and uses cover when the owner is paused", async () => {
    const s = await seed();
    const install = await s.svc.intake(s.companyId, "TST", { subject: "Export broken", body: "x", receivedAt: RECEIVED });
    await s.svc.triage(install.issue.id, { category: "install" });
    expect((await db.select().from(issues).where(eq(issues.id, install.issue.id)))[0]!.assigneeAgentId).toBe(s.bedrock);

    const reliability = await s.svc.intake(s.companyId, "TST", { subject: "Runs stall", body: "x", receivedAt: RECEIVED });
    await s.svc.triage(reliability.issue.id, { category: "reliability", priority: "P1" });
    const [rel] = await db.select().from(issues).where(eq(issues.id, reliability.issue.id));
    expect(rel!.assigneeAgentId).toBe(s.ridge);
    expect(rel!.priority).toBe("critical");
    expect(await interactionsFor(reliability.issue.id)).toHaveLength(1); // upgraded to P1 -> John

    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.triage));
    const covered = await s.svc.intake(s.companyId, "TST", { subject: "Export broken", body: "x", receivedAt: RECEIVED });
    expect(covered.issue.assigneeAgentId).toBe(s.cover);

    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.cover));
    const nobody = await s.svc.intake(s.companyId, "TST", { subject: "Export broken", body: "x", receivedAt: RECEIVED });
    expect(nobody.issue.assigneeAgentId).toBeNull();
    // No agent can run: the named human is told at once, whatever the priority.
    expect((await interactionsFor(nobody.issue.id))[0]?.addresseeUserId).toBe(JOHN);
  });

  it("warns once at 75%, escalates a missed target to John once, and stops on the first reply email", async () => {
    const s = await seed();
    const p2 = await s.svc.intake(s.companyId, "TST", { subject: "Export broken", body: "x", receivedAt: RECEIVED });
    const p3 = await s.svc.intake(s.companyId, "TST", { subject: "Question", body: "How do we add a user?", receivedAt: RECEIVED });
    s.wakeup.mockClear();

    // Wed 12:00 BST: nothing due yet.
    s.setNow(new Date("2026-10-07T11:00:00.000Z"));
    expect(await s.svc.sweep()).toEqual({ repaired: 0, responded: 0, warned: 0, breached: 0 });

    // P2 warn point is 75% of 510 min = 383 min after Wed 10:00 -> Wed 16:23 BST.
    s.setNow(new Date("2026-10-07T15:30:00.000Z"));
    expect(await s.svc.sweep()).toEqual({ repaired: 0, responded: 0, warned: 1, breached: 0 });
    expect(await s.svc.sweep()).toEqual({ repaired: 0, responded: 0, warned: 0, breached: 0 });
    expect(s.wakeup).toHaveBeenCalledTimes(1);

    // A reply email to the client on the P3 thread stops its clock.
    const [endpointId, applicationId, connectionId] = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(toolApplications).values({ id: applicationId, companyId: s.companyId, applicationKey: `chat:agentmail:${endpointId}`, name: "mail", type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId: s.companyId, applicationId, name: "mail", uid: `chat-agentmail-${endpointId}`, connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId: s.companyId, connectionId, provider: "agentmail", publicationMode: "explicit", externalExecutionPolicy: "agent", publicId: randomUUID(), assignedAgentId: s.triage });
    const [conversation] = await db.insert(chatConversations).values({ companyId: s.companyId, endpointId, issueId: p3.issue.id, externalConversationId: "inbox", externalThreadId: "t1", externalLabel: "Question" }).returning();
    const replyAt = new Date("2026-10-07T15:00:00.000Z");
    await db.insert(emailMessages).values({ companyId: s.companyId, endpointId, conversationId: conversation!.id, providerMessageId: "m1", envelope: {} as never, text: "Hello", direction: "outbound", timestamp: replyAt });

    // Thu 10:00 BST: P2 target missed, P3 already answered.
    s.setNow(new Date("2026-10-08T09:00:00.000Z"));
    expect(await s.svc.sweep()).toEqual({ repaired: 0, responded: 1, warned: 0, breached: 1 });
    expect(await s.svc.sweep()).toEqual({ repaired: 0, responded: 0, warned: 0, breached: 0 });
    const [p3Ticket] = await db.select().from(supportTickets).where(eq(supportTickets.issueId, p3.issue.id));
    expect(p3Ticket!.firstResponseAt?.toISOString()).toBe(replyAt.toISOString());
    const breachAlerts = await interactionsFor(p2.issue.id);
    expect(breachAlerts).toHaveLength(1);
    expect(breachAlerts[0]!.addresseeUserId).toBe(JOHN);

    // A response by phone, recorded by a person, stops the P2 clock too.
    await s.svc.triage(p2.issue.id, { respondedAt: new Date("2026-10-08T09:30:00.000Z") });
    const [p2Ticket] = await db.select().from(supportTickets).where(eq(supportTickets.issueId, p2.issue.id));
    expect(p2Ticket!.firstResponseAt).not.toBeNull();
  });

  it("opens one clock for an email-filed ticket, even when the delivery is retried", async () => {
    const s = await seed();
    const [endpointId, applicationId, connectionId] = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(toolApplications).values({ id: applicationId, companyId: s.companyId, applicationKey: `chat:agentmail:${endpointId}`, name: "mail", type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId: s.companyId, applicationId, name: "mail", uid: `chat-agentmail-${endpointId}`, connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId: s.companyId, connectionId, provider: "agentmail", publicationMode: "explicit", externalExecutionPolicy: "agent", publicId: randomUUID(), assignedAgentId: s.triage });
    await s.svc.configureQueue(s.companyId, { clientCode: "TST", projectId: s.projectId, triageAgentId: s.triage, emailEndpointId: endpointId, p1UserId: JOHN });
    const queue = await s.svc.queueForEmailEndpoint(s.companyId, endpointId);
    const { fields } = await s.svc.issueFields(queue!, { subject: "Site is down", body: "Nobody can log in", receivedAt: RECEIVED });
    const [issue] = await db.insert(issues).values({ companyId: s.companyId, ...fields, labelIds: undefined } as never).returning();
    const first = await s.svc.afterEmailIntake(s.companyId, endpointId, issue!.id, RECEIVED);
    const retry = await s.svc.afterEmailIntake(s.companyId, endpointId, issue!.id, RECEIVED);
    expect(first?.priority).toBe("P1");
    expect(retry).toBeNull();
    expect(await db.select().from(supportTickets).where(eq(supportTickets.issueId, issue!.id))).toHaveLength(1);
    expect(await interactionsFor(issue!.id)).toHaveLength(1);
    expect(s.wakeup).toHaveBeenCalledTimes(1);
  });

  async function agentmailEndpoint(companyId: string, agentId: string) {
    const [endpointId, applicationId, connectionId] = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `chat:agentmail:${endpointId}`, name: "mail", type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "mail", uid: `chat-agentmail-${endpointId}`, connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "agentmail", publicationMode: "explicit", externalExecutionPolicy: "agent", publicId: randomUUID(), assignedAgentId: agentId });
    return endpointId;
  }

  it("opens the missing ticket on the next sweep when the ticket step after an email failed", async () => {
    const s = await seed();
    const endpointId = await agentmailEndpoint(s.companyId, s.triage);
    await s.svc.configureQueue(s.companyId, { clientCode: "TST", projectId: s.projectId, triageAgentId: s.triage, emailEndpointId: endpointId, p1UserId: JOHN });
    const queue = await s.svc.queueForEmailEndpoint(s.companyId, endpointId);
    const { fields } = await s.svc.issueFields(queue!, { subject: "Site is down", body: "Nobody can log in", receivedAt: RECEIVED });
    // The email committed its issue and thread, but afterEmailIntake never ran.
    const [issue] = await db.insert(issues).values({ companyId: s.companyId, ...fields, labelIds: undefined } as never).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId: s.companyId, endpointId, issueId: issue!.id, externalConversationId: "inbox", externalThreadId: "t1", externalLabel: "Site is down" }).returning();
    await db.insert(emailMessages).values({ companyId: s.companyId, endpointId, conversationId: conversation!.id, providerMessageId: "m1", envelope: {} as never, text: "Nobody can log in", direction: "inbound", timestamp: RECEIVED });

    s.setNow(new Date("2026-10-07T09:05:00.000Z"));
    expect((await s.svc.sweep()).repaired).toBe(1);
    expect((await s.svc.sweep()).repaired).toBe(0);
    const tickets = await db.select().from(supportTickets).where(eq(supportTickets.issueId, issue!.id));
    expect(tickets).toHaveLength(1);
    // The clock runs from the email, not from the repair.
    expect(tickets[0]!.receivedAt.toISOString()).toBe(RECEIVED.toISOString());
    expect(tickets[0]!.dueAt.toISOString()).toBe("2026-10-07T13:00:00.000Z");
    expect((await interactionsFor(issue!.id))[0]?.addresseeUserId).toBe(JOHN);
  });

  it("rejects queue links from another company, and never routes one company's inbox to another's queue", async () => {
    const s = await seed();
    const other = await seed();
    const otherEndpoint = await agentmailEndpoint(other.companyId, other.triage);
    const base = { clientCode: "TST", projectId: s.projectId, triageAgentId: s.triage };
    const cases: Array<[Partial<typeof base> & Record<string, unknown>, RegExp]> = [
      [{ projectId: other.projectId }, /Project/],
      [{ emailEndpointId: otherEndpoint }, /Email inbox/],
      [{ triageAgentId: other.triage }, /support agent/],
      [{ installAgentId: other.bedrock }, /support agent/],
      [{ reliabilityAgentId: other.ridge }, /support agent/],
      [{ coverAgentId: other.cover }, /support agent/],
      [{ p1UserId: "user-outsider" }, /P1 person/],
    ];
    for (const [change, message] of cases)
      await expect(s.svc.configureQueue(s.companyId, { ...base, ...change })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(message) });
    const [stored] = await db.select().from(supportQueues).where(eq(supportQueues.companyId, s.companyId));
    expect(stored!.emailEndpointId).toBeNull();

    // A queue row that names another company's inbox (bad data) is still not used for it.
    await db.update(supportQueues).set({ emailEndpointId: otherEndpoint }).where(eq(supportQueues.id, s.queue.id));
    expect(await s.svc.queueForEmailEndpoint(other.companyId, otherEndpoint)).toBeNull();
  });

  it("rejects client names in place of a client code", async () => {
    const s = await seed();
    await expect(s.svc.configureQueue(s.companyId, { clientCode: "Acme Ltd", projectId: s.projectId, triageAgentId: s.triage })).rejects.toThrow(/Client code/);
  });
});
