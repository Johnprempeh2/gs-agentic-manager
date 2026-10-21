import { describe, expect, it, vi } from "vitest";
import type { Db } from "@greatstone/db";
import {
  promptInjectionClassifierService,
  promptInjectionRequestBody,
  runPromptInjectionProvider,
  type PromptInjectionCheckContext,
  type PromptInjectionProviderResult,
} from "../services/prompt-injection-classifier.js";

// GRE-1743: the gate order in front of every paid model call.
const db = {} as Db;
const ctx: PromptInjectionCheckContext = {
  companyId: "company-1",
  agentId: "agent-1",
  responsibleUserId: "user-1",
  issueId: null,
  projectId: null,
  toolName: "fixture:read",
  toolType: "paperclip_plugin",
};
const safe: PromptInjectionProviderResult = {
  verdict: { violation: false, findings: [] },
  dispatched: true,
  usage: { inputTokens: 900, outputTokens: 12, costUsd: 0.0004 },
};

function setup(settings: { on: boolean; enabledAt: string | null }, provider = vi.fn(async () => safe)) {
  const recordCost = vi.fn(async () => "cost-1");
  const resolveCredential = vi.fn(async () => ({ status: "ok" as const, credential: "sk-or-test" }));
  const service = promptInjectionClassifierService(db, {
    getExperimental: async () => ({
      enablePromptInjectionModelChecks: settings.on,
      promptInjectionModelChecksEnabledAt: settings.enabledAt,
    }),
    resolveCredential,
    provider,
    recordCost,
  });
  return { service, provider, recordCost, resolveCredential };
}

describe("prompt injection classifier gates", () => {
  it("switch off: no classifier, so no model call and no spend", async () => {
    const { service, provider, recordCost } = setup({ on: false, enabledAt: "2026-10-21T00:00:00.000Z" });
    expect(await service.forToolResult(ctx)).toBeUndefined();
    expect(provider).not.toHaveBeenCalled();
    expect(recordCost).not.toHaveBeenCalled();
  });

  it("switch on without the Settings spend notice (e.g. managed config): falls back before any call", async () => {
    const { service, provider, resolveCredential } = setup({ on: true, enabledAt: null });
    const classify = await service.forToolResult(ctx);
    expect(await classify!("content")).toEqual({ status: "unavailable", reason: "spend_not_acknowledged" });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("switch on with no agent to own the cost: falls back before any call", async () => {
    const { service, provider } = setup({ on: true, enabledAt: "2026-10-21T00:00:00.000Z" });
    const classify = await service.forToolResult({ ...ctx, agentId: null });
    expect(await classify!("content")).toEqual({ status: "unavailable", reason: "no_cost_owner" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("switch on and acknowledged: calls the model once and records the cost", async () => {
    const { service, provider, recordCost } = setup({ on: true, enabledAt: "2026-10-21T00:00:00.000Z" });
    const classify = await service.forToolResult(ctx);
    const outcome = await classify!("content");
    expect(provider).toHaveBeenCalledTimes(1);
    expect(recordCost).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "company-1", agentId: "agent-1" }),
      expect.objectContaining({ result: safe }),
    );
    expect(outcome).toMatchObject({ status: "classified", violation: false, costEventId: "cost-1" });
  });

  it("records no cost when the provider rejected the request unbilled", async () => {
    const rejected = vi.fn(async (): Promise<PromptInjectionProviderResult> => ({
      errorCode: "provider_auth_failed", dispatched: false, usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    }));
    const { service, recordCost } = setup({ on: true, enabledAt: "2026-10-21T00:00:00.000Z" }, rejected);
    const outcome = await (await service.forToolResult(ctx))!("content");
    expect(recordCost).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "failed", reason: "provider_auth_failed" });
  });

  it("records an uncertain (timed-out) call so the spend is never silent", async () => {
    const timedOut = vi.fn(async (): Promise<PromptInjectionProviderResult> => ({
      errorCode: "timeout", dispatched: true, usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    }));
    const { service, recordCost } = setup({ on: true, enabledAt: "2026-10-21T00:00:00.000Z" }, timedOut);
    const outcome = await (await service.forToolResult(ctx))!("content");
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "failed", reason: "timeout", costEventId: "cost-1" });
  });

  it("falls back when no shared OpenRouter connection is set up", async () => {
    const provider = vi.fn(async () => safe);
    const service = promptInjectionClassifierService(db, {
      getExperimental: async () => ({ enablePromptInjectionModelChecks: true, promptInjectionModelChecksEnabledAt: "2026-10-21T00:00:00.000Z" }),
      resolveCredential: async () => ({ status: "unavailable", reason: "not_configured" }),
      provider,
    });
    expect(await (await service.forToolResult(ctx))!("content")).toEqual({ status: "unavailable", reason: "not_configured" });
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("OpenRouter provider call", () => {
  const body = promptInjectionRequestBody("hello", { name: "t", type: "x" }, "openai/gpt-oss-safeguard-20b");

  it("parses the verdict and reported usage", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: '{"violation":true,"findings":["secret_exfiltration"]}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 9, cost: 0.00002 },
    }), { status: 200 }));
    const result = await runPromptInjectionProvider({ credential: "sk", body }, { fetch });
    expect(result).toEqual({
      verdict: { violation: true, findings: ["secret_exfiltration"] },
      dispatched: true,
      usage: { inputTokens: 100, outputTokens: 9, costUsd: 0.00002 },
    });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("error");
  });

  it("treats a verdict that disagrees with its findings as invalid output", async () => {
    const fetch = async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: '{"violation":false,"findings":["instruction_hijack"]}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 });
    const result = await runPromptInjectionProvider({ credential: "sk", body }, { fetch });
    expect(result).toMatchObject({ errorCode: "invalid_output", dispatched: true, usage: { costUsd: null } });
  });

  it("marks a 401 as unbilled and a 500 as possibly billed", async () => {
    const at = (status: number) => async () => new Response("{}", { status });
    expect(await runPromptInjectionProvider({ credential: "sk", body }, { fetch: at(401) }))
      .toMatchObject({ errorCode: "provider_auth_failed", dispatched: false });
    expect(await runPromptInjectionProvider({ credential: "sk", body }, { fetch: at(500) }))
      .toMatchObject({ errorCode: "provider_failed", dispatched: true });
  });

  it("refuses an oversized request without calling the provider", async () => {
    const fetch = vi.fn();
    const big = promptInjectionRequestBody("x".repeat(300 * 1024), { name: "t", type: "x" }, "m");
    expect(await runPromptInjectionProvider({ credential: "sk", body: big }, { fetch }))
      .toMatchObject({ errorCode: "input_too_large", dispatched: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
