// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/access.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AI_ROUTE, aiRouteCheck, boardApprovalCheck, parseAiRoute, parseBoardApproval } from "./access.js";

test("the AI route defaults to claude_api_key (GRE-142)", () => {
  assert.equal(DEFAULT_AI_ROUTE, "claude_api_key");
  assert.equal(parseAiRoute(undefined), "claude_api_key");
});

test("every app route is accepted; anything else is refused", () => {
  for (const route of ["claude_api_key", "claude_subscription", "codex_api_key", "codex_subscription"]) {
    assert.equal(parseAiRoute(route), route);
  }
  assert.throws(() => parseAiRoute("gemini"), /--ai-route must be one of/);
  assert.throws(() => parseAiRoute(""), /--ai-route must be one of/);
});

test("board approval is on unless off is asked for", () => {
  assert.equal(parseBoardApproval(undefined), true);
  assert.equal(parseBoardApproval("on"), true);
  assert.equal(parseBoardApproval("off"), false);
  assert.throws(() => parseBoardApproval("yes"), /on or off/);
});

test("verify passes only when the server has the stored route", () => {
  assert.equal(aiRouteCheck("claude_api_key", { aiAccessRoute: "claude_api_key" }).ok, true);
  assert.equal(aiRouteCheck("claude_api_key", {}).ok, false);
  assert.equal(aiRouteCheck("claude_api_key", { aiAccessRoute: "codex_api_key" }).ok, false);
  const none = aiRouteCheck(undefined, { aiAccessRoute: "claude_api_key" });
  assert.equal(none.ok, false);
  assert.match(none.line, /set one with ai-route/);
});

test("verify passes only when the company flag matches (absent in state means on)", () => {
  assert.equal(boardApprovalCheck(true, { requireBoardApprovalForNewAgents: true }).ok, true);
  assert.equal(boardApprovalCheck(undefined, { requireBoardApprovalForNewAgents: true }).ok, true);
  assert.equal(boardApprovalCheck(undefined, { requireBoardApprovalForNewAgents: false }).ok, false);
  assert.equal(boardApprovalCheck(true, {}).ok, false);
  assert.equal(boardApprovalCheck(false, { requireBoardApprovalForNewAgents: false }).ok, true);
  assert.match(boardApprovalCheck(true, { requireBoardApprovalForNewAgents: false }).line, /company has off/);
});
