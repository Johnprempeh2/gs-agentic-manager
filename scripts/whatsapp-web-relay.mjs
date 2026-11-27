import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

process.umask(0o077);
const phone = /^[1-9]\d{7,14}$/;
const providerId = /^[A-Za-z0-9_-]{1,128}$/;
const keyPattern = /^[0-9a-f]{64}$/;
const quietLog = () => {};
const logger = { level: "silent", trace: quietLog, debug: quietLog, info: quietLog, warn: quietLog, error: quietLog, fatal: quietLog, child: () => logger };

function readConfig() {
  const configPath = process.env.GSAM_WHATSAPP_WEB_RELAY_CONFIG_FILE;
  if (!configPath) throw new Error("No private WhatsApp relay configuration is set");
  const info = lstatSync(configPath);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid() || info.size > 4096)
    throw new Error("The WhatsApp relay configuration must be a private regular file");
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  const ingress = new URL(cfg.ingressUrl);
  if (ingress.protocol !== "https:" || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(ingress.hostname) ||
      !/^\/api\/private-chat\/whatsapp-web\/[A-Za-z0-9_-]+$/.test(ingress.pathname) ||
      ingress.username || ingress.password || ingress.search || ingress.hash ||
      !phone.test(cfg.sender ?? "") || !phone.test(cfg.bot ?? "") || cfg.sender === cfg.bot ||
      !keyPattern.test(cfg.ingressKey ?? "") || !keyPattern.test(cfg.replyKey ?? "") || cfg.ingressKey === cfg.replyKey ||
      !Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535) throw new Error("Invalid private WhatsApp relay configuration");
  const bridge = realpathSync(cfg.bridgeDirectory);
  const session = realpathSync(cfg.sessionDirectory);
  if (lstatSync(session).mode & 0o077 || !lstatSync(join(session, "creds.json")).isFile())
    throw new Error("Pair the dedicated bot in a private session directory first");
  return { ...cfg, ingress, bridge, session };
}

function authenticated(header, key) {
  if (typeof header !== "string") return false;
  const provided = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${key}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function envelope(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 24_000) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

async function main() {
  const cfg = readConfig();
  const requireBridge = createRequire(join(cfg.bridge, "package.json"));
  const { makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser } =
    await import(pathToFileURL(requireBridge.resolve("@whiskeysockets/baileys")).href);
  const { matchesAllowedSender, parseAllowedUsers } =
    await import(pathToFileURL(join(cfg.bridge, "allowlist.js")).href);
  const allowedUsers = parseAllowedUsers(cfg.sender);
  const recipient = `${cfg.sender}@s.whatsapp.net`;
  // A new owner or GSAM endpoint must never inherit old queued messages.
  const binding = createHash("sha256").update(JSON.stringify([cfg.bot, cfg.sender, cfg.ingress.href])).digest("hex");
  const queue = new DatabaseSync(join(cfg.session, `gsam-relay-${binding}.sqlite`));
  queue.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, text TEXT, received_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, digest TEXT NOT NULL, message_id TEXT);
  `);
  const recordInbound = queue.prepare("INSERT OR IGNORE INTO inbox VALUES (?, ?, ?)");
  const nextInbound = queue.prepare("SELECT id, text FROM inbox WHERE text IS NOT NULL ORDER BY rowid LIMIT 1");
  const acknowledge = queue.prepare("UPDATE inbox SET text = NULL WHERE id = ?");
  const addReply = queue.prepare("INSERT OR IGNORE INTO outbox VALUES (?, ?, NULL)");
  const getReply = queue.prepare("SELECT digest, message_id FROM outbox WHERE id = ?");
  const sentReply = queue.prepare("UPDATE outbox SET message_id = ? WHERE id = ?");
  let socket = null;
  let pumping = false;
  let reconnect = true;
  let pendingReply = false;

  async function drain() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const row = nextInbound.get();
        if (!row) return;
        const response = await fetch(cfg.ingress, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.ingressKey}`, "content-type": "application/json" },
          body: JSON.stringify({ id: row.id, sender: cfg.sender, bot: cfg.bot, kind: "direct", text: row.text }),
          redirect: "error",
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) return;
        acknowledge.run(row.id);
      }
    } catch {
      // Keep the row with its provider id for retry after the connection recovers.
    } finally {
      pumping = false;
    }
  }

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(cfg.session);
    if (jidNormalizedUser(state.creds.me?.id ?? "") !== `${cfg.bot}@s.whatsapp.net`) {
      throw new Error("The paired WhatsApp account is not the configured bot");
    }
    const ws = makeWASocket({ auth: state, logger, syncFullHistory: false, markOnlineOnConnect: false, defaultQueryTimeoutMs: 7_000 });
    ws.ev.on("creds.update", saveCreds);
    ws.ev.on("connection.update", ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        if (jidNormalizedUser(ws.user?.id ?? "") === `${cfg.bot}@s.whatsapp.net`) socket = ws;
        else {
          reconnect = false;
          ws.end(new Error("Paired bot does not match"));
        }
      }
      if (connection !== "close") return;
      if (socket === ws) socket = null;
      if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) reconnect = false;
      if (reconnect) setTimeout(() => void connect().catch(() => { reconnect = false; }), 3_000);
    });
    ws.ev.on("messages.upsert", ({ type, messages }) => {
      if (type !== "notify" || socket !== ws) return;
      for (const { key, message } of messages) {
        const jid = key.remoteJid ?? "";
        if (key.fromMe || !providerId.test(key.id ?? "") || !/@(?:s\.whatsapp\.net|lid)$/.test(jid) ||
            !matchesAllowedSender(jid, key.remoteJidAlt, allowedUsers, cfg.session)) continue;
        const text = (message?.conversation ?? message?.extendedTextMessage?.text ?? "").trim();
        if (text && text.length <= 4000) recordInbound.run(key.id, text, Date.now());
      }
      void drain();
    });
  }

  const server = createServer(async (request, response) => {
    const finish = (status, body = "") => response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
    if (request.method !== "POST" || request.url !== "/v1/whatsapp-web/replies") return finish(404);
    if (!authenticated(request.headers.authorization, cfg.replyKey)) return finish(401);
    if (pendingReply) return finish(503);
    pendingReply = true;
    try {
      const event = await envelope(request);
      if (!event || !providerId.test(event.id ?? "") || event.sender !== cfg.sender || event.bot !== cfg.bot ||
          typeof event.text !== "string" || !event.text.trim() || event.text.length > 4000) return finish(400);
      const digest = createHash("sha256").update(event.text).digest("hex");
      addReply.run(event.id, digest);
      const existing = getReply.get(event.id);
      if (existing.digest !== digest) return finish(409);
      if (existing.message_id) return finish(200, JSON.stringify({ messageId: existing.message_id }));
      if (!socket) return finish(503);
      const messageId = createHash("sha256").update(`gsam-whatsapp:${cfg.bot}:${event.id}`).digest("hex").slice(0, 32).toUpperCase();
      const sent = await socket.sendMessage(recipient, { text: event.text }, { messageId });
      if (sent?.key?.id !== messageId) return finish(502);
      sentReply.run(messageId, event.id);
      return finish(200, JSON.stringify({ messageId }));
    } catch {
      return finish(503);
    } finally {
      pendingReply = false;
    }
  });
  server.requestTimeout = 20_000;
  server.listen(cfg.port, "127.0.0.1");
  server.on("error", () => { console.error("WhatsApp relay listener failed."); process.exit(1); });
  await connect();
  setInterval(() => void drain(), 5_000);
}

main().catch(() => {
  console.error("WhatsApp relay could not start. Check the private configuration and the dedicated pairing.");
  process.exit(1);
});
