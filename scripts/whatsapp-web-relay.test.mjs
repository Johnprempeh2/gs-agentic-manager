import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("relay filters synthetic ingress and returns a stable reply receipt across restarts", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gsam-wa-relay-"));
  const session = join(dir, "session");
  const bridge = join(dir, "bridge");
  const pkg = join(bridge, "node_modules", "@whiskeysockets", "baileys");
  const events = join(dir, "events.jsonl");
  const boot = join(dir, "mock-fetch.mjs");
  const configPath = join(dir, "private.json");
  const sender = "15550001111";
  const bot = "15550002222";
  const ingressKey = "1".repeat(64);
  const replyKey = "2".repeat(64);
  const ingressUrl = "https://gsam.example-tail.ts.net:3100/api/private-chat/whatsapp-web/check";
  const errors = [];
  const records = () => readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const waitFor = async (check) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await check();
      if (value) return value;
      await setTimeout(25);
    }
    throw new Error(`The relay fixture did not reach the expected state. ${errors.join("")}`);
  };
  const log = `import { appendFileSync } from "node:fs";
    const record = (event) => appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + "\\n");`;

  mkdirSync(session, { mode: 0o700 });
  mkdirSync(pkg, { recursive: true });
  writeFileSync(events, "");
  writeFileSync(join(session, "creds.json"), "{}");
  writeFileSync(join(bridge, "package.json"), '{"type":"module"}');
  writeFileSync(join(bridge, "allowlist.js"), `export const parseAllowedUsers = (value) => new Set([value]);
    export const matchesAllowedSender = (jid, alt, users) => [jid, alt].some((value) => users.has(value?.split("@")[0]));`);
  writeFileSync(join(pkg, "package.json"), '{"type":"module","main":"index.js"}');
  writeFileSync(join(pkg, "index.js"), `${log}
    import { EventEmitter } from "node:events";
    const id = "${bot}@s.whatsapp.net";
    export const DisconnectReason = { loggedOut: 401 };
    export const jidNormalizedUser = (jid) => jid;
    export async function useMultiFileAuthState() { return { state: { creds: { me: { id } } }, saveCreds() {} }; }
    export function makeWASocket() {
      const ev = new EventEmitter();
      setImmediate(() => {
        ev.emit("connection.update", { connection: "open" });
        const fake = (remoteJid, id) => ({ key: { remoteJid, id }, message: { conversation: "Synthetic text" } });
        ev.emit("messages.upsert", { type: "notify", messages: [
          fake("${sender}@s.whatsapp.net", "VALID"), fake("15550003333@s.whatsapp.net", "STRANGER"), fake("1@g.us", "GROUP"),
          fake("${sender}@s.whatsapp.net", "VALID"),
        ] });
      });
      return { ev, user: { id }, async sendMessage(jid, message, options) {
        record({ kind: "reply", jid, messageId: options.messageId, text: message.text });
        return { key: { id: options.messageId } };
      } };
    }`);
  writeFileSync(boot, `${log}
    globalThis.fetch = async (url, options) => {
      if (String(url) !== ${JSON.stringify(ingressUrl)} || options.headers.authorization !== "Bearer ${ingressKey}")
        throw new Error("Unexpected request");
      record({ ...JSON.parse(options.body), kind: "inbound" });
      return new Response(null, { status: 204 });
    };`);
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  writeFileSync(configPath, JSON.stringify({
    ingressUrl, ingressKey, replyKey, sender, bot, port,
    sessionDirectory: session, bridgeDirectory: bridge,
  }), { mode: 0o600 });
  const entry = join(dirname(fileURLToPath(import.meta.url)), "whatsapp-web-relay.mjs");
  const children = [];
  const bootRelay = () => {
    const child = spawn(process.execPath, ["--import", boot, entry], {
      env: { ...process.env, GSAM_WHATSAPP_WEB_RELAY_CONFIG_FILE: configPath }, stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (data) => errors.push(data.toString()));
    children.push(child);
    return child;
  };
  const stopRelay = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, "exit");
    child.kill();
    await exit;
  };
  const post = (body, key = replyKey) => fetch(`http://127.0.0.1:${port}/v1/whatsapp-web/replies`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  const payload = { id: "PUB_TEST", sender, bot, text: "Everest synthetic reply" };

  try {
    const child = bootRelay();
    await waitFor(() => records().some((event) => event.kind === "inbound"));
    assert.deepEqual(records().filter((event) => event.kind === "inbound").map((event) => event.id), ["VALID"]);
    assert.equal((await post(payload, ingressKey)).status, 401);
    assert.equal((await post({ ...payload, sender: bot })).status, 400);
    const first = await (await post(payload)).json();
    await stopRelay(child);
    bootRelay();
    const second = await waitFor(async () => {
      const response = await post(payload);
      return response?.ok ? response.json() : null;
    });
    assert.deepEqual(second, first);
    assert.equal((await post({ ...payload, text: "Conflicting replay" })).status, 409);
    assert.equal(records().filter((event) => event.kind === "reply").length, 1);
  } finally {
    for (const child of children) await stopRelay(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
