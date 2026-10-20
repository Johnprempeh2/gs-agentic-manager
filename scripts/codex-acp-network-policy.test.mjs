import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path6 from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

const require = createRequire(new URL("../packages/paperclip-runner/package.json", import.meta.url));
const source = readFileSync(require.resolve("@agentclientprotocol/codex-acp"), "utf8");
const helperStart = source.indexOf("function paperclipSandboxPolicy(");
const helperEnd = source.indexOf("\nvar CodexAcpClient", helperStart);
const methodStart = source.indexOf("  async sendPrompt(");
const methodEnd = source.indexOf("\n  async runAgentFileChangeReport", methodStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "installed Codex ACP must contain the network policy patch");
assert.ok(methodStart >= 0 && methodEnd > methodStart, "installed Codex ACP must expose the patched turn boundary");

async function turnPolicy(policy, env) {
  const context = {
    process: { env },
    path6,
    buildPromptItems: (prompt) => prompt,
    addAdditionalDirectoriesToSandboxPolicy: (value) => value,
  };
  const client = runInNewContext(
    source.slice(helperStart, helperEnd) + "\n({" + source.slice(methodStart, methodEnd) + "})",
    context,
  );
  client.refreshSkills = async () => {};
  client.codexClient = { runTurn: async (params) => params };
  return client.sendPrompt(
    { sessionId: "fresh-or-resumed-thread", prompt: [] },
    { approvalPolicy: "on-request", sandboxPolicy: policy },
    { model: "test-model", effort: "low" },
    null, false, "/workspace", [], undefined, undefined,
  );
}

test("ACP forwards workspace networking to the actual Codex turn without changing confinement", async () => {
  const policy = { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: false };
  const result = await turnPolicy(policy, { GSAM_CODEX_ACP_NETWORK_ACCESS: "true" });
  assert.equal(result.sandboxPolicy.networkAccess, true);
  assert.equal(result.sandboxPolicy.type, "workspaceWrite");
  assert.equal(result.sandboxPolicy.writableRoots, policy.writableRoots);
  assert.equal(result.approvalPolicy, "on-request");
  assert.equal(policy.networkAccess, false, "must not mutate the shared mode preset");
});

test("ACP preserves operator and execution-target network denials", async () => {
  const policy = { type: "workspaceWrite", networkAccess: true };
  for (const env of [
    { GSAM_CODEX_ACP_NETWORK_ACCESS: "false" },
    { GSAM_CODEX_ACP_NETWORK_ACCESS: "true", GSAM_RUNNER_NETWORK_ACCESS: "disabled" },
  ]) {
    assert.equal((await turnPolicy(policy, env)).sandboxPolicy.networkAccess, false);
  }
});

test("ACP leaves other sandbox modes and callers without a valid override unchanged", async () => {
  for (const policy of [{ type: "readOnly", networkAccess: false }, { type: "dangerFullAccess" }]) {
    assert.equal((await turnPolicy(policy, { GSAM_CODEX_ACP_NETWORK_ACCESS: "true" })).sandboxPolicy, policy);
  }
  const policy = { type: "workspaceWrite", networkAccess: false };
  for (const value of [undefined, "", "1", "invalid"]) {
    assert.equal((await turnPolicy(policy, { GSAM_CODEX_ACP_NETWORK_ACCESS: value })).sandboxPolicy, policy);
  }
});

// GRE-1725: Codex keeps `.git` under every writable root read-only, so
// `git fetch` failed on FETCH_HEAD in the run's own bound repo.
test("ACP makes the bound repo's Git metadata writable inside the workspace root", async () => {
  const policy = { type: "workspaceWrite", writableRoots: [], networkAccess: false };
  const env = {
    GSAM_CODEX_ACP_NETWORK_ACCESS: "true",
    GSAM_GIT_METADATA_ROOTS: JSON.stringify(["/workspace/.git", "/repo/.git/worktrees/run", "/workspace/.git"]),
  };
  const result = await turnPolicy(policy, env);
  assert.deepEqual([...result.sandboxPolicy.writableRoots], ["/workspace/.git", "/repo/.git/worktrees/run"]);
  assert.equal(result.sandboxPolicy.networkAccess, true);
  assert.deepEqual(policy.writableRoots, [], "must not mutate the shared mode preset");
});

test("ACP grants no other Git roots and ignores unsafe or malformed projections", async () => {
  const policy = { type: "workspaceWrite", writableRoots: ["/extra"], networkAccess: false };
  for (const roots of [undefined, "", "not-json", "{}", '["relative/.git", "/", 7]']) {
    assert.equal((await turnPolicy(policy, { GSAM_GIT_METADATA_ROOTS: roots })).sandboxPolicy, policy);
  }
  for (const other of [{ type: "readOnly" }, { type: "dangerFullAccess" }]) {
    assert.equal((await turnPolicy(other, { GSAM_GIT_METADATA_ROOTS: '["/workspace/.git"]' })).sandboxPolicy, other);
  }
});
