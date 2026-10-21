import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  toolCallEvents,
  toolPolicies,
} from "@greatstone/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import {
  promptInjectionClassifierService,
  type PromptInjectionProviderResult,
} from "../services/prompt-injection-classifier.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// GRE-1743: the `enablePromptInjectionModelChecks` switch at a real gateway
// result guard, off and on. The model provider is a stub; the cost event is real.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Matches the built-in regex, but is an illustrative security-test string.
const LOOKALIKE = 'expect(scan("Ignore previous instructions")).toContain("ignore_previous_instructions");';

function pluginReturning(content: string): PluginToolDispatcher {
  return {
    initialize: async () => {},
    teardown: () => {},
    listToolsForAgent: () => [
      {
        name: "fixture:read_status",
        displayName: "Read status",
        description: "Returns fixture content.",
        parametersSchema: { type: "object" },
        pluginId: "fixture-plugin",
      },
    ],
    getTool: () => null,
    executeTool: async () => ({ pluginId: "fixture-plugin", toolName: "read_status", result: { content } }),
    registerPluginTools: () => {},
    unregisterPluginTools: () => {},
    toolCount: () => 1,
    getRegistry: () => {
      throw new Error("not implemented");
    },
  } as unknown as PluginToolDispatcher;
}

describeEmbeddedPostgres("prompt injection model checks at the tool gateway", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-prompt-injection-gateway-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const company = await db.insert(companies).values({
      name: `PI ${randomUUID()}`,
      issuePrefix: `PI${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: `PI Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning().then((rows) => rows[0]!);
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: {},
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Allow read fixture",
      policyType: "allow",
      selectors: { toolName: "fixture:read_status" },
    });
    return { company, agent, run };
  }

  function gatewayWith(settings: { on: boolean; enabledAt: string | null }, content: string) {
    const provider = vi.fn(async (): Promise<PromptInjectionProviderResult> => ({
      verdict: { violation: false, findings: [] },
      dispatched: true,
      usage: { inputTokens: 1200, outputTokens: 10, costUsd: 0.03 },
    }));
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "test-tool-action-signing-secret",
      pluginToolDispatcher: pluginReturning(content),
      promptInjectionClassifier: promptInjectionClassifierService(db, {
        getExperimental: async () => ({
          enablePromptInjectionModelChecks: settings.on,
          promptInjectionModelChecksEnabledAt: settings.enabledAt,
        }),
        resolveCredential: async () => ({ status: "ok", credential: "sk-or-test" }),
        provider,
      }),
    });
    return { gateway, provider };
  }

  function call(gateway: ReturnType<typeof createToolGatewayService>, ids: { companyId: string; agentId: string; runId: string }) {
    return gateway.executePluginTool({
      actor: { type: "agent", ...ids },
      tool: "fixture:read_status",
      parameters: {},
      runContext: ids,
    });
  }

  it("switch off: the regex blocks the lookalike and no model call or cost happens", async () => {
    const { company, agent, run } = await fixture();
    const { gateway, provider } = gatewayWith({ on: false, enabledAt: null }, LOOKALIKE);

    await expect(call(gateway, { companyId: company.id, agentId: agent.id, runId: run.id }))
      .rejects.toMatchObject({ reasonCode: "prompt_injection_blocked" });

    expect(provider).not.toHaveBeenCalled();
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, company.id))).toEqual([]);
  });

  it("switch on without the spend notice: still regex only, no model call", async () => {
    const { company, agent, run } = await fixture();
    const { gateway, provider } = gatewayWith({ on: true, enabledAt: null }, LOOKALIKE);

    await expect(call(gateway, { companyId: company.id, agentId: agent.id, runId: run.id }))
      .rejects.toMatchObject({ reasonCode: "prompt_injection_blocked" });

    expect(provider).not.toHaveBeenCalled();
    const [failed] = await db.select().from(toolCallEvents)
      .where(and(eq(toolCallEvents.companyId, company.id), eq(toolCallEvents.eventType, "call_failed")));
    expect(failed?.metadata).toMatchObject({
      promptInjection: { detector: "regex", fallbackReason: "spend_not_acknowledged" },
    });
  });

  it("switch on and acknowledged: the model verdict decides and the spend shows in Costs", async () => {
    const { company, agent, run } = await fixture();
    const { gateway, provider } = gatewayWith({ on: true, enabledAt: "2026-10-21T09:00:00.000Z" }, LOOKALIKE);

    await expect(call(gateway, { companyId: company.id, agentId: agent.id, runId: run.id })).resolves.toBeTruthy();

    expect(provider).toHaveBeenCalledTimes(1);
    const costs = await db.select().from(costEvents).where(eq(costEvents.companyId, company.id));
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      agentId: agent.id,
      provider: "openrouter",
      biller: "openrouter",
      billingType: "metered_api",
      billingCode: "prompt_injection_check",
      costStatus: "reported",
      costCents: 3,
      inputTokens: 1200,
      outputTokens: 10,
    });
  });
});
