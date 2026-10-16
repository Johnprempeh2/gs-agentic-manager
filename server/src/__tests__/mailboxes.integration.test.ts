import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  heartbeatRuns,
  issues,
  toolConnections,
} from "@greatstone/db";
import type { MailboxSearchInput } from "@greatstone/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { mailboxRoutes } from "../routes/mailboxes.js";
import { createStorageService } from "../storage/service.js";
import {
  MailboxAuthError,
  type MailboxAccount,
  type MailboxClientFactory,
} from "../services/mailbox-imap.js";
import {
  applyConnectorSkills,
  executeConnectorTool,
  resolveConnectorAssignments,
} from "../services/connector-runtime.js";
import { executeMailboxTool } from "../services/connectors/mailbox.js";
import { issueService } from "../services/issues.js";

const PASSWORD = "app-pw-9f3c-never-leak";

const RAW = Buffer.from(
  [
    "From: Ama Mensah <ama@client.example>",
    "To: John <john@greatstone.example>",
    "Subject: Q3 contract draft",
    "Date: Tue, 07 Oct 2026 10:00:00 +0000",
    "Message-ID: <q3@client.example>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hi John, the Q3 draft is attached.",
    "--b1",
    'Content-Type: application/pdf; name="contract.pdf"',
    'Content-Disposition: attachment; filename="contract.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4 fake").toString("base64"),
    "--b1",
    'Content-Type: application/x-msdownload; name="run.exe"',
    'Content-Disposition: attachment; filename="run.exe"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("MZ").toString("base64"),
    "--b1--",
    "",
  ].join("\r\n"),
);

const MESSAGES = [
  { uid: 7, from: "ama@client.example", subject: "Q3 contract draft", date: "2026-10-07" },
  { uid: 3, from: "kofi@other.example", subject: "Lunch", date: "2026-09-01" },
];

/** In-memory IMAP double. It accepts one password and records what it saw. */
function fakeImap() {
  const seen: { accounts: MailboxAccount[]; searches: MailboxSearchInput[]; drafts: string[] } = {
    accounts: [],
    searches: [],
    drafts: [],
  };
  let acceptedPassword = PASSWORD;
  const factory: MailboxClientFactory = (account) => {
    seen.accounts.push(account);
    const signIn = () => {
      if (account.password !== acceptedPassword) throw new MailboxAuthError();
    };
    return {
      async folders() {
        signIn();
        return ["INBOX", "Sent"];
      },
      async search(query) {
        signIn();
        seen.searches.push(query);
        return MESSAGES.filter(
          (m) =>
            (!query.from || m.from.includes(query.from)) &&
            (!query.subject || m.subject.includes(query.subject)) &&
            (!query.since || m.date >= query.since) &&
            (!query.before || m.date < query.before),
        ).map((m) => ({
          uid: m.uid,
          folder: query.folder,
          messageId: null,
          subject: m.subject,
          from: [{ name: null, address: m.from }],
          to: [],
          date: `${m.date}T10:00:00.000Z`,
          size: 100,
        }));
      },
      async source(_folder, uid) {
        signIn();
        return uid === 7 ? RAW : null;
      },
      async appendDraft(raw) {
        signIn();
        seen.drafts.push(raw.toString("utf8"));
        return { folder: "Drafts" };
      },
    };
  };
  return {
    factory,
    seen,
    rotatePassword: (next: string) => {
      acceptedPassword = next;
    },
  };
}

describe("mailbox connections (GRE-1343)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const folder = mkdtempSync(path.join(os.tmpdir(), "gsam-mailbox-"));
  const previousKey = process.env.GSAM_SECRETS_MASTER_KEY_FILE;
  const objects = new Map<string, Buffer>();
  const storage = createStorageService({
    id: "local_disk",
    async putObject(input) {
      objects.set(input.objectKey, input.body as Buffer);
    },
    async getObject(input) {
      return { stream: Readable.from([objects.get(input.objectKey)!]) };
    },
    async headObject(input) {
      return { exists: objects.has(input.objectKey) };
    },
    async deleteObject(input) {
      objects.delete(input.objectKey);
    },
  });

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(folder, "master.key");
    database = await startEmbeddedPostgresTestDatabase("gsam-mailbox-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await database?.cleanup();
    if (previousKey === undefined) delete process.env.GSAM_SECRETS_MASTER_KEY_FILE;
    else process.env.GSAM_SECRETS_MASTER_KEY_FILE = previousKey;
    rmSync(folder, { recursive: true, force: true });
  });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Mailbox test",
      issuePrefix: `M${companyId.slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (const [id, name] of [
      [agentId, "Mail reader"],
      [otherAgentId, "Other agent"],
    ])
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Find the Q3 email", status: "in_progress", assigneeAgentId: agentId },
      { id: otherIssueId, companyId, title: "Not yours", status: "in_progress", assigneeAgentId: otherAgentId },
    ]);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    const imap = fakeImap();
    let actor: Record<string, unknown> = { type: "board", source: "local_implicit" };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", mailboxRoutes(db, storage, { clientFactory: imap.factory }));
    app.use(errorHandler);
    const asBoard = () => {
      actor = { type: "board", source: "local_implicit" };
    };
    const asAgent = (id = agentId) => {
      actor = { type: "agent", agentId: id, companyId, runId: id === agentId ? runId : undefined };
    };
    const connect = (overrides: Record<string, unknown> = {}) =>
      request(app)
        .post(`/api/companies/${companyId}/mailboxes`)
        .send({
          label: "John (Greatstone)",
          address: "john@greatstone.example",
          host: "imap.greatstone.example",
          port: 993,
          secure: true,
          username: "john@greatstone.example",
          password: PASSWORD,
          agentIds: [agentId],
          idempotencyKey: randomUUID(),
          ...overrides,
        });
    return { companyId, agentId, otherAgentId, issueId, otherIssueId, runId, app, imap, asBoard, asAgent, connect };
  }

  it("adds an IMAP mailbox only after signing in, and shows it as connected", async () => {
    const f = await fixture();
    const bad = await f.connect({ password: "wrong" });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/sign-in failed/i);
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);

    const key = randomUUID();
    const created = await f.connect({ idempotencyKey: key });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      label: "John (Greatstone)",
      address: "john@greatstone.example",
      healthStatus: "ok",
      healthMessage: "Connected",
      agentIds: [f.agentId],
      allAgents: false,
    });
    // A retried submit returns the same mailbox instead of a second one.
    const retried = await f.connect({ idempotencyKey: key });
    expect(retried.body.id).toBe(created.body.id);
    const listed = await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`);
    expect(listed.body.map((m: { id: string }) => m.id)).toEqual([created.body.id]);
  });

  it("lets an assigned agent search by sender, subject and date, and read a full message", async () => {
    const f = await fixture();
    const { body: mailbox } = await f.connect();
    f.asAgent();
    const mine = await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`);
    expect(mine.body.map((m: { id: string }) => m.id)).toEqual([mailbox.id]);

    const bySender = await request(f.app)
      .post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/search`)
      .send({ from: "ama@client.example" });
    expect(bySender.status).toBe(200);
    expect(bySender.body.map((m: { uid: number }) => m.uid)).toEqual([7]);
    const bySubjectAndDate = await request(f.app)
      .post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/search`)
      .send({ subject: "Lunch", since: "2026-08-01", before: "2026-09-30" });
    expect(bySubjectAndDate.body.map((m: { uid: number }) => m.uid)).toEqual([3]);
    expect(f.imap.seen.searches.at(-1)).toMatchObject({ folder: "INBOX", limit: 25, since: "2026-08-01" });
    const badRange = await request(f.app)
      .post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/search`)
      .send({ since: "2026-10-01", before: "2026-09-01" });
    expect(badRange.status).toBe(400);

    const read = await request(f.app)
      .post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/read`)
      .send({ uid: 7 });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      uid: 7,
      subject: "Q3 contract draft",
      from: [{ name: "Ama Mensah", address: "ama@client.example" }],
      untrustedContent: true,
      attachments: [
        { index: 0, filename: "contract.pdf", contentType: "application/pdf" },
        { index: 1, filename: "run.exe" },
      ],
    });
    expect(read.body.text).toContain("the Q3 draft is attached");
    const missing = await request(f.app)
      .post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/read`)
      .send({ uid: 999 });
    expect(missing.status).toBe(404);
  });

  it("keeps a mailbox away from agents it is not assigned to", async () => {
    const f = await fixture();
    const { body: mailbox } = await f.connect();
    f.asAgent(f.otherAgentId);
    expect((await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body).toEqual([]);
    const search = await request(f.app)
      .post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/search`)
      .send({ from: "ama" });
    expect(search.status).toBe(404);
    // Agents cannot add, reassign or remove mailboxes.
    expect((await f.connect()).status).toBe(403);
    expect((await request(f.app).delete(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}`)).status).toBe(403);
    expect(await resolveConnectorAssignments(db, { companyId: f.companyId, agentId: f.otherAgentId })).toEqual([]);
  });

  it("reports a sign-in failure clearly and marks the mailbox for reconnecting", async () => {
    const f = await fixture();
    const { body: mailbox } = await f.connect();
    f.imap.rotatePassword("changed-at-provider");
    f.asAgent();
    const search = await request(f.app)
      .post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/search`)
      .send({ subject: "Q3" });
    expect(search.status).toBe(422);
    expect(search.body.error).toMatch(/sign-in failed.*reconnect/i);
    expect(JSON.stringify(search.body)).not.toContain(PASSWORD);
    f.asBoard();
    const [after] = (await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body;
    expect(after.healthStatus).toBe("failed");
    expect((await request(f.app).post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/test`)).status).toBe(422);
  });

  it("attaches a found email as .eml, or one attachment, to the agent's own task", async () => {
    const f = await fixture();
    const { body: mailbox } = await f.connect();
    f.asAgent();
    const save = (body: Record<string, unknown>) =>
      request(f.app)
        .post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/save`)
        .send({ uid: 7, issueId: f.issueId, ...body });

    const eml = await save({});
    expect(eml.status, JSON.stringify(eml.body)).toBe(201);
    expect(eml.body).toMatchObject({ filename: "Q3 contract draft.eml", contentType: "message/rfc822" });
    const pdf = await save({ attachmentIndex: 0 });
    expect(pdf.body).toMatchObject({ filename: "contract.pdf", contentType: "application/pdf" });
    const exe = await save({ attachmentIndex: 1 });
    expect(exe.status).toBe(422);
    const notMine = await save({ issueId: f.otherIssueId });
    expect(notMine.status).toBe(403);

    const rows = await issueService(db).listAttachments(f.issueId);
    expect(rows.map((r) => r.originalFilename).sort()).toEqual(["Q3 contract draft.eml", "contract.pdf"]);
    const stored = rows.find((r) => r.contentType === "message/rfc822")!;
    expect(objects.get(stored.objectKey)?.equals(RAW)).toBe(true);
    expect(stored.createdByAgentId).toBe(f.agentId);
  });

  it("saves an agent's email draft only after a person turns drafts on, and never sends", async () => {
    const f = await fixture();
    const { body: mailbox } = await f.connect();
    expect(mailbox.allowDrafts).toBe(false);
    const draft = {
      to: ["ama@client.example"],
      subject: "Re: Q3 contract draft – thanks",
      text: "Hi Ama,\nThanks, we will review the draft this week.\nJohn",
      inReplyTo: "<q3@client.example>",
    };
    const path_ = `/api/companies/${f.companyId}/mailboxes/${mailbox.id}/draft`;

    f.asAgent();
    const off = await request(f.app).post(path_).send(draft);
    expect(off.status).toBe(403);
    expect(off.body.details?.code).toBe("mailbox_drafts_off");
    expect(f.imap.seen.drafts).toHaveLength(0);
    // Agents cannot turn drafts on themselves.
    const selfServe = await request(f.app)
      .put(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/drafts`)
      .send({ allowDrafts: true });
    expect(selfServe.status).toBe(403);

    f.asBoard();
    const on = await request(f.app)
      .put(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/drafts`)
      .send({ allowDrafts: true });
    expect(on.status).toBe(200);
    expect(on.body.allowDrafts).toBe(true);

    f.asAgent();
    const injected = await request(f.app).post(path_).send({ ...draft, subject: "Hi\r\nBcc: evil@example.test" });
    expect(injected.status).toBe(400);
    const saved = await request(f.app).post(path_).send(draft);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body).toMatchObject({ folder: "Drafts", to: ["ama@client.example"] });
    expect(f.imap.seen.drafts).toHaveLength(1);
    const raw = f.imap.seen.drafts[0]!;
    expect(raw).toContain("From: john@greatstone.example\r\n");
    expect(raw).toContain("To: ama@client.example\r\n");
    expect(raw).toContain("In-Reply-To: <q3@client.example>\r\n");
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
    const body = raw.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toContain("we will review the draft");

    // Another agent the mailbox is not assigned to cannot use it.
    f.asAgent(f.otherAgentId);
    expect((await request(f.app).post(path_).send(draft)).status).toBe(404);

    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(activity.map((a) => a.action)).toEqual(expect.arrayContaining(["mailbox.drafts_updated", "mailbox.draft_saved"]));
  });

  it("gives native runners the mailbox tools, bound to the current task", async () => {
    const f = await fixture();
    const { body: mailbox } = await f.connect();
    const binding = { companyId: f.companyId, agentId: f.agentId, runId: f.runId, issueId: f.issueId };
    const [assignment] = await resolveConnectorAssignments(db, binding);
    expect(assignment.key).toBe("mailbox");
    expect(assignment.tools.map((t) => t.name)).toEqual([
      "mailbox_list",
      "mailbox_folders",
      "mailbox_search",
      "mailbox_read",
      "mailbox_save_to_task",
      "mailbox_save_draft",
    ]);
    const listed = await executeConnectorTool(db, binding, "mailbox_list", {});
    expect((listed as Array<{ id: string }>)[0].id).toBe(mailbox.id);
    // The tool ignores any issueId an agent passes and saves to the bound task.
    const saved = await executeMailboxTool(
      db,
      binding,
      "save",
      { mailboxId: mailbox.id, uid: 7, issueId: f.otherIssueId },
      { storage, clientFactory: f.imap.factory },
    );
    expect(saved).toMatchObject({ issueId: f.issueId });
  });

  it("never exposes the mailbox password in responses, activity, config, skills or tool results", async () => {
    const f = await fixture();
    const { body: mailbox, text: createdText } = await f.connect();
    expect(createdText).not.toContain(PASSWORD);
    const listText = (await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).text;
    expect(listText).not.toContain(PASSWORD);

    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, mailbox.id));
    expect(JSON.stringify(connection)).not.toContain(PASSWORD);
    const secretId = connection.credentialSecretRefs[0].secretId;
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, secretId));
    expect(secret.provider).toBe("local_encrypted");
    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secretId));
    expect(JSON.stringify(versions)).not.toContain(PASSWORD);

    f.asAgent();
    for (const call of [
      request(f.app).post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/search`).send({}),
      request(f.app).post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/read`).send({ uid: 7 }),
      request(f.app).post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/save`).send({ uid: 7, issueId: f.issueId }),
    ])
      expect((await call).text).not.toContain(PASSWORD);

    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(activity.map((a) => a.action)).toEqual(expect.arrayContaining(["mailbox.connected", "mailbox.message_saved"]));
    expect(JSON.stringify(activity)).not.toContain(PASSWORD);

    // The run transcript sees the skill text and tool results, never the password.
    const binding = { companyId: f.companyId, agentId: f.agentId, runId: f.runId, issueId: f.issueId };
    const assignments = await resolveConnectorAssignments(db, binding);
    expect(JSON.stringify(assignments)).not.toContain(PASSWORD);
    const configured = await applyConnectorSkills({}, [], assignments);
    const markdown = readFileSync(path.join(configured.paperclipRuntimeSkills[0].source, "SKILL.md"), "utf8");
    expect(markdown).toContain(mailbox.id);
    expect(markdown).not.toContain(PASSWORD);
    expect(JSON.stringify(await executeConnectorTool(db, binding, "mailbox_list", {}))).not.toContain(PASSWORD);
    for (const [action, args] of [
      ["folders", { mailboxId: mailbox.id }],
      ["search", { mailboxId: mailbox.id }],
      ["read", { mailboxId: mailbox.id, uid: 7 }],
    ] as const)
      expect(
        JSON.stringify(await executeMailboxTool(db, binding, action, args, { clientFactory: f.imap.factory })),
      ).not.toContain(PASSWORD);
    // The IMAP client still received the real password from the secret store.
    expect(f.imap.seen.accounts.at(-1)?.password).toBe(PASSWORD);
  });

  it("removes a mailbox so agents lose access", async () => {
    const f = await fixture();
    const { body: mailbox } = await f.connect();
    const [before] = await db.select().from(toolConnections).where(eq(toolConnections.id, mailbox.id));
    const secretId = before.credentialSecretRefs[0].secretId;
    const removed = await request(f.app).delete(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}`);
    expect(removed.status).toBe(200);
    // The stored password is revoked with the mailbox.
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, secretId));
    expect(!secret || secret.deletedAt !== null).toBe(true);
    expect((await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body).toEqual([]);
    f.asAgent();
    const search = await request(f.app)
      .post(`/api/companies/${f.companyId}/mailboxes/${mailbox.id}/search`)
      .send({});
    expect(search.status).toBe(404);
    expect(await resolveConnectorAssignments(db, { companyId: f.companyId, agentId: f.agentId })).toEqual([]);
  });
});
