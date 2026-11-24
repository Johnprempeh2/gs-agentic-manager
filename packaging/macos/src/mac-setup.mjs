// GSAM for Mac: licence activation and the switch to log-ins. No dependencies,
// so it runs as soon as Node.js is installed (before GSAM itself is downloaded).
//   node mac-setup.mjs activate <instance root> <hub URL>   (licence key in GSAM_LICENCE_KEY)
//   node mac-setup.mjs config <instance root> <database port>
//   node mac-setup.mjs allow-host <instance root> <tailnet name>   (prints changed or same)
// Messages for the person go to stdout; gsam.sh shows them in a dialog.
// Never prints the licence key, keys or passwords.

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , command, root, arg] = process.argv;

function fail(message) {
  process.stdout.write(`${message}\n`);
  process.exit(1);
}

function writePrivate(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// The same compact JWS the hub checks (packages/shared/src/fleet-spoke.ts signFleetMessage).
function signRegisterProof(privateJwk, licenceKey, seq) {
  const iat = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sub = createHash("sha256").update(licenceKey, "utf8").digest("base64url");
  const input = `${encode({ alg: "EdDSA", typ: "gsam-fleet+jwt" })}.${encode({ v: 1, aud: "gsam-fleet/v1", act: "register", sub, iat, exp: iat + 300, seq })}`;
  return `${input}.${sign(null, Buffer.from(input), createPrivateKey({ key: privateJwk, format: "jwk" })).toString("base64url")}`;
}

async function activate() {
  const fleetDir = path.join(root, "fleet");
  if (existsSync(path.join(fleetDir, "spoke.json"))) return void process.stdout.write("already activated\n");
  const licenceKey = (process.env.GSAM_LICENCE_KEY ?? "").trim();
  if (!/^gsamlk_[A-Za-z0-9_-]{20,120}$/.test(licenceKey)) fail("That is not a GSAM licence key. It starts with gsamlk_. Copy it again from the email or the website.");
  let hub;
  try {
    hub = new URL(arg ?? "");
  } catch {
    fail("This copy of GSAM does not know where Greatstone's service is. Ask Greatstone for a new download.");
  }
  const loopback = hub.hostname === "127.0.0.1" || hub.hostname === "localhost";
  if (hub.protocol !== "https:" && !(hub.protocol === "http:" && loopback)) fail("The Greatstone service address must start with https://.");
  const hubUrl = `${hub.origin}${hub.pathname.replace(/\/+$/, "")}`;

  const { privateKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicKey = { kty: "OKP", crv: "Ed25519", x: privateJwk.x };
  const seq = Date.now();
  let releaseTag = (process.env.GSAM_RELEASE_TAG ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(releaseTag)) releaseTag = null;
  const body = {
    licenceKey,
    publicKey,
    proof: signRegisterProof(privateJwk, licenceKey, seq),
    facts: { os: "macos", arch: process.arch === "arm64" ? "arm64" : "x64", releaseTag },
  };

  let res;
  try {
    res = await fetch(`${hubUrl}/api/fleet/spoke/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("Could not reach Greatstone to check the licence key. Check the internet connection and try again.");
  }
  const answer = await res.json().catch(() => null);
  if (res.status === 429) fail("Too many tries with a licence key. Wait 10 minutes and try again.");
  if (res.status === 401 && answer?.error === "fleet_bad_registration_code") {
    fail("This licence key is not valid, has been used already, or has expired. Ask Greatstone for a new one.");
  }
  if (res.status !== 201 || !answer?.instanceId) fail(`Greatstone could not activate the licence (${answer?.error ?? `HTTP ${res.status}`}). Try again later.`);

  // The private key and the operator log-in are readable by this Mac user only. spoke.json goes last: it marks activation done.
  writePrivate(path.join(fleetDir, "key.json"), `${JSON.stringify({ privateJwk, publicKey }, null, 2)}\n`);
  writePrivate(path.join(fleetDir, "operator.json"), `${JSON.stringify(answer.operator)}\n`);
  writePrivate(path.join(fleetDir, "spoke-state.json"), `${JSON.stringify({ lastSeq: seq })}\n`);
  writePrivate(path.join(root, "entitlements", "entitlement.json"), `${JSON.stringify(answer.entitlement)}\n`);
  // Remote help: a one-use Tailscale key, when the hub has one. The tailscale step uses it once, then deletes it.
  if (typeof answer.tailscale?.authKey === "string") {
    writePrivate(path.join(fleetDir, "tailscale.json"), `${JSON.stringify({ authKey: answer.tailscale.authKey })}\n`);
  }
  const spoke = {
    v: 1,
    hubUrl,
    instanceId: answer.instanceId,
    code: answer.code,
    entitlementPublicKey: answer.entitlementPublicKey,
    operatorEmail: answer.operator.email,
    activatedAt: new Date().toISOString(),
  };
  writePrivate(path.join(fleetDir, "spoke.json"), `${JSON.stringify(spoke, null, 2)}\n`);
  process.stdout.write(`activated ${answer.code}\n`);
}

// Authenticated mode on loopback, sign-up closed (invites still work), hourly
// backups kept 30 days. An existing config keeps every other value, above all
// the database location, and the old file is kept beside it.
function config() {
  const dbPort = Number(arg) || 54329;
  const file = path.join(root, "config.json");
  const backupDir = path.join(root, "data", "backups");
  let cfg;
  if (existsSync(file)) {
    cfg = JSON.parse(readFileSync(file, "utf8"));
    const saved = path.join(root, "config.json.before-licence");
    if (!existsSync(saved)) copyFileSync(file, saved);
  } else {
    // The same places the server uses with no config file, so an install that never had one keeps its data.
    cfg = {
      $meta: { version: 1, updatedAt: "", source: "onboard" },
      database: { mode: "embedded-postgres", embeddedPostgresDataDir: path.join(root, "db"), embeddedPostgresPort: dbPort },
      logging: { mode: "file", logDir: path.join(root, "logs") },
      server: {},
      telemetry: { enabled: false },
      storage: { provider: "local_disk", localDisk: { baseDir: path.join(root, "data", "storage") } },
      secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: path.join(root, "secrets", "master.key") } },
    };
  }
  cfg.$meta = { ...(cfg.$meta ?? { version: 1, source: "onboard" }), updatedAt: new Date().toISOString() };
  cfg.database = cfg.database ?? {};
  cfg.database.backup = { ...(cfg.database.backup ?? {}), enabled: true, intervalMinutes: 60, retentionDays: 30, dir: cfg.database.backup?.dir ?? backupDir };
  cfg.server = { ...(cfg.server ?? {}), deploymentMode: "authenticated", exposure: "private", bind: "loopback", host: "127.0.0.1" };
  delete cfg.server.customBindHost;
  cfg.auth = { ...(cfg.auth ?? {}), baseUrlMode: "auto", disableSignUp: true };
  delete cfg.auth.publicBaseUrl;
  writePrivate(file, `${JSON.stringify(cfg, null, 2)}\n`);

  // Log-ins need an auth secret. Reuse the agent key when there is one, so agent tokens keep working.
  const envFile = path.join(root, ".env");
  const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  if (!/^(BETTER_AUTH_SECRET|GSAM_AGENT_JWT_SECRET)=/m.test(env)) {
    const agentKey = path.join(root, "secrets", "agent-jwt.key");
    const secret = existsSync(agentKey) ? readFileSync(agentKey, "utf8").trim() : randomBytes(32).toString("hex");
    writePrivate(envFile, `${env}${env && !env.endsWith("\n") ? "\n" : ""}BETTER_AUTH_SECRET=${secret}\n`);
  }
  process.stdout.write("config ready\n");
}

// Log-ins arriving over Greatstone's tailnet carry the install's tailnet name; GSAM must allow it.
function allowHost() {
  const name = String(arg ?? "").toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,62}\.){1,5}ts\.net$/.test(name)) fail(`not a tailnet name: ${name}`);
  const file = path.join(root, "config.json");
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  const hosts = cfg.server?.allowedHostnames ?? [];
  if (hosts.includes(name)) return void process.stdout.write("same");
  cfg.server = { ...(cfg.server ?? {}), allowedHostnames: [...hosts, name] };
  writePrivate(file, `${JSON.stringify(cfg, null, 2)}\n`);
  process.stdout.write("changed");
}

if (!root) fail("usage: mac-setup.mjs activate|config|allow-host <instance root> <arg>");
if (command === "activate") await activate();
else if (command === "config") config();
else if (command === "allow-host") allowHost();
else fail(`unknown command: ${command}`);
