import { describe, expect, it } from "vitest";
import { compactRunLogChunk } from "../services/heartbeat.js";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[gsam truncated run log chunk:");
    expect(compacted).not.toContain("paperclip");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts GS Agentic Manager credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export GSAM_API_KEY='paperclip-shell-secret'`,
      `auth {"refresh_token":"refresh-token-fixture-secret"}`,
      `payload {"GSAM_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("refresh-token-fixture-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });

  it("stores the platform's own log tags as [gsam...]", () => {
    const chunk = [
      "[paperclip] Skipping saved session resume",
      "[paperclip-runner] transport mode=local_loopback state=connecting",
      "[paperclip-bridge] ready",
      "[paperclip-acpx-sidecar] up",
      "[paperclip selection debug] picked",
      "see skills/paperclip/SKILL.md and [paperclip-board](link)",
    ].join("\n");

    expect(compactRunLogChunk(chunk)).toBe([
      "[gsam] Skipping saved session resume",
      "[gsam-runner] transport mode=local_loopback state=connecting",
      "[gsam-bridge] ready",
      "[gsam-acpx-sidecar] up",
      "[gsam selection debug] picked",
      "see skills/paperclip/SKILL.md and [paperclip-board](link)",
    ].join("\n"));
  });
});

describe("compactRunLogChunk with long base64 commands", () => {
  it("redacts a tool call that writes base64 of source text without stalling", () => {
    const typescriptSource = "export const limit = 65536;\nexport function keep(value: string) {\n  return value.slice(0, limit);\n}\n";
    const blob = Buffer.from(typescriptSource.repeat(1_000)).toString("base64").slice(0, 48 * 1024);
    expect(blob).toMatch(/^[A-Za-z0-9]+$/);
    const command = `printf '%s' '${blob}' | base64 -d > src/keep.ts && echo '{"GITHUB_TOKEN":"tool-call-secret"}'`;
    const chunk = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: { command } }] } })}\n`;

    const startedAt = performance.now();
    const compacted = compactRunLogChunk(chunk);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(compacted).toContain(blob);
    expect(compacted).not.toContain("tool-call-secret");
    expect(compacted).toContain("***REDACTED***");
  });
});

describe("run-log invitation token privacy", () => {
  // Run logs are a plain-file diagnostic copy that every local agent (same OS
  // user) can read, so a live join link must not sit there. The chat reply the
  // person reads is built from database run events, not from this file.
  const token = "pcp_invite_FixtureInviteToken-0123456789_abcdefghijklmnopqrstu";
  const reply = `Created the invite.\n\n**Invite link:** [Join Company](http://127.0.0.1:3100/invite/${token})`;
  const toolResult = JSON.stringify({ id: "invite-1", token, inviteUrl: `/invite/${token}`,
    acceptPath: `/api/invites/${token}/accept` });

  it("redacts join-link tokens and raw invite tokens from run-log chunks", () => {
    for (const chunk of [reply, toolResult]) {
      const compacted = compactRunLogChunk(chunk);
      expect(compacted).not.toContain(token);
      expect(compacted).not.toContain("FixtureInviteToken");
    }
    expect(compactRunLogChunk(reply)).toBe(reply.replace(token, "***REDACTED***"));
    expect(JSON.parse(compactRunLogChunk(toolResult))).toEqual({ id: "invite-1", token: "***REDACTED***",
      inviteUrl: "/invite/***REDACTED***", acceptPath: "/api/invites/***REDACTED***/accept" });
  });

  it("leaves chunks without invitation tokens unchanged", () => {
    const chunk = "GET /api/companies/c1/invites returned 2 invites; see /invite for help";
    expect(compactRunLogChunk(chunk)).toBe(chunk);
  });
});
