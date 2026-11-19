#!/usr/bin/env node
// End-to-end check for the Claude MCP bearer header (GRE-5715, upstream #22206).
//
// acpx-engine/execute.ts gives the Claude agent an HTTP MCP header of
// `Bearer ${GSAM_ACPX_MCP_BEARER_TOKEN_<n>}` and puts the token in the agent's
// launch env. This script proves that path with the real binaries:
//   1. starts a local MCP server that accepts only the right bearer token;
//   2. launches the `claude-agent-acp` bin that execute.ts resolves, with the
//      token in its env only, and opens an ACP session with that header;
//   3. asks the agent to call the server's one tool;
//   4. while it runs, reads `ps` and fails if the token is in any argv.
// Pass: the tool call reached the server with the expanded token, no request
// was refused, and no process argument held the token.
//
// Needs a working Claude login for the agent (the inherited CLAUDE_CONFIG_DIR
// or ANTHROPIC_* env), because the model must make the tool call.
// Usage: node scripts/check-claude-mcp-bearer-expansion.mjs [--control] [path-to-claude-agent-acp]
// --control leaves the token out of the agent env. It must FAIL with the
// literal placeholder as the refused header; that proves the check can fail.
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const control = args.includes("--control");
const agentBin =
  args.find((arg) => arg !== "--control") ?? path.join(repoRoot, "packages/paperclip-runner/node_modules/.bin/claude-agent-acp");
const envName = "GSAM_ACPX_MCP_BEARER_TOKEN_0";
const secret = `synthetic-${randomBytes(12).toString("hex")}`;

if (!fs.existsSync(agentBin)) {
  console.error(`FAIL: agent bin not found: ${agentBin}`);
  process.exit(1);
}

const seen = { authOk: 0, refused: 0, toolCalls: 0, refusedValues: new Set() };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${secret}`) {
      seen.refused += 1;
      seen.refusedValues.add(String(req.headers.authorization).slice(0, 60));
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"unauthorized"}');
      return;
    }
    seen.authOk += 1;
    let msg = {};
    try {
      msg = JSON.parse(body);
    } catch {}
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (msg.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    };
    if (msg.method === "initialize") {
      reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bearer-check", version: "1" } });
    } else if (msg.method === "tools/list") {
      reply({ tools: [{ name: "ping", description: "Returns pong.", inputSchema: { type: "object", properties: {} } }] });
    } else if (msg.method === "tools/call") {
      seen.toolCalls += 1;
      reply({ content: [{ type: "text", text: "pong" }] });
    } else {
      reply({});
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;

const workDir = fs.mkdtempSync(path.join(process.env.GSAM_RUN_SCRATCH_DIR ?? os.tmpdir(), "mcp-bearer-check-"));
const child = spawn(agentBin, [], {
  cwd: workDir,
  stdio: ["pipe", "pipe", "inherit"],
  env: control ? { ...process.env } : { ...process.env, [envName]: secret },
});

let argvLeaks = 0;
let sawPlaceholderArgv = false;
const psTimer = setInterval(() => {
  let out = "";
  try {
    out = execFileSync("ps", ["-eww", "-o", "pid=,args="], { encoding: "utf8" });
  } catch {
    return;
  }
  for (const line of out.split("\n")) {
    if (line.includes(secret)) argvLeaks += 1;
    if (line.includes("--mcp-config") && line.includes(`\${${envName}}`)) sawPlaceholderArgv = true;
  }
}, 250);

let nextId = 1;
const pending = new Map();
const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === "session/request_permission") {
    const option =
      msg.params.options.find((o) => o.kind === "allow_once") ??
      msg.params.options.find((o) => o.kind?.startsWith("allow")) ??
      msg.params.options[0];
    send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: option.optionId } } });
  } else if (msg.method && msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
  }
});

let failure = null;
const timeout = setTimeout(() => {
  failure = "timed out after 180s";
  child.kill("SIGTERM");
}, 180_000);
try {
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const session = await request("session/new", {
    cwd: workDir,
    mcpServers: [
      { type: "http", name: "bearercheck", url, headers: [{ name: "Authorization", value: `Bearer \${${envName}}` }] },
    ],
  });
  await request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Call the ping tool from the bearercheck MCP server exactly once, then reply with its result." }],
  });
} catch (err) {
  failure = failure ?? String(err?.message ?? err).slice(0, 300);
} finally {
  clearTimeout(timeout);
  clearInterval(psTimer);
  child.kill("SIGTERM");
  server.close();
}

const result = {
  agentBin,
  control,
  authOk: seen.authOk,
  refused: seen.refused,
  refusedHeaders: [...seen.refusedValues],
  toolCalls: seen.toolCalls,
  argvLeaks,
  sawPlaceholderArgv,
  error: failure,
};
console.log(JSON.stringify(result, null, 2));
const pass = !failure && seen.toolCalls > 0 && seen.refused === 0 && argvLeaks === 0;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
