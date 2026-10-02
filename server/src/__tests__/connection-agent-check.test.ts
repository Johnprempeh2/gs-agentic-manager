import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  toolAccessAuditEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolInvocations,
  toolPolicies,
  toolProfileBindings,
  toolProfiles,
  toolStdioCommandTemplates,
} from "@greatstone/db";
import { HttpError } from "../errors.js";
import { classifyAgentCheckFailure, connectionAgentCheckService } from "../services/connection-agent-check.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService, ToolGatewayHttpError } from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("classifyAgentCheckFailure", () => {
  it("names the reason an operator can act on", () => {
    expect(classifyAgentCheckFailure(new ToolGatewayHttpError(409, "x", "agent_authorization_required")).reason).toBe("no_grant");
    expect(classifyAgentCheckFailure(new ToolGatewayHttpError(409, "x", "user_authorization_required")).reason).toBe("no_grant");
    expect(classifyAgentCheckFailure(new HttpError(422, "x", { code: "oauth_reauthorization_required" })).reason).toBe("expired_token");
    expect(classifyAgentCheckFailure(new HttpError(422, "x", { code: "oauth_challenge" })).reason).toBe("expired_token");
    expect(classifyAgentCheckFailure(new HttpError(502, "x", { code: "paperclip_error", upstreamStatus: 401 })).reason).toBe("expired_token");
    expect(classifyAgentCheckFailure(new HttpError(502, "x", { code: "paperclip_error", upstreamStatus: 403 })).reason).toBe("scope_missing");
    expect(classifyAgentCheckFailure(new HttpError(422, "x", { code: "slack_mcp_access_disabled" })).reason).toBe("scope_missing");
    expect(classifyAgentCheckFailure(new HttpError(502, "x", { code: "paperclip_error", upstreamStatus: 500 })).reason).toBe("service_error");
    expect(classifyAgentCheckFailure(new Error("socket hang up")).reason).toBe("service_error");
  });
});

describeEmbeddedPostgres("connection agent check (GRE-341)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-connection-agent-check-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolInvocations);
    await db.delete(toolCatalogEntries);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(toolStdioCommandTemplates);
    await db.delete(toolPolicies);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture(input: {
    credentialPolicy?: "shared" | "per_agent";
    upstream?: (method: string) => Response;
    /** Make the connection local_stdio; the template reads env.API_KEY. */
    stdio?: { grantSecretRefs: Array<{ secretId: string; configPath: string }> };
  } = {}) {
    const company = await db.insert(companies).values({
      name: `Agent check ${randomUUID()}`,
      issuePrefix: `AC${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: "operator-user", status: "active", membershipRole: "member",
    });
    const makeAgent = (name: string) => db.insert(agents).values({
      companyId: company.id,
      name,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning().then((rows) => rows[0]!);
    const agent = await makeAgent("Granted agent");
    const otherAgent = await makeAgent("Other agent");
    const application = await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: `remote-${randomUUID().slice(0, 8)}`,
      name: "Remote MCP",
      type: "mcp_http",
      status: "active",
    }).returning().then((rows) => rows[0]!);
    const credentialPolicy = input.credentialPolicy ?? "shared";
    const templateKey = `stdio-${randomUUID().slice(0, 8)}`;
    if (input.stdio) {
      await db.insert(toolStdioCommandTemplates).values({
        companyId: company.id,
        templateKey,
        name: "Stdio app",
        command: "/bin/false",
        envKeys: ["API_KEY"],
      });
    }
    const connection = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Remote connection",
      uid: `test/${randomUUID()}`,
      transport: input.stdio ? "local_stdio" : "mcp_remote",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      credentialPolicy,
      config: input.stdio ? { templateId: templateKey } : { url: "https://8.8.8.8/mcp" },
    }).returning().then((rows) => rows[0]!);
    const credentialSecretRefs = input.stdio?.grantSecretRefs ?? [];
    await db.insert(connectionGrants).values(credentialPolicy === "per_agent"
      ? { companyId: company.id, connectionId: connection.id, kind: "agent", subjectAgentId: agent.id, credentialSecretRefs, status: "active" }
      : { companyId: company.id, connectionId: connection.id, kind: "organization", credentialSecretRefs, status: "active", isDefault: true });
    await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      entryKind: "tool",
      name: "list_notes",
      toolName: "list_notes",
      title: "List notes",
      riskLevel: "read",
      isReadOnly: true,
      status: "active",
      versionHash: randomUUID(),
      schemaHash: randomUUID(),
    });
    // Every agent in the company may use the app's actions, so a failure below
    // comes from the grant or the app, not the tool profile.
    const profile = await db.insert(toolProfiles).values({
      companyId: company.id,
      profileKey: `agent-check-${randomUUID()}`,
      name: "Allow all",
      defaultAction: "allow",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({
      companyId: company.id,
      profileId: profile.id,
      targetType: "company",
      targetId: company.id,
    });

    const methods: string[] = [];
    const remoteHttpRequest = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body ?? "{}")) as { id?: string; method: string };
      methods.push(body.method);
      return input.upstream?.(body.method) ?? new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const toolAccess = toolAccessService(db, { remoteHttpRequest });
    const toolGateway = createToolGatewayService(db, {
      toolActionSigningSecret: "agent-check-test-signing-secret",
      remoteHttpRequest,
    });
    const check = (agentId: string) => connectionAgentCheckService({ toolAccess, toolGateway }).check({
      companyId: company.id,
      connectionId: connection.id,
      agentId,
      userId: "operator-user",
      actor: { actorType: "user", actorId: "operator-user" },
    });
    return { company, agent, otherAgent, connection, methods, check };
  }

  async function connectionHealth(connectionId: string) {
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    return { healthStatus: row!.healthStatus, healthCheckedAt: row!.healthCheckedAt };
  }

  it("passes with one read-only tools/list and starts no run", async () => {
    const f = await fixture();
    const before = await connectionHealth(f.connection.id);

    const result = await f.check(f.agent.id);

    expect(result).toMatchObject({ ok: true, reason: null, grantKind: "organization", access: { toolCount: 1, allowedCount: 1 } });
    expect(f.methods.filter((method) => method !== "initialize" && method !== "notifications/initialized")).toEqual(["tools/list"]);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(toolInvocations)).toHaveLength(0);
    expect(await connectionHealth(f.connection.id)).toEqual(before);
  });

  it("uses the chosen agent's grant, not the operator's", async () => {
    const f = await fixture({ credentialPolicy: "per_agent" });

    expect(await f.check(f.agent.id)).toMatchObject({ ok: true, grantKind: "agent" });
    const other = await f.check(f.otherAgent.id);
    expect(other).toMatchObject({ ok: false, reason: "no_grant", code: "agent_authorization_required", grantKind: null });
    expect(other.message).toMatch(/^No grant: /);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });

  it("reports no_access when the agent's policies turn every action off, without calling the app", async () => {
    const f = await fixture();
    await db.insert(toolPolicies).values({
      companyId: f.company.id,
      name: "Block this app",
      policyType: "block",
      selectors: { connectionId: f.connection.id },
      priority: 1,
    });

    const result = await f.check(f.agent.id);

    expect(result).toMatchObject({ ok: false, reason: "no_access", access: { toolCount: 1, allowedCount: 0, offCount: 1 } });
    expect(f.methods).toEqual([]);
  });

  it.each([
    [401, "expired_token"],
    [403, "scope_missing"],
    [500, "service_error"],
  ] as const)("maps an upstream %i to %s and does not mark the shared connection unhealthy", async (status, reason) => {
    const f = await fixture({ upstream: () => new Response("nope", { status }) });
    const before = await connectionHealth(f.connection.id);

    const result = await f.check(f.agent.id);

    expect(result).toMatchObject({ ok: false, reason, grantKind: "organization" });
    expect(await connectionHealth(f.connection.id)).toEqual(before);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });

  it("fails a local_stdio check when the grant's env secret is missing, without starting the app (GRE-350)", async () => {
    const f = await fixture({ stdio: { grantSecretRefs: [{ secretId: randomUUID(), configPath: "env.API_KEY" }] } });
    const before = await connectionHealth(f.connection.id);

    const result = await f.check(f.agent.id);

    expect(result).toMatchObject({ ok: false, reason: "expired_token", code: "local_stdio_missing_secret", grantKind: null });
    expect(await connectionHealth(f.connection.id)).toEqual(before);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("says a passing local_stdio check did not start the app", async () => {
    const f = await fixture({ stdio: { grantSecretRefs: [] } });

    const result = await f.check(f.agent.id);

    expect(result).toMatchObject({ ok: true, grantKind: "organization" });
    expect(result.message).toMatch(/the app was not started/);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });
});
