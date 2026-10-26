// node --test scripts/shared-memory/shared-memory.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { claudeTurns, codexTurns, isTrivialTurn } from "./extract.mjs";
import { run, syncHandoff, tailnetUrlProblem } from "./gs-memory-sync.mjs";
import { isNeverStoreFile, redact } from "./redact.mjs";

// Fake secrets are built at run time so no secret-shaped literal sits in the repo.
const rep = (char, n) => char.repeat(n);
const mixed = (n) => "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zC".repeat(4).slice(0, n);

describe("redaction before retain: one test per pattern", () => {
  const cases = [
    ["anthropic_key", `key sk-ant-api03-${mixed(40)} here`],
    ["openai_key", `OPENAI sk-proj-${mixed(40)}`],
    ["google_api_key", `AIza${mixed(35)}`],
    ["aws_access_key", `AKIA${rep("Q", 16)}`],
    ["github_token", `ghp_${mixed(36)}`],
    ["github_token", `github_pat_${mixed(30)}_${mixed(40)}`],
    ["gitlab_token", `glpat-${mixed(20)}`],
    ["npm_token", `npm_${mixed(36)}`],
    ["slack_token", `xoxb-${"1234567890"}-${mixed(20)}`],
    ["slack_webhook", `https://hooks.slack.com/services/T000/B000/${mixed(24)}`],
    ["stripe_key", `sk_live_${mixed(24)}`],
    ["stripe_webhook_secret", `whsec_${mixed(32)}`],
    ["hindsight_key", `hsk_${rep("a", 32)}`],
    ["gsam_key", `pcp_${rep("0f", 24)}`],
    ["netlify_token", `nfp_${mixed(40)}`],
    ["tailscale_key", `tskey-auth-${mixed(30)}`],
    ["supabase_key", `sbp_${rep("ab", 20)}`],
    ["huggingface_token", `hf_${mixed(34)}`],
    ["sendgrid_key", `SG.${mixed(22)}.${mixed(43)}`],
    ["jwt", `eyJ${mixed(20)}.eyJ${mixed(20)}.${mixed(20)}`],
    ["private_key", `-----BEGIN OPENSSH PRIVATE KEY-----\n${mixed(60)}\n-----END OPENSSH PRIVATE KEY-----`],
    ["private_key", `-----BEGIN RSA PRIVATE KEY-----\n${mixed(60)}\n(cut off)`],
    ["url_credentials", `postgres://gsam:${mixed(12)}@127.0.0.1:54329/gsam`],
    ["url_credentials", `https://john:${mixed(10)}@example.com/x`],
    ["url_secret", `https://api.example.com/v1?user=1&access_token=${mixed(18)}`],
    ["authorization_header", `curl -H "Authorization: Basic ${mixed(18)}" https://x`],
    ["bearer_token", `use Bearer ${mixed(30)} for the call`],
    ["env_value", `DATABASE_PASSWORD=${mixed(14)}`],
    ["env_value", `export NETLIFY_AUTH_TOKEN="${mixed(20)}"`],
    ["env_value", `SOME_SETTING=plain-value-here`],
    ["secret_value", `{"api_key": "${mixed(18)}"}`],
    ["secret_value", `password: ${mixed(10)}`],
    ["secret_value", `the wifi password is ${mixed(9)}`],
    ["card_number", "card 4111 1111 1111 1111 exp 12/29"],
    ["card_number", "5555-5555-5555-4444"],
    ["phone", "call 07700 900123"],
    ["phone", "Ghana +233 24 123 4567"],
    ["high_entropy_string", `value ${mixed(40)} end`],
  ];
  for (const [type, input] of cases) {
    it(`${type}: ${input.slice(0, 28).replace(/\n/g, " ")}…`, () => {
      const { text, found } = redact(input);
      assert.ok(found.includes(type), `expected ${type} in ${found.join(",")}`);
      assert.match(text, new RegExp(`\\[redacted:${type}\\]`));
      // The secret part is gone.
      for (const piece of [mixed(18), rep("0f", 24), "4111 1111 1111 1111", "900123", "123 4567"]) {
        if (input.includes(piece)) assert.ok(!text.includes(piece), `${piece} leaked`);
      }
    });
  }

  it("keeps ordinary work text, ids and settings", () => {
    const keep = [
      "Commit dd0d80d8a9e6eecf020a0738b7bd0487099abcd1 merged PR #981.",
      "Issue 8483cbd1-ee0b-46fa-a030-20202ba4603f and bfbf8483-5871-4799-8095-0123456789ab",
      "Branch GRE-2668-hindsight-as-one-shared-memory-for-gsam-claude-and-chatgpt",
      "NODE_ENV=production\nPORT=3100\nDEBUG=false",
      "We decided on Better Auth with one organisation_id per client.",
      "Order 1234 5678 9012 3456 was not a card (fails Luhn).",
      "max_tokens: 4096",
    ];
    for (const input of keep) {
      const { text, found } = redact(input);
      assert.equal(text, input, `changed: ${input} -> ${text} (${found})`);
    }
  });

  it("drops code blocks in a turn that mentions a never-store file", () => {
    const input = "Here is pilot01.create-output.txt:\n```\nadmin password hunter2\ntoken abc\n```\nDone.";
    const { text, found } = redact(input);
    assert.ok(found.includes("never_store_file_block"));
    assert.ok(!text.includes("hunter2"));
    assert.ok(text.includes("Done."));
  });

  it("never reads never-store files", () => {
    for (const file of ["pilot01.create-output.txt", "x/.env", ".env.local", "deploy.pem", "my-secrets.md", "id_ed25519", "api-token.txt"]) {
      assert.ok(isNeverStoreFile(file), file);
    }
    for (const file of ["MEMORY.md", "NOW.md", "feedback-pr-flow.md"]) assert.ok(!isNeverStoreFile(file), file);
  });
});

const line = (value) => JSON.stringify(value);

describe("what a session keeps", () => {
  it("Claude Code: John's words and the last answer text, no tools, side chains or injected text", () => {
    const text = [
      line({ type: "user", uuid: "u1", sessionId: "s1", cwd: "/Users/john/gs-clip", gitBranch: "main", timestamp: "2026-10-25T14:00:00Z", message: { role: "user", content: "Which identity system for clients? <system-reminder>noise</system-reminder>" } }),
      line({ type: "assistant", uuid: "a1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", name: "Read", input: {} }] } }),
      line({ type: "user", uuid: "r1", message: { role: "user", content: [{ type: "tool_result", content: "file text" }] } }),
      line({ type: "assistant", uuid: "side", isSidechain: true, message: { id: "mx", role: "assistant", content: [{ type: "text", text: "subagent talk" }] } }),
      line({ type: "assistant", uuid: "a2", timestamp: "2026-10-25T14:03:00Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Decision: Better Auth, one organisation_id per client." }] } }),
      line({ type: "user", uuid: "meta", isMeta: true, message: { role: "user", content: "<command-name>/clear</command-name>" } }),
      line({ type: "user", uuid: "u2", timestamp: "2026-10-25T15:00:00Z", message: { role: "user", content: "yes" } }),
      '{"half": ',
    ].join("\n");
    const turns = claudeTurns(text);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].user, "Which identity system for clients?");
    assert.equal(turns[0].answer, "Decision: Better Auth, one organisation_id per client.");
    assert.equal(turns[0].complete, true);
    assert.equal(turns[1].complete, false); // still open until the file is idle
    assert.equal(claudeTurns(text, { idle: true })[1].complete, true);
    assert.ok(!JSON.stringify(turns).includes("subagent talk"));
    assert.ok(!JSON.stringify(turns).includes("file text"));
  });

  it("Codex (current format): user_message events and task_complete's final answer", () => {
    const text = [
      line({ timestamp: "2026-10-26T09:00:00Z", type: "session_meta", payload: { id: "rollout-7", cwd: "/Users/john/gs-clip" } }),
      line({ timestamp: "2026-10-26T09:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } }),
      line({ timestamp: "2026-10-26T09:00:02Z", type: "event_msg", payload: { type: "user_message", message: "Fix the payment report shape." } }),
      line({ timestamp: "2026-10-26T09:01:00Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } }),
      line({ timestamp: "2026-10-26T09:02:00Z", type: "event_msg", payload: { type: "agent_message", message: "Working on it" } }),
      line({ timestamp: "2026-10-26T09:05:00Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "Fixed the payment report and opened PR 981." } }),
      line({ timestamp: "2026-10-26T09:06:00Z", type: "event_msg", payload: { type: "agent_message", message: "late chatter" } }),
    ].join("\n");
    const turns = codexTurns(text, { idle: true });
    assert.equal(turns.length, 1);
    assert.equal(turns[0].sessionId, "rollout-7");
    assert.equal(turns[0].user, "Fix the payment report shape.");
    assert.equal(turns[0].answer, "Fixed the payment report and opened PR 981.");
  });

  it("Codex (older format): bare message items", () => {
    const text = [
      line({ id: "old-1", timestamp: "2026-09-01T10:00:00Z", instructions: "" }),
      line({ type: "message", role: "user", content: [{ type: "input_text", text: "Summarise the Indago brief." }] }),
      line({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Indago wants a 5-slide pre-read before 9 Nov." }] }),
    ].join("\n");
    const turns = codexTurns(text, { idle: true });
    assert.deepEqual(turns.map((turn) => [turn.user, turn.answer]), [["Summarise the Indago brief.", "Indago wants a 5-slide pre-read before 9 Nov."]]);
  });

  it("skips trivial turns but keeps a short go-ahead with a real answer", () => {
    assert.equal(isTrivialTurn({ user: "yes", answer: "Done." }), true);
    assert.equal(isTrivialTurn({ user: "ok", answer: "" }), true);
    assert.equal(isTrivialTurn({ user: "continue", answer: "x".repeat(300) }), false);
    assert.equal(isTrivialTurn({ user: "Use Better Auth for client identity", answer: "Agreed." }), false);
  });
});

describe("the Mac sync run", () => {
  function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-memory-sync-"));
    const dirs = {
      home: path.join(root, "conf"),
      memory: path.join(root, "memory"),
      claude: path.join(root, "claude"),
      codex: path.join(root, "codex"),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dirs.claude, "proj"), { recursive: true });
    fs.writeFileSync(
      path.join(dirs.home, "config.json"),
      JSON.stringify({
        gsamUrl: "https://gsam.example.ts.net:3100",
        companyId: "company-1",
        tokens: { claude_code: "env:T_CLAUDE", codex: "env:T_CODEX" },
        memoryDir: dirs.memory,
        claudeProjectsDir: dirs.claude,
        codexSessionsDir: dirs.codex,
        backfillDays: 14,
        maxEntriesPerRun: 40,
        dailyCap: 250,
      }),
    );
    const env = { GS_MEMORY_SYNC_HOME: dirs.home, T_CLAUDE: "claude-token", T_CODEX: "codex-token" };
    // A fake GSAM: remembers source id → content like the server does, and can cap.
    const server = { calls: [], live: new Map(), cap: Infinity, used: 0, handoffCalls: [], handoff: { revision: 0, markdown: "" } };
    const send = async (_config, token, route, body) => {
      if (route.startsWith("/handoff")) {
        server.handoffCalls.push({ token, route, body });
        return { ...server.handoff, conflicts: [] };
      }
      server.calls.push({ token, route, body });
      const entries = body.entries.map((entry) => {
        if (server.live.get(entry.sourceId) === entry.content) return { sourceId: entry.sourceId, outcome: "unchanged", recordId: "r" };
        if (server.used >= server.cap) return { sourceId: entry.sourceId, outcome: "capped", recordId: null };
        const outcome = server.live.has(entry.sourceId) ? "revised" : "added";
        server.live.set(entry.sourceId, entry.content);
        server.used += 1;
        return { sourceId: entry.sourceId, outcome, recordId: "r" };
      });
      return { entries, usedToday: server.used, dailyCap: server.cap, capReached: server.used >= server.cap };
    };
    const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    return { dirs, env, server, send, cleanup };
  }

  const claudeTurn = (n, at) => [
    line({ type: "user", uuid: `u${n}`, sessionId: "s1", cwd: "/w/gs-clip", timestamp: at, message: { role: "user", content: `Question ${n}: what should we do about item ${n}?` } }),
    line({ type: "assistant", uuid: `a${n}`, timestamp: at, message: { id: `m${n}`, role: "assistant", content: [{ type: "text", text: `Answer ${n}: we decided to handle item ${n} this week.` }] } }),
  ].join("\n");

  it("sends new turns and changed memory files once, resumes after a cap, and never sends never-store files", async () => {
    const { dirs, env, server, send, cleanup } = sandbox();
    try {
      const now = Date.parse("2026-10-26T12:00:00Z");
      const session = path.join(dirs.claude, "proj", "s1.jsonl");
      fs.writeFileSync(session, `${claudeTurn(1, "2026-10-25T10:00:00Z")}\n${claudeTurn(2, "2026-10-25T10:05:00Z")}\n`);
      fs.utimesSync(session, new Date(now - 3_600_000), new Date(now - 3_600_000));
      fs.writeFileSync(path.join(dirs.memory, "project_indago.md"), "---\ndescription: Indago\n---\nIndago first. token: abcdefghijk");
      fs.writeFileSync(path.join(dirs.memory, "pilot01.create-output.txt"), "admin password");
      const codexDir = path.join(dirs.codex, "2026", "10", "26");
      fs.mkdirSync(codexDir, { recursive: true });
      const rollout = path.join(codexDir, "rollout-1.jsonl");
      fs.writeFileSync(rollout, [
        line({ timestamp: "2026-10-26T09:00:00Z", type: "session_meta", payload: { id: "rollout-1" } }),
        line({ timestamp: "2026-10-26T09:00:02Z", type: "event_msg", payload: { type: "user_message", message: "Fix the payment report shape please." } }),
        line({ timestamp: "2026-10-26T09:05:00Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "Fixed the payment report and opened PR 981." } }),
      ].join("\n"));
      fs.utimesSync(rollout, new Date(now - 7_200_000), new Date(now - 7_200_000));

      const first = await run({ env, now, send, log: () => {} });
      assert.equal(first.added, 3);
      const sent = server.calls.flatMap((call) => call.body.entries);
      assert.deepEqual(sent.map((entry) => entry.source).sort(), ["claude_code", "codex", "memory_file"]);
      // Each app's entries go with its own token.
      assert.ok(server.calls.every((call) => (call.body.entries[0].source === "codex" ? call.token === "codex-token" : call.token === "claude-token")));
      const all = JSON.stringify(sent);
      assert.ok(!all.includes("abcdefghijk"), "memory file secret redacted");
      assert.ok(!all.includes("admin password"), "never-store file not sent");
      assert.match(all, /Question 1[\s\S]*Answer 2/);

      // Nothing new: nothing sent.
      server.calls.length = 0;
      await run({ env, now: now + 60_000, send, log: () => {} });
      assert.equal(server.calls.length, 0);

      // One more turn and a capped server: the turn waits, then goes the next day.
      fs.appendFileSync(session, `${claudeTurn(3, "2026-10-26T11:00:00Z")}\n`);
      fs.utimesSync(session, new Date(now), new Date(now));
      server.cap = server.used;
      const capped = await run({ env, now: now + 20 * 60_000, send, log: () => {} });
      assert.equal(capped.capped, 1);
      server.cap = Infinity;
      server.calls.length = 0;
      const resumed = await run({ env, now: now + 86_400_000, send, log: () => {} });
      assert.equal(resumed.added, 1);
      assert.match(JSON.stringify(server.calls), /Question 3/);
      assert.doesNotMatch(JSON.stringify(server.calls), /Question 1:/);

      // A changed memory file is sent again under the same source id.
      fs.writeFileSync(path.join(dirs.memory, "project_indago.md"), "Indago interview on 9 Nov.");
      server.calls.length = 0;
      const changed = await run({ env, now: now + 86_400_000 + 60_000, send, log: () => {} });
      assert.equal(changed.revised, 1);
      assert.equal(server.calls[0].body.entries[0].sourceId, "memory:project_indago.md");
    } finally {
      cleanup();
    }
  });

  it("mirrors the handoff to NOW.md, keeps NOW.md as the fallback while GSAM is down, and sends offline edits back", async () => {
    const { dirs, env, server, send, cleanup } = sandbox();
    const nowFile = path.join(dirs.memory, "NOW.md");
    const down = async () => {
      throw new Error("fetch failed: connect ECONNREFUSED");
    };
    try {
      // GSAM has a handoff and there is no NOW.md yet: the run writes it.
      server.handoff = { revision: 2, markdown: "# NOW: where we left off\n\n## Focus\n<!-- by ChatGPT · 2026-10-26T09:00:00.000Z -->\nShared memory first.\n" };
      const first = await run({ env, send, log: () => {} });
      assert.equal(first.handoff.written, true);
      assert.equal(fs.readFileSync(nowFile, "utf8"), server.handoff.markdown);
      // NOW.md is the handoff's mirror, never a memory-file entry.
      assert.ok(!server.calls.some((call) => JSON.stringify(call.body).includes("Shared memory first")));

      // GSAM (or the PC) is down. Claude edits NOW.md by hand; the run leaves it alone.
      const edited = server.handoff.markdown.replace("Shared memory first.", "Indago call first. key sk-ant-api03-" + mixed(40));
      fs.writeFileSync(nowFile, edited);
      const offline = await run({ env, send: down, log: () => {} });
      assert.equal(offline.handoff.offline, true);
      assert.equal(fs.readFileSync(nowFile, "utf8"), edited, "the fallback file keeps the offline edit");

      // GSAM is back: the edit goes back with the revision this Mac last wrote, redacted, and GSAM's answer is written.
      server.handoff = { revision: 3, markdown: "# NOW: where we left off\n\n## Focus\n<!-- by NOW.md edit · 2026-10-26T10:00:00.000Z -->\nIndago call first. key [redacted]\n" };
      server.handoffCalls.length = 0;
      const back = await run({ env, send, log: () => {} });
      assert.equal(server.handoffCalls.length, 1);
      const call = server.handoffCalls[0];
      assert.equal(call.route, "/handoff/file");
      assert.equal(call.body.baseRevision, 2);
      assert.match(call.body.text, /Indago call first/);
      assert.ok(!call.body.text.includes("sk-ant-api03"), "secrets never leave the Mac");
      assert.ok(call.body.fileChangedAt);
      assert.equal(back.handoff.sentBack, true);
      assert.equal(fs.readFileSync(nowFile, "utf8"), server.handoff.markdown);

      // Nothing changed here, GSAM moved on (an update from Codex): the run reads it and rewrites NOW.md.
      server.handoff = { revision: 4, markdown: `${server.handoff.markdown}\n## Live threads\n- GRE-2668 Shared memory | state: in review\n` };
      server.handoffCalls.length = 0;
      await run({ env, send, log: () => {} });
      assert.deepEqual(server.handoffCalls.map((entry) => entry.route), ["/handoff"]);
      assert.match(fs.readFileSync(nowFile, "utf8"), /GRE-2668 Shared memory/);
      const state = JSON.parse(fs.readFileSync(path.join(dirs.home, "state.json"), "utf8"));
      assert.equal(state.handoff.revision, 4);
    } finally {
      cleanup();
    }
  });

  it("does not overwrite NOW.md that a tool changed while the sync was out", async () => {
    const { dirs, cleanup } = sandbox();
    const nowFile = path.join(dirs.memory, "NOW.md");
    try {
      fs.writeFileSync(nowFile, "# NOW\n\nold\n");
      const state = { handoff: { revision: 1, hash: "x" } };
      const config = { memoryDir: dirs.memory };
      const send = async () => {
        // A tool writes while the call is out.
        fs.writeFileSync(nowFile, "# NOW\n\nbrand new edit\n");
        fs.utimesSync(nowFile, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
        return { revision: 2, markdown: "# NOW from GSAM\n", conflicts: [] };
      };
      const result = await syncHandoff({ config, token: "t", state, send });
      assert.equal(result.written, false);
      assert.equal(fs.readFileSync(nowFile, "utf8"), "# NOW\n\nbrand new edit\n");
      assert.equal(state.handoff.revision, 2);
    } finally {
      cleanup();
    }
  });

  it("dry run counts and sends nothing", async () => {
    const { dirs, env, server, send, cleanup } = sandbox();
    try {
      fs.writeFileSync(path.join(dirs.memory, "MEMORY.md"), "Index of memories, long enough to keep.");
      const summary = await run({ env, dryRun: true, send, log: () => {} });
      assert.equal(summary.sent, 1);
      assert.equal(server.calls.length, 0);
      assert.ok(!fs.existsSync(path.join(dirs.home, "state.json")));
    } finally {
      cleanup();
    }
  });

  it("only talks to the tailnet", () => {
    assert.equal(tailnetUrlProblem("https://gsam.tail83d26c.ts.net:3100"), null);
    assert.equal(tailnetUrlProblem("http://100.101.1.2:3100"), null);
    assert.equal(tailnetUrlProblem("http://localhost:3100"), null);
    assert.match(tailnetUrlProblem("https://gsam.tail83d26c.ts.net"), /Funnel/);
    assert.match(tailnetUrlProblem("https://gsam.example.com"), /tailnet/);
    assert.match(tailnetUrlProblem("http://8.8.8.8:3100"), /tailnet/);
  });
});
