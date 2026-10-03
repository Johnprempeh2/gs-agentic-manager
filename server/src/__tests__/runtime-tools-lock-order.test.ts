import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  secretAccessEvents,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { documentService } from "../services/documents.js";
import {
  captureRunIdentity,
  reconcileSteeredIdentity,
  initializeRunIdentity,
  reserveSteeredIdentity,
} from "../services/run-identity.js";

type AuditContext = { issueId?: string | null; heartbeatRunId?: string | null };

// The secret store is replaced by one that writes the same audit row as
// `recordAccessEvent` in services/secrets.ts: one insert that references the
// company, the task and the run. A credential burst then performs the real
// audit write next to identity capture, as it does on live.
const vault = vi.hoisted(() => {
  const state: { audit?: (companyId: string, context?: AuditContext) => Promise<void> } = {};
  return {
    state,
    resolveUserSecretValue: async (
      companyId: string,
      input: { responsibleUserId: string },
      context?: AuditContext,
    ) => {
      await state.audit?.(companyId, context);
      return { value: `test-token-${input.responsibleUserId}` };
    },
    resolveSecretValue: async () => "test-dedicated-token",
  };
});
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));

/** SQLSTATE of a driver error (Drizzle keeps it on `cause`), or the HTTP status. */
function outcome(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return "ok";
  let current: unknown = result.reason;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const { code, status, cause } = current as { code?: unknown; status?: unknown; cause?: unknown };
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    if (typeof status === "number") return `http ${status}`;
    current = cause;
  }
  return String(result.reason);
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("runtime tool identity lock order", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    vi.stubEnv("GSAM_AGENT_JWT_SECRET", "test-runtime-tools-lock-order-secret");
    database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-tools-lock-order-");
    db = createDb(database.connectionString);
    // Live runs on a database restored from a GSAM backup. Backups recreate
    // foreign keys in constraint-name order, so the audit row's run check
    // (heartbeat_run_id) fires before its task check (issue_id): the reverse
    // of migration order. Recreate the task key to match that layout.
    await db.execute(sql`alter table secret_access_events drop constraint secret_access_events_issue_id_issues_id_fk`);
    await db.execute(sql`alter table secret_access_events add constraint secret_access_events_issue_id_issues_id_fk
      foreign key (issue_id) references issues(id) on delete set null`);
    vault.state.audit = async (companyId, context) => {
      await db.insert(secretAccessEvents).values({
        companyId,
        secretScope: "user",
        provider: "local_encrypted",
        actorType: "system",
        consumerType: "system",
        consumerId: "workspace-git-credential",
        issueId: context?.issueId ?? null,
        heartbeatRunId: context?.heartbeatRunId ?? null,
        outcome: "success",
      });
    };
  }, 30_000);

  afterAll(async () => {
    vault.state.audit = undefined;
    await database?.cleanup();
    vi.unstubAllEnvs();
  }, 60_000);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const messageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Lock order", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "A", status: "active", membershipRole: "member",
    });
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorUserId: "A", body: "Next step" });
    await initializeRunIdentity(db, { companyId, runId, responsibleUserId: "A", cause: "instruction" });
    return { companyId, agentId, runId, issueId, messageId };
  }

  async function grantGitHub(input: Awaited<ReturnType<typeof seed>>) {
    const applicationId = randomUUID(), connectionId = randomUUID(), secretId = randomUUID(), definitionId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId: input.companyId, name: applicationId, type: "mcp_http" });
    await db.insert(toolConnections).values({
      id: connectionId, companyId: input.companyId, applicationId, name: connectionId, uid: connectionId,
      transport: "mcp_remote", status: "active", enabled: true, credentialPolicy: "per_user",
      config: { sourceTemplateKey: "github" },
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: input.companyId, connectionId, targetType: "agent", targetId: input.agentId,
    });
    await db.insert(userSecretDefinitions).values({ id: definitionId, companyId: input.companyId, key: definitionId, name: "GitHub" });
    await db.insert(companySecrets).values({
      id: secretId, companyId: input.companyId, key: secretId, name: `GitHub ${secretId}`,
      scope: "user", ownerUserId: "A", userSecretDefinitionId: definitionId,
    });
    await db.insert(connectionGrants).values({
      companyId: input.companyId, connectionId, kind: "user", subjectUserId: "A", status: "active",
      credentialSecretRefs: [{ secretId, configPath: "oauth.access_token", versionSelector: "latest" }],
      providerTenant: {
        github: {
          userId: "A", login: "A", installationCount: 1, repositoryCount: 1,
          repositorySelection: "selected", installationIds: ["1"], installationOwnerLogins: ["A"],
        },
      },
    });
  }

  /**
   * The shape of `documentService.upsertIssueDocument`: the revision row
   * references the run (FOR KEY SHARE on the run row) and only a later
   * statement references the task (FOR KEY SHARE on the task row).
   */
  async function holdRunThenTask(input: Awaited<ReturnType<typeof seed>>) {
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const done = db.transaction(async (tx) => {
      const [document] = await tx.insert(documents).values({
        companyId: input.companyId, format: "markdown", latestBody: "Note", latestRevisionNumber: 1,
        createdByAgentId: input.agentId,
      }).returning();
      await tx.insert(documentRevisions).values({
        companyId: input.companyId, documentId: document!.id, revisionNumber: 1, format: "markdown",
        body: "Note", createdByAgentId: input.agentId, createdByRunId: input.runId,
      });
      held();
      await gate;
      await tx.insert(issueDocuments).values({
        companyId: input.companyId, issueId: input.issueId, documentId: document!.id,
        key: `note-${randomUUID().slice(0, 8)}`,
      });
    });
    await holding;
    return { done, release };
  }

  /** Resolve once the operation settles or any backend is queued on a row lock. */
  async function untilSettledOrWaiting(operation: Promise<unknown>) {
    let settled = false;
    operation.then(() => { settled = true; }, () => { settled = true; });
    for (let attempt = 0; attempt < 150 && !settled; attempt += 1) {
      const waiting = await db.execute(sql`select 1 from pg_locks where not granted limit 1`);
      if (waiting.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("keeps the restored-backup foreign key order that checks the run before the task", async () => {
    const rows = await db.execute(sql`
      select c.conname as name
      from pg_trigger t join pg_constraint c on c.oid = t.tgconstraint
      where t.tgrelid = 'secret_access_events'::regclass
        and t.tgfoid = 'pg_catalog."RI_FKey_check_ins"'::regproc
      order by t.tgname`);
    const names = rows.map((row) => String((row as { name: unknown }).name));
    expect(names.indexOf("secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk"))
      .toBeLessThan(names.indexOf("secret_access_events_issue_id_issues_id_fk"));
  });

  type Seeded = Awaited<ReturnType<typeof seed>>;
  type Pending = NonNullable<Awaited<ReturnType<typeof reserveSteeredIdentity>>>;
  const identityOperations: Array<{
    name: string;
    pendingSteering: boolean;
    expected: string;
    run: (input: Seeded, pending: Pending | null) => Promise<unknown>;
  }> = [
    { name: "captures the identity", pendingSteering: false, expected: "ok", run: (input) => captureRunIdentity(db, input) },
    // The locked path: an unacknowledged steering message must still be refused.
    { name: "captures while steering is pending", pendingSteering: true, expected: "http 409", run: (input) => captureRunIdentity(db, input) },
    { name: "reserves a steering identity", pendingSteering: false, expected: "ok", run: (input) => reserveSteeredIdentity(db, input) },
    { name: "reconciles a steering identity", pendingSteering: true, expected: "ok", run: (_input, pending) => reconcileSteeredIdentity(db, pending!) },
  ];

  it.each(identityOperations)(
    "$name without deadlocking a writer that references the run before the task",
    async ({ pendingSteering, expected, run }) => {
      const input = await seed();
      const pending = pendingSteering ? await reserveSteeredIdentity(db, input) : null;
      const writer = await holdRunThenTask(input);
      const identity = run(input, pending);
      await untilSettledOrWaiting(identity);
      writer.release();
      const outcomes = await Promise.allSettled([writer.done, identity]);
      expect(outcomes.map(outcome)).toEqual(["ok", expected]);
    },
    15_000,
  );

  it("serves a burst of credential and runtime-tool requests for one run while the agent writes task rows", async () => {
    const input = await seed();
    await grantGitHub(input);
    const failures: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(runtimeConnectionIntentRoutes(db));
    app.use((err: unknown, _req: Request, _res: Response, next: NextFunction) => {
      failures.push(outcome({ status: "rejected", reason: err }));
      next(err);
    });
    app.use(errorHandler);
    const credentials = createRuntimeToolsToken({ ...input, responsibleUserId: "A", scope: "github_credentials" })!.token;
    const runtimeTools = createRuntimeToolsToken({ ...input, responsibleUserId: "A" })!.token;
    const docs = documentService(db);

    const work: Promise<string>[] = [];
    for (let index = 0; index < 20; index += 1) {
      work.push(request(app).post("/runtime-tools/github/credentials")
        .set("Authorization", `Bearer ${credentials}`)
        .then((response) => `credentials ${response.status} ${response.body?.status ?? ""}`.trim()));
      work.push(request(app).get("/mcp/runtime-tools")
        .set("Authorization", `Bearer ${runtimeTools}`)
        .then((response) => `runtime-tools ${response.status}`));
      work.push(docs.upsertIssueDocument({
        issueId: input.issueId, key: `note-${index}`, format: "markdown", body: "Progress note",
        createdByAgentId: input.agentId, createdByRunId: input.runId,
      }).then(() => "document ok", (error: unknown) => `document ${outcome({ status: "rejected", reason: error })}`));
    }
    const results = await Promise.all(work);

    expect(failures).toEqual([]);
    expect(results.filter((result) => !["credentials 200 available", "runtime-tools 200", "document ok"].includes(result)))
      .toEqual([]);
    const audits = await db.execute(sql`select count(*)::int as count from secret_access_events where heartbeat_run_id = ${input.runId}`);
    expect(Number((audits[0] as { count: unknown }).count)).toBe(20);
  }, 60_000);
});
