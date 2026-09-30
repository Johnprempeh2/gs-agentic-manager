import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { classifyClaudeTerminalSessionFailure, createClaudeAcpExecutor } from "./acp.js";
import type { AcpxEngineExecutorOptions } from "@greatstone/adapter-utils/acpx-engine/execute";

const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const fixture = path.join(repoRoot, "scripts/mcp-fixtures/servers/acp-echo-agent.mjs");
const roots: string[] = [];
const now = new Date("2026-07-15T20:00:00.000Z");
// Exercise both pinned dependency patches through the same real ACP child.
const runnerRequire = createRequire(path.join(repoRoot, "packages/paperclip-runner/package.json"));
const runnerAcpx = await import(runnerRequire.resolve("acpx/runtime"));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function executeFailure(
  title: string,
  category = "limit",
  mode = "oneshot",
  createRuntime?: AcpxEngineExecutorOptions["createRuntime"],
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-acp-quota-"));
  roots.push(root);
  const logs: string[] = [];
  const execute = createClaudeAcpExecutor({ now: () => now.getTime(), createRuntime });
  const result = await execute({
    runId: "typed-quota",
    agent: { id: "quota-agent", companyId: "quota-company" },
    runtime: {},
    config: {
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixture.replaceAll("\\", "/"))}`,
      mode,
      warmHandleIdleMs: 0,
      cwd: repoRoot,
      stateDir: path.join(root, "state"),
      env: {
        GSAM_ACPX_TYPED_FAILURE_CANARY: title,
        GSAM_ACPX_TYPED_FAILURE_CATEGORY: category,
      },
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never);
  return { result, logs: logs.join("\n") };
}

it.each([
  ["0.12.0", "oneshot"],
  ["0.12.0", "persistent"],
  ["0.13.1", "oneshot"],
  ["0.13.1", "persistent"],
])("waits for a typed Claude quota reset with ACPX %s in %s mode without exposing provider text", async (version, mode) => {
  const title = "You've hit your session limit · resets 4:30pm (America/Chicago)";
  const { result, logs } = await executeFailure(
    title, "limit", mode, version === "0.13.1" ? runnerAcpx.createAcpRuntime : undefined,
  );
  expect(result).toMatchObject({
    exitCode: 1,
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    retryNotBefore: "2026-07-15T21:30:00.000Z",
    resultJson: {
      errorFamily: "provider_quota",
      retryNotBefore: "2026-07-15T21:30:00.000Z",
      providerQuotaRetryNotBefore: "2026-07-15T21:30:00.000Z",
    },
  });
  expect(JSON.stringify(result)).not.toContain(title);
  expect(logs).not.toContain(title);
});

it("classifies quota without a reset time for the existing recovery backoff", async () => {
  const { result } = await executeFailure("You've hit your weekly limit");
  expect(result).toMatchObject({ errorCode: "provider_quota", errorFamily: "provider_quota" });
  expect(result.retryNotBefore).toBeUndefined();
});

it.each([
  ["0.12.0", "oneshot"],
  ["0.12.0", "persistent"],
  ["0.13.1", "oneshot"],
  ["0.13.1", "persistent"],
])("recognizes the Claude bridge quota fallback with ACPX %s in %s mode", async (version, mode) => {
  // @agentclientprotocol/claude-agent-acp's quota_exhausted fallback title.
  const title = "The Claude account has no available quota.";
  const { result, logs } = await executeFailure(
    title, "limit", mode, version === "0.13.1" ? runnerAcpx.createAcpRuntime : undefined,
  );
  expect(result).toMatchObject({
    exitCode: 1,
    errorMessage: "ACP agent reported a terminal limit failure.",
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    resultJson: { errorFamily: "provider_quota" },
  });
  expect(result.retryNotBefore).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(title);
  expect(logs).not.toContain(title);
});

it.each([
  ["Context window limit exceeded", "limit"],
  ["Maximum number of turns reached", "limit"],
  ["Configured budget limit reached", "limit"],
  ["Rate limit exceeded; retry later", "limit"],
  ["You've hit your session limit", "request"],
  ["The Claude account has no available quota.", "request"],
  ["The Claude account has available quota.", "limit"],
  ["The worker connection closed", "connection"],
])("keeps a non-quota typed failure out of quota recovery: %s", async (title, category) => {
  const { result, logs } = await executeFailure(title, category);
  expect(result).toMatchObject({ exitCode: 1, errorCode: "acpx_turn_failed" });
  expect(result.errorFamily).not.toBe("provider_quota");
  expect(result.retryNotBefore).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(title);
  expect(logs).not.toContain(title);
});

it("does not infer quota from the historical generic terminal-limit error", () => {
  expect(classifyClaudeTerminalSessionFailure({
    category: "limit",
    title: "ACP agent reported a terminal limit failure.",
  }, now)).toBeNull();
});

// GRE-15: an expired imported Claude token surfaced as "ACP agent reported a
// terminal access failure." coded `acpx_turn_failed`, so recovery retried it as
// transient until the task went to `blocked`.
it.each([
  ["0.12.0", "oneshot"],
  ["0.12.0", "persistent"],
  ["0.13.1", "oneshot"],
  ["0.13.1", "persistent"],
])("reports a typed Claude access failure as login required with ACPX %s in %s mode", async (version, mode) => {
  const title = "OAuth token has expired. Please obtain a new token or refresh your existing token.";
  const { result, logs } = await executeFailure(
    title, "access", mode, version === "0.13.1" ? runnerAcpx.createAcpRuntime : undefined,
  );
  expect(result).toMatchObject({
    exitCode: 1,
    errorMessage: "ACP agent reported a terminal access failure.",
    errorCode: "claude_auth_required",
  });
  expect(result.errorFamily).toBeUndefined();
  expect(result.retryNotBefore).toBeUndefined();
  // GRE-236: the run keeps the provider's own (redacted) reason so an operator
  // can tell a dead token from another refusal; the run log still does not.
  expect(result.resultJson).toMatchObject({ providerReason: title });
  expect(logs).not.toContain(title);
});

// GRE-236: the provider reason is redacted and bounded before it reaches the run.
it("redacts credentials and bounds the provider reason of an access failure", () => {
  const token = "sk-ant-oat01-" + "a".repeat(40);
  const result = classifyClaudeTerminalSessionFailure({
    category: "access",
    title: "Invalid bearer token",
    details: `Authorization: Bearer ${token}\n${"x".repeat(500)}`,
  }, now);
  expect(result?.errorCode).toBe("claude_auth_required");
  expect(result?.providerReason).toMatch(/^Invalid bearer token - /);
  expect(result?.providerReason).not.toContain(token);
  expect(result?.providerReason).not.toContain("\n");
  expect(result?.providerReason?.length).toBeLessThanOrEqual(300);
});
