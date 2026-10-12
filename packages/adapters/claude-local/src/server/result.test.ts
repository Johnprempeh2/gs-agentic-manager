import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCapturedOutputFile } from "@greatstone/adapter-utils/server-utils";
import {
  CLAUDE_RECOVERY_CONTEXT_KIND,
  recoverClaudeResultFromOutput,
  type ClaudeRecoveryContext,
} from "./result.js";

const SESSION_ID = "0b6f1c1e-2a8d-4b5e-9c3f-1d2e3f4a5b6c";

const recoveryContext: ClaudeRecoveryContext = {
  kind: CLAUDE_RECOVERY_CONTEXT_KIND,
  timeoutSec: 0,
  cwd: "/work/repo",
  promptBundleKey: "bundle-1",
  mcpServerIdentity: "[]",
  remoteExecutionIdentity: null,
  workspaceId: "ws-1",
  workspaceRepoUrl: null,
  workspaceRepoRef: null,
  biller: "anthropic",
  model: "claude-opus-5-5",
  billingType: "subscription",
  fallbackSessionId: null,
  clearSessionOnMissingSession: false,
};

const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`;
const init = line({ type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-opus-5-5" });
const assistant = (text: string) =>
  line({ type: "assistant", message: { content: [{ type: "text", text }] } });

describe("recoverClaudeResultFromOutput", () => {
  it("rebuilds a successful result, with usage and the session to resume", () => {
    const stdout =
      init +
      assistant("working") +
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: SESSION_ID,
        result: "All done.",
        total_cost_usd: 0.42,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
      });
    const result = recoverClaudeResultFromOutput({
      stdout,
      stderr: "",
      recoveryContext: recoveryContext as unknown as Record<string, unknown>,
    });
    expect(result).not.toBeNull();
    expect(result!.errorMessage).toBeNull();
    expect(result!.exitCode).toBeNull();
    expect(result!.summary).toBe("All done.");
    expect(result!.costUsd).toBe(0.42);
    expect(result!.sessionId).toBe(SESSION_ID);
    expect(result!.sessionParams).toMatchObject({
      sessionId: SESSION_ID,
      cwd: "/work/repo",
      promptBundleKey: "bundle-1",
      workspaceId: "ws-1",
    });
  });

  it("rebuilds a failed result from an is_error result event", () => {
    const stdout =
      init +
      line({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: SESSION_ID,
        result: "Tool crashed",
      });
    const result = recoverClaudeResultFromOutput({
      stdout,
      stderr: "",
      recoveryContext: recoveryContext as unknown as Record<string, unknown>,
    });
    expect(result).not.toBeNull();
    expect(result!.errorMessage).toBeTruthy();
    expect(result!.sessionId).toBe(SESSION_ID);
  });

  it("returns null when there is no terminal result event", () => {
    expect(
      recoverClaudeResultFromOutput({
        stdout: init + assistant("still going"),
        stderr: "",
        recoveryContext: recoveryContext as unknown as Record<string, unknown>,
      }),
    ).toBeNull();
  });

  it("returns null without a claude recovery context", () => {
    expect(
      recoverClaudeResultFromOutput({
        stdout: init + line({ type: "result", subtype: "success", is_error: false }),
        stderr: "",
        recoveryContext: null,
      }),
    ).toBeNull();
  });

  it("keeps the session id from the head of a file too large to read whole", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-recover-"));
    try {
      const file = path.join(dir, "run.stdout");
      const filler = Array.from({ length: 4000 }, (_, i) => assistant(`step ${i}`)).join("");
      // The result event has no session_id, so only the init event names it.
      await fs.writeFile(
        file,
        init + filler + line({ type: "result", subtype: "success", is_error: false, result: "ok" }),
      );
      const read = await readCapturedOutputFile(file, { headBytes: 4096, tailBytes: 8192 });
      expect(read?.truncated).toBe(true);
      const result = recoverClaudeResultFromOutput({
        stdout: read!.text,
        stderr: "",
        recoveryContext: recoveryContext as unknown as Record<string, unknown>,
      });
      expect(result?.sessionId).toBe(SESSION_ID);
      expect(result?.summary).toBe("ok");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
