import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@greatstone/db";
import { releaseLiveRunSecretValues } from "@greatstone/adapter-utils/run-secret-values";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { secretRoutes } from "../routes/secrets.js";
import { sanitizeRunLogChunk } from "../services/heartbeat.js";
import { createDurableRunLogStore } from "../services/run-log-store.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// GRE-6519: a secret an agent reads from `POST /api/agents/me/secrets/:key/value`
// was masked on API reads but written in clear text to the run log file, because
// the log writer only knew the run's launch env.
describeEmbeddedPostgres("agent secret values printed by a run", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `gsam-agent-secret-run-output-${randomUUID()}`);
  const runIds: string[] = [];

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-secret-run-output");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    for (const runId of runIds.splice(0)) releaseLiveRunSecretValues(runId);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.GSAM_SECRETS_MASTER_KEY_FILE;
    else process.env.GSAM_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    runIds.push(runId);
    await db.insert(companies).values({
      id: companyId,
      name: "Run output redaction",
      issuePrefix: `R${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Deployer",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "running",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RUN-1",
      title: "Deploy the site",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
    });
    const value = `nfp_${randomUUID().replace(/-/g, "")}`;
    const secret = await secretService(db).create(companyId, {
      key: "NETLIFY_PAT",
      name: "Netlify PAT",
      provider: "local_encrypted",
      value,
    });
    await secretService(db).createBinding({
      companyId,
      secretId: secret.id,
      targetType: "agent",
      targetId: agentId,
      configPath: "access.NETLIFY_PAT",
      projectionClass: "class_2_runtime_only",
    });
    return { companyId, agentId, runId, issueId, value };
  }

  function agentApp(fixture: Awaited<ReturnType<typeof seed>>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: fixture.agentId,
        companyId: fixture.companyId,
        runId: fixture.runId,
        keyScope: { kind: "standard" },
        source: "agent_jwt",
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function boardApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  it("keeps the value out of the stored run log and the comment API", async () => {
    const fixture = await seed();

    const read = await request(agentApp(fixture)).post("/api/agents/me/secrets/netlify_pat/value");
    expect(read.status).toBe(200);
    expect(read.body.value).toBe(fixture.value);

    // The agent prints the token, as `curl ... | jq .value` or `echo` would.
    // This is the run-log write path in heartbeat's onLog; the launch env did
    // not hold the value, so `runSecretValues` is empty.
    const store = createDurableRunLogStore({ basePath: path.join(tmpDir, "run-logs") });
    const handle = await store.begin({ companyId: fixture.companyId, agentId: fixture.agentId, runId: fixture.runId });
    for (const chunk of [
      `{"key":"netlify_pat","value":"${fixture.value}","version":1}\n`,
      `export NETLIFY_AUTH_TOKEN=${fixture.value}\n`,
    ]) {
      await store.append(handle, {
        stream: "stdout",
        chunk: sanitizeRunLogChunk(chunk, { runId: fixture.runId, runSecretValues: [] }),
        ts: new Date().toISOString(),
      });
    }
    const logDir = path.join(tmpDir, "run-logs", fixture.companyId, fixture.agentId);
    const rawLog = readdirSync(logDir).map((file) => readFileSync(path.join(logDir, file), "utf8")).join("");
    expect(rawLog).not.toContain(fixture.value);
    expect(rawLog).toContain(`NETLIFY_AUTH_TOKEN=${REDACTED_EVENT_VALUE}`);
    await store.finalize(handle);
    const stored = await store.read(handle);
    expect(stored.content).not.toContain(fixture.value);

    // The agent also pastes it into a task comment.
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      authorType: "agent",
      authorAgentId: fixture.agentId,
      body: `Deployed with token ${fixture.value}`,
    });
    const comments = await request(boardApp(fixture.companyId)).get(`/api/issues/${fixture.issueId}/comments`);
    expect(comments.status).toBe(200);
    expect(JSON.stringify(comments.body)).not.toContain(fixture.value);
    expect(comments.body[0].body).toBe(`Deployed with token ${REDACTED_EVENT_VALUE}`);
  });

  it("does not redact another run's log with this run's secret", async () => {
    const fixture = await seed();
    await request(agentApp(fixture)).post("/api/agents/me/secrets/netlify_pat/value").expect(200);

    expect(sanitizeRunLogChunk(`token ${fixture.value}`, { runId: randomUUID(), runSecretValues: [] }))
      .toBe(`token ${fixture.value}`);
    expect(sanitizeRunLogChunk(`token ${fixture.value}`, { runId: fixture.runId, runSecretValues: [] }))
      .toBe(`token ${REDACTED_EVENT_VALUE}`);
  });
});
