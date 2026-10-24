import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
} from "@greatstone/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres request_steps tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A fake key, shaped like the real thing. The tests assert it never appears
// anywhere outside the encrypted secret store.
const FAKE_SECRET = `rk_test_${randomUUID().replace(/-/g, "")}PLANTED`;

describeEmbeddedPostgres("request_steps (routes + postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const secretsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsam-steps-secrets-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;
  /** Every response body this suite saw, checked for the secret at the end of each test. */
  const responseBodies: string[] = [];

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-request-steps-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
    fs.rmSync(secretsTmpDir, { recursive: true, force: true });
    if (previousKeyFile === undefined) delete process.env.GSAM_SECRETS_MASTER_KEY_FILE;
    else process.env.GSAM_SECRETS_MASTER_KEY_FILE = previousKeyFile;
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function call<T = any>(
    actor: Record<string, unknown>,
    method: "get" | "post",
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const req = request(app(actor))[method](url);
    const res = method === "post" ? await req.send(body as object) : await req;
    responseBodies.push(res.text ?? "");
    return { status: res.status, body: res.body as T };
  }

  const boardActor = (companyId: string, userId: string, membershipRole = "owner") => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole }],
    isInstanceAdmin: false,
  });
  const agentActor = (companyId: string, agentId: string, runId: string) => ({
    type: "agent",
    source: "agent_key",
    companyId,
    agentId,
    runId,
  });

  let sequence = 0;

  async function seed(options: { addresseeRole?: string } = {}) {
    sequence += 1;
    const prefix = `ST${sequence}`;
    const companyId = randomUUID();
    const ownerId = `owner-${sequence}`;
    const helperId = `helper-${sequence}`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: options.addresseeRole ?? "owner" },
      { companyId, principalType: "user", principalId: helperId, status: "active", membershipRole: "owner" },
    ]);
    const now = new Date();
    await db.insert(authUsers).values([
      { id: ownerId, name: `Person ${sequence}`, email: `${ownerId}@example.com`, createdAt: now, updatedAt: now },
      { id: helperId, name: `Helper ${sequence}`, email: `${helperId}@example.com`, createdAt: now, updatedAt: now },
    ]);
    // Owners configure agents through the agents:configure grant.
    await db.insert(principalPermissionGrants).values(
      [ownerId, helperId]
        .filter((id) => id === helperId || (options.addresseeRole ?? "owner") === "owner")
        .map((principalId) => ({ companyId, principalType: "user", principalId, permissionKey: "agents:configure" })),
    );
    const agentId = randomUUID();
    const lintelId = randomUUID();
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Guide", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: lintelId, companyId, name: "Lintel", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: { model: "keep-me" }, runtimeConfig: {}, permissions: {} },
    ]);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-1`,
      title: "Set up Stripe checkout tests",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: ownerId,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    return { companyId, ownerId, helperId, agentId, lintelId, issueId, runId };
  }

  function stepsPayload(extra: Record<string, unknown> = {}) {
    return {
      version: 1,
      title: "Stripe test key for the agents",
      why: "So Lintel can test checkout on the staging site.",
      minutes: 2,
      risk: "safe",
      steps: [
        { text: "In Stripe, open **Developers → API keys → Create restricted key**.", copy: ["GSAM agents"], link: { label: "Open Stripe", url: "https://dashboard.stripe.com/test/apikeys" } },
        { text: "Copy the key.", expect: "It starts `rk_test_`." },
      ],
      ...extra,
    };
  }

  async function createCard(s: Awaited<ReturnType<typeof seed>>, payloadExtra: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
    return call(agentActor(s.companyId, s.agentId, s.runId), "post", `/api/issues/${s.issueId}/interactions`, {
      kind: "request_steps",
      payload: stepsPayload(payloadExtra),
      ...body,
    });
  }

  const secretField = (s: { lintelId: string }) => ({
    secretName: "stripe/sandbox-agents",
    description: "Stripe sandbox restricted key for the agents",
    expectedPrefix: "rk_test_",
    linkToAgentIds: [s.lintelId],
    adapterEnvKey: "STRIPE_SECRET_KEY",
  });

  async function wakesFor(agentId: string, text: string) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      if (JSON.stringify(rows).includes(text)) return JSON.stringify(rows);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return "";
  }

  /** The raw value must not be anywhere but the encrypted secret store. */
  async function expectNoLeak(value: string) {
    const dumps = {
      interactions: await db.select().from(issueThreadInteractions),
      activity: await db.select().from(activityLog),
      comments: await db.select().from(issueComments),
      wakeups: await db.select().from(agentWakeupRequests),
      runs: await db.select().from(heartbeatRuns),
      runEvents: await db.select().from(heartbeatRunEvents),
      agents: await db.select().from(agents),
      agentRevisions: await db.select().from(agentConfigRevisions),
      secrets: await db.select().from(companySecrets),
      secretVersions: await db.select().from(companySecretVersions),
    };
    for (const [table, rows] of Object.entries(dumps)) {
      expect(JSON.stringify(rows), `${table} must not hold the secret`).not.toContain(value);
    }
    for (const body of responseBodies) expect(body).not.toContain(value);
  }

  it("creates a human-only card for the responsible person and refuses agents from another company", async () => {
    const s = await seed();
    const other = await seed();
    const created = await createCard(s, { secret: secretField(s) });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: "request_steps",
      status: "pending",
      title: "Stripe test key for the agents",
      effectiveResolverPolicy: "human_only",
      continuationPolicy: "wake_assignee",
      addresseeUserId: s.ownerId,
      payload: { progress: null, secretAccess: { addresseeCanSave: true } },
    });

    const crossCompany = await createCard(s, { secret: { ...secretField(s), linkToAgentIds: [other.lintelId] } });
    expect(crossCompany.status).toBe(422);
    expect(JSON.stringify(crossCompany.body)).toContain("linkToAgentIds");
  });

  it("tells the agent when the addressee cannot save the secret, and who can", async () => {
    const s = await seed({ addresseeRole: "viewer" });
    const created = await createCard(s, { secret: secretField(s) });
    expect(created.status).toBe(201);
    expect(created.body.payload.secretAccess.addresseeCanSave).toBe(false);
    expect(created.body.payload.secretAccess.whoCan).toEqual([`Helper ${sequence}`]);

    const viewerTry = await call(boardActor(s.companyId, s.ownerId, "viewer"), "post", `/api/issues/${s.issueId}/interactions/${created.body.id}/accept`, { secretValue: FAKE_SECRET });
    expect(viewerTry.status).toBe(403);
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, created.body.id));
    expect(row!.status).toBe("pending");
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, s.companyId))).toHaveLength(0);
    await expectNoLeak(FAKE_SECRET);
  });

  it("never lets an agent tick or finish a steps card", async () => {
    const s = await seed();
    const created = await createCard(s);
    const agent = agentActor(s.companyId, s.agentId, s.runId);
    expect((await call(agent, "post", `/api/issues/${s.issueId}/interactions/${created.body.id}/accept`, {})).status).toBe(403);
    expect((await call(agent, "post", `/api/issues/${s.issueId}/interactions/${created.body.id}/steps-progress`, { tickedSteps: [0] })).status).toBe(403);
  });

  it("keeps ticks on the card so they survive a reload", async () => {
    const s = await seed();
    const created = await createCard(s);
    const owner = boardActor(s.companyId, s.ownerId);
    const ticked = await call(owner, "post", `/api/issues/${s.issueId}/interactions/${created.body.id}/steps-progress`, { tickedSteps: [1, 0, 1] });
    expect(ticked.status).toBe(200);
    expect(ticked.body.payload.progress).toEqual({ tickedSteps: [0, 1] });
    const listed = await call(owner, "get", `/api/issues/${s.issueId}/interactions`);
    expect(listed.body.find((i: { id: string }) => i.id === created.body.id).payload.progress).toEqual({ tickedSteps: [0, 1] });
    const outOfRange = await call(owner, "post", `/api/issues/${s.issueId}/interactions/${created.body.id}/steps-progress`, { tickedSteps: [5] });
    expect(outOfRange.status).toBe(400);
  });

  it("saves the secret on Done, links it by reference, returns only ids, and leaks it nowhere", async () => {
    const s = await seed();
    const created = await createCard(s, { secret: secretField(s) });
    const owner = boardActor(s.companyId, s.ownerId);
    const url = `/api/issues/${s.issueId}/interactions/${created.body.id}/accept`;

    const empty = await call(owner, "post", url, {});
    expect(empty.status).toBe(422);

    const done = await call(owner, "post", url, { secretValue: FAKE_SECRET });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("accepted");
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.companyId, s.companyId));
    expect(secret).toMatchObject({ name: "stripe/sandbox-agents" });
    expect(done.body.result).toEqual({
      version: 1,
      outcome: "accepted",
      secret: { secretId: secret!.id, secretName: "stripe/sandbox-agents", linkedAgentIds: [s.lintelId] },
    });

    const [lintel] = await db.select().from(agents).where(eq(agents.id, s.lintelId));
    expect(lintel!.adapterConfig).toMatchObject({
      model: "keep-me",
      "access.STRIPE_SECRET_KEY": { type: "secret_ref", secretId: secret!.id, version: "latest" },
    });
    const [guide] = await db.select().from(agents).where(eq(agents.id, s.agentId));
    expect(guide!.adapterConfig).toEqual({});

    // The requesting agent wakes with the name and id, never the value.
    expect(await wakesFor(s.agentId, "stripe/sandbox-agents")).toContain("stripe/sandbox-agents");

    await call(owner, "get", `/api/issues/${s.issueId}/interactions`);
    await expectNoLeak(FAKE_SECRET);

    // A second card with the same name saves a new version of the same secret.
    const again = await createCard(s, { secret: { ...secretField(s), linkToAgentIds: undefined, adapterEnvKey: undefined } }, { idempotencyKey: "steps:again" });
    const rotated = await call(owner, "post", `/api/issues/${s.issueId}/interactions/${again.body.id}/accept`, { secretValue: `${FAKE_SECRET}2` });
    expect(rotated.status).toBe(200);
    expect(rotated.body.result.secret.secretId).toBe(secret!.id);
    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret!.id));
    expect(versions).toHaveLength(2);
    await expectNoLeak(`${FAKE_SECRET}2`);
  });

  it("only links agents in the same company, even if the stored card names another", async () => {
    const s = await seed();
    const other = await seed();
    const created = await createCard(s, { secret: secretField(s) });
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, created.body.id));
    const tampered = row!.payload as Record<string, any>;
    tampered.secret.linkToAgentIds = [s.lintelId, other.lintelId];
    await db.update(issueThreadInteractions).set({ payload: tampered as any }).where(eq(issueThreadInteractions.id, row!.id));

    const done = await call(boardActor(s.companyId, s.ownerId), "post", `/api/issues/${s.issueId}/interactions/${created.body.id}/accept`, { secretValue: FAKE_SECRET });
    expect(done.status).toBe(200);
    expect(done.body.result.secret.linkedAgentIds).toEqual([s.lintelId]);
    const [foreign] = await db.select().from(agents).where(eq(agents.id, other.lintelId));
    expect(foreign!.adapterConfig).toEqual({ model: "keep-me" });
    await expectNoLeak(FAKE_SECRET);
  });

  it("saves the secret but leaves linking to an owner when the person may not configure agents", async () => {
    const s = await seed({ addresseeRole: "operator" });
    const created = await createCard(s, { secret: secretField(s) });
    const done = await call(boardActor(s.companyId, s.ownerId, "operator"), "post", `/api/issues/${s.issueId}/interactions/${created.body.id}/accept`, { secretValue: FAKE_SECRET });
    expect(done.status).toBe(200);
    expect(done.body.result.secret).toMatchObject({ linkedAgentIds: [], linkingNeedsOwner: true });
    const [lintel] = await db.select().from(agents).where(eq(agents.id, s.lintelId));
    expect(lintel!.adapterConfig).toEqual({ model: "keep-me" });
    await expectNoLeak(FAKE_SECRET);
  });

  it("I can't do this needs a reason and wakes the agent with it", async () => {
    const s = await seed();
    const created = await createCard(s);
    const owner = boardActor(s.companyId, s.ownerId);
    const url = `/api/issues/${s.issueId}/interactions/${created.body.id}/reject`;
    expect((await call(owner, "post", url, {})).status).toBe(422);
    const rejected = await call(owner, "post", url, { reason: "I don't have Stripe access" });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: "rejected", result: { reason: "I don't have Stripe access" } });
    expect(await wakesFor(s.agentId, "I don't have Stripe access")).toContain("I don't have Stripe access");
  });

  it("finishes a card without a secret once a person presses Done", async () => {
    const s = await seed();
    const created = await createCard(s);
    const stray = await call(boardActor(s.companyId, s.ownerId), "post", `/api/issues/${s.issueId}/interactions/${created.body.id}/accept`, { secretValue: FAKE_SECRET });
    expect(stray.status).toBe(422);
    const done = await call(boardActor(s.companyId, s.ownerId), "post", `/api/issues/${s.issueId}/interactions/${created.body.id}/accept`, {});
    expect(done.status).toBe(200);
    expect(done.body.result).toEqual({ version: 1, outcome: "accepted" });
    await expectNoLeak(FAKE_SECRET);
  });
});
