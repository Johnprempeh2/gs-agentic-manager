import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  secretAccessEvents,
} from "@greatstone/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { secretRoutes } from "../routes/secrets.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping adapter-switch secret binding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Actor = Express.Request["actor"];

// GRE-1609: switching an agent's adapter rebuilt adapterConfig from the agnostic
// keys only, so top-level `access.<ALIAS>` grants were dropped and their binding
// rows deleted with no `secret.binding.deleted` event.
describeEmbeddedPostgres("agent adapter switch keeps secret access grants (GRE-1609)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-adapter-switch-secrets-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-adapter-switch-secrets-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(heartbeatRuns);
    await db.delete(agentConfigRevisions);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.GSAM_SECRETS_MASTER_KEY_FILE;
    else process.env.GSAM_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  const localBoard: Actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };

  function app(actor: Actor) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", agentRoutes(db));
    instance.use("/api", secretRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedAgentWithAccessGrant() {
    const [company] = await db.insert(companies).values({
      name: `Switch Co ${randomUUID().slice(0, 6)}`,
      issuePrefix: `W${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Everest",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const agentId = agent!.id;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: {},
    }).returning();
    const secret = await secretService(db).create(companyId, {
      key: "NETLIFY_PAT",
      name: "Netlify PAT",
      provider: "local_encrypted",
      value: "netlify-pat-value",
    });

    // Bind the grant the way John does: a same-adapter save that adds the key.
    await request(app(localBoard))
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: { "access.NETLIFY_PAT": { type: "secret_ref", secretId: secret.id, version: "latest" } },
      })
      .expect(200);

    const agentActor: Actor = {
      type: "agent",
      agentId,
      companyId,
      runId: run!.id,
      keyScope: { kind: "standard" },
      source: "agent_jwt",
    };
    return { companyId, agentId, secretId: secret.id, secretKey: secret.key, agentActor };
  }

  async function accessBindings(companyId: string, agentId: string) {
    const rows = await db.select().from(companySecretBindings).where(and(
      eq(companySecretBindings.companyId, companyId),
      eq(companySecretBindings.targetType, "agent"),
      eq(companySecretBindings.targetId, agentId),
    ));
    return rows.map((row) => ({ configPath: row.configPath, secretId: row.secretId }));
  }

  async function bindingEvents(companyId: string, action: string) {
    const rows = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, action),
    ));
    return rows.map((row) => row.details as Record<string, unknown>);
  }

  async function adapterConfigOf(agentId: string) {
    const [row] = await db.select({ adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.id, agentId));
    return row!.adapterConfig as Record<string, unknown>;
  }

  it("keeps access.* bindings, the agent's secret list, and value reads across claude_local -> codex_local -> claude_local", async () => {
    const { companyId, agentId, secretId, secretKey, agentActor } = await seedAgentWithAccessGrant();
    const beforeBindings = await accessBindings(companyId, agentId);
    expect(beforeBindings).toEqual([{ configPath: "access.NETLIFY_PAT", secretId }]);
    const beforeList = await request(app(agentActor)).get("/api/agents/me/secrets").expect(200);
    expect(beforeList.body.secrets.map((entry: { key: string }) => entry.key)).toEqual([secretKey]);

    // The switch dialog sends a full replacement config for the new adapter
    // that carries only the agnostic keys plus the new adapter's fields.
    await request(app(localBoard))
      .patch(`/api/agents/${agentId}`)
      .send({ adapterType: "codex_local", adapterConfig: {}, replaceAdapterConfig: true })
      .expect(200);
    await request(app(localBoard))
      .patch(`/api/agents/${agentId}`)
      .send({ adapterType: "claude_local", adapterConfig: {}, replaceAdapterConfig: true })
      .expect(200);

    expect(await adapterConfigOf(agentId)).toMatchObject({
      "access.NETLIFY_PAT": { type: "secret_ref", secretId, version: "latest" },
    });
    expect(await accessBindings(companyId, agentId)).toEqual(beforeBindings);
    const afterList = await request(app(agentActor)).get("/api/agents/me/secrets").expect(200);
    expect(afterList.body).toEqual(beforeList.body);
    const read = await request(app(agentActor)).post(`/api/agents/me/secrets/${secretKey}/value`).expect(200);
    expect(read.body.value).toBe("netlify-pat-value");
    expect(await bindingEvents(companyId, "secret.binding.deleted")).toEqual([]);
  });

  it("records secret.binding.deleted when a save removes an access grant", async () => {
    const { companyId, agentId, secretKey, agentActor } = await seedAgentWithAccessGrant();

    await request(app(localBoard))
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: {}, replaceAdapterConfig: true })
      .expect(200);

    expect(await accessBindings(companyId, agentId)).toEqual([]);
    expect(await bindingEvents(companyId, "secret.binding.deleted")).toEqual([
      expect.objectContaining({
        targetType: "agent",
        targetId: agentId,
        configPath: "access.NETLIFY_PAT",
        bindingType: "secret_ref",
      }),
    ]);
    await request(app(agentActor)).post(`/api/agents/me/secrets/${secretKey}/value`).expect(403);
  });
});
