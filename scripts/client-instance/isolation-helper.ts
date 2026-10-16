// Checks for the isolation sandbox test (GRE-1362, AT-3.1, AT-3.5, AT-3.6).
// Run only by isolation.sandbox-test.sh, on sandbox instances.
//
// Each command prints PASS/FAIL lines and exits 1 when any check fails.
// Log-ins come in environment variables and are never printed.
//
//   compare <root A> <root B>             (ISO_A_OPERATOR, ISO_B_OPERATOR)
//   db-login <root> <password file>       prints "ok" or "refused: <reason>"
//   seed <root> <marker> <out.json>       (ISO_CLIENT_EMAIL, ISO_CLIENT_PASSWORD)
//   decrypt <root> <master key file> <secret id>
//   cross <root A> <root B> <seed A.json> <seed B.json>
//                                         (ISO_A_OPERATOR, ISO_B_OPERATOR, ISO_A_CLIENT, ISO_B_CLIENT, ISO_CLIENT_EMAIL)
//   fleet-404 <root>                      (ISO_CLIENT_EMAIL, ISO_CLIENT_PASSWORD, ISO_OPERATOR)
//   forge <root A> <root B> <hub url> <capture log>
//   proxy <port> <hub url> <capture log> <pid file>
//                                         (records every request to the hub; answers /ping itself)
//   scan <capture log> <seed json>... [--also <json file>]...

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { buildCheckIn, signFleetMessage, type FleetKey, type FleetRegistration } from "./fleet.js";

const OPERATOR_EMAIL = "operator@instance.invalid";
let failures = 0;
const pass = (line: string) => process.stdout.write(`PASS ${line}\n`);
const fail = (line: string) => {
  failures += 1;
  process.stdout.write(`FAIL ${line}\n`);
};
const check = (ok: boolean, line: string) => (ok ? pass(line) : fail(line));
const env = (key: string) => process.env[key] || die(`${key} is not set`);
function die(message: string): never {
  process.stderr.write(`isolation-helper: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- instance facts

interface State {
  port: number;
  dbPort: number;
  [key: string]: unknown;
}
const readJson = <T,>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const state = (root: string) => readJson<State>(path.join(root, "client-instance.json"));
const instanceDir = (root: string) => path.join(root, "instances", "default");
const baseUrl = (root: string) => `http://127.0.0.1:${state(root).port}`;
const dbPasswordFile = (root: string) => path.join(instanceDir(root), "secrets", "embedded-postgres.password");
const masterKeyFile = (root: string) => path.join(instanceDir(root), "secrets", "master.key");
const dbUrl = (root: string, passwordFile = dbPasswordFile(root)) =>
  `postgres://paperclip:${encodeURIComponent(readFileSync(passwordFile, "utf8").split("\n")[0]!.trim())}@127.0.0.1:${state(root).dbPort}/paperclip`;

// ---------------------------------------------------------------- HTTP session

class Session {
  private cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  async request(method: string, route: string, body?: unknown) {
    const headers: Record<string, string> = { Origin: this.base, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${this.base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      if (eq > 0) this.cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, text };
  }

  /** Sign-in is rate limited (3 in 10 s); wait and try again on 429. */
  async signIn(email: string, password: string) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await this.request("POST", "/api/auth/sign-in/email", { email, password });
      if (res.status !== 429) return res.status;
      await new Promise((r) => setTimeout(r, 11_000));
    }
    return 429;
  }

  async read(route: string) {
    const res = await this.request("GET", route);
    if (res.status !== 200) die(`GET ${route} on ${this.base} returned ${res.status}`);
    return res.json;
  }

  async write(method: string, route: string, body: unknown) {
    const res = await this.request(method, route, body);
    if (res.status < 200 || res.status >= 300) die(`${method} ${route} on ${this.base} returned ${res.status}: ${res.text.slice(0, 200)}`);
    return res.json;
  }

  /** The cookies, to send from another session. */
  cookieJar() {
    return new Map(this.cookies);
  }
  useCookies(jar: Map<string, string>) {
    this.cookies = new Map(jar);
  }
}

async function signedIn(base: string, email: string, password: string) {
  const session = new Session(base);
  const status = await session.signIn(email, password);
  if (status !== 200) die(`sign-in of ${email} on ${base} returned ${status}`);
  return session;
}

// ---------------------------------------------------------------- compare (AT-3.1)

/** Fields that are times or counters, not set-up. */
const NOISE_KEYS = new Set(["createdAt", "updatedAt", "at", "registeredAt", "lastSeq", "lastCheckIn", "lastVerify"]);

function normalize(value: unknown, root: string, ports: number[]): unknown {
  if (typeof value === "string") {
    let s = value.split(root).join("<ROOT>");
    for (const [i, port] of ports.entries()) s = s.split(String(port)).join(`<PORT${i}>`);
    return s;
  }
  if (typeof value === "number" && ports.includes(value)) return `<PORT${ports.indexOf(value)}>`;
  if (Array.isArray(value)) return value.map((v) => normalize(v, root, ports));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !NOISE_KEYS.has(k))
        .map(([k, v]) => [k, normalize(v, root, ports)]),
    );
  }
  return value;
}

/**
 * Paths of every file, except the database cluster, backups, logs, run files
 * and the connectivity watch state (written on a timer, so present or not by timing).
 */
function fileList(root: string): string[] {
  const skip = [
    /^instances\/default\/db\//,
    /^instances\/default\/data\/backups\//,
    /^instances\/default\/logs\//,
    /^instances\/default\/connectivity\//,
    /^server\.(log|pid)$/,
  ];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      const rel = path.relative(root, file);
      if (statSync(file).isDirectory()) walk(file);
      else if (!skip.some((re) => re.test(rel))) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function cmdCompare(rootA: string, rootB: string) {
  const [a, b] = [state(rootA), state(rootB)];
  const portsOf = (s: State) => [s.port, s.dbPort];
  check(a.port !== b.port && a.dbPort !== b.dbPort && !portsOf(a).some((p) => portsOf(b).includes(p)), `ports differ: A ${a.port}/${a.dbPort}, B ${b.port}/${b.dbPort}`);
  for (const p of [...portsOf(a), ...portsOf(b)]) check(p !== 3100 && p !== 3200, `port ${p} is not 3100 or 3200`);

  const files = [fileList(rootA), fileList(rootB)];
  check(same(files[0], files[1]), `same file layout (${files[0]!.length} files outside the database, backups, logs and runtime state)`);
  if (!same(files[0], files[1])) {
    process.stdout.write(`  only in A: ${files[0]!.filter((f) => !files[1]!.includes(f)).join(", ") || "-"}\n`);
    process.stdout.write(`  only in B: ${files[1]!.filter((f) => !files[0]!.includes(f)).join(", ") || "-"}\n`);
  }

  // Set-up files: equal once the root and ports are replaced.
  const setupFiles = ["client-instance.json", "instances/default/config.json", "fleet/hub.json"];
  for (const rel of setupFiles) {
    const [fa, fb] = [path.join(rootA, rel), path.join(rootB, rel)];
    if (!existsSync(fa) || !existsSync(fb)) {
      fail(`${rel} is in both instances`);
      continue;
    }
    let [na, nb] = [normalize(readJson(fa), rootA, portsOf(a)), normalize(readJson(fb), rootB, portsOf(b))];
    if (rel === "fleet/hub.json") {
      // The hub gives each instance its own id and code (the folder name).
      const strip = (v: any, code: string) => ({ ...v, instanceId: v.instanceId ? "<ID>" : v.instanceId, code: v.code === code ? "<CODE>" : v.code });
      na = strip(na, path.basename(rootA));
      nb = strip(nb, path.basename(rootB));
    }
    check(same(na, nb), `${rel} is the same apart from root, ports${rel === "fleet/hub.json" ? ", hub id and code" : ""}`);
    if (!same(na, nb)) process.stdout.write(`  A: ${JSON.stringify(na)}\n  B: ${JSON.stringify(nb)}\n`);
  }
  check(readJson<FleetRegistration>(path.join(rootA, "fleet/hub.json")).instanceId !== readJson<FleetRegistration>(path.join(rootB, "fleet/hub.json")).instanceId, "fleet: each instance has its own hub id");

  // Secrets and keys: present in both, never the same.
  const secretFiles = ["instances/default/.env", "instances/default/secrets/embedded-postgres.password", "instances/default/secrets/master.key", "fleet/key.json"];
  for (const rel of secretFiles) {
    const [fa, fb] = [path.join(rootA, rel), path.join(rootB, rel)];
    if (!existsSync(fa) && !existsSync(fb)) {
      pass(`${rel}: in neither instance yet (made on first use, per instance)`);
      continue;
    }
    check(existsSync(fa) && existsSync(fb), `${rel} is in both instances`);
    if (existsSync(fa) && existsSync(fb)) {
      check(sha(fa) !== sha(fb), `${rel} differs between A and B`);
      check((statSync(fa).mode & 0o077) === 0 && (statSync(fb).mode & 0o077) === 0, `${rel} is mode 600 in both`);
    }
  }
  const envKeys = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => l.split("=")[0]).sort();
  check(same(envKeys(path.join(rootA, secretFiles[0]!)), envKeys(path.join(rootB, secretFiles[0]!))), ".env holds the same keys (values differ)");
  const pubA = readJson<FleetKey>(path.join(rootA, "fleet/key.json")).publicKey.x;
  const pubB = readJson<FleetKey>(path.join(rootB, "fleet/key.json")).publicKey.x;
  check(pubA !== pubB, "fleet public keys differ");

  // The running app: same edition values, its own company.
  const sa = await signedIn(baseUrl(rootA), OPERATOR_EMAIL, env("ISO_A_OPERATOR"));
  const sb = await signedIn(baseUrl(rootB), OPERATOR_EMAIL, env("ISO_B_OPERATOR"));
  const healthOf = async (s: Session) => {
    const h = await s.read("/api/health");
    return { status: h.status, deploymentMode: h.deploymentMode, hiddenSettings: [...(h.hiddenSettings ?? [])].sort(), version: h.version };
  };
  const [ha, hb] = [await healthOf(sa), await healthOf(sb)];
  check(same(ha, hb) && ha.hiddenSettings.length > 0, `health is the same (${ha.hiddenSettings.length} hidden settings, mode ${ha.deploymentMode})`);
  const [ea, eb] = [await sa.read("/api/instance/settings/experimental"), await sb.read("/api/instance/settings/experimental")];
  check(same(ea, eb), `feature switches are the same (${Object.keys(ea).length} keys)`);
  const [ga, gb] = [await sa.read("/api/instance/settings/general"), await sb.read("/api/instance/settings/general")];
  check(same(ga, gb), `general settings are the same (AI route ${String(ga.aiAccessRoute)})`);
  const [ca, cb] = [(await sa.read("/api/companies")) as any[], (await sb.read("/api/companies")) as any[]];
  check(ca.length === 1 && cb.length === 1, `one company each (A ${ca.length}, B ${cb.length})`);
  check(ca[0]?.id !== cb[0]?.id, "the two companies have different ids (own databases)");
  const companyView = (c: any) => ({ name: c.name, status: c.status, requireBoardApprovalForNewAgents: c.requireBoardApprovalForNewAgents, budgetMonthlyCents: c.budgetMonthlyCents });
  check(same(companyView(ca[0]), companyView(cb[0])), "the two companies have the same set-up");
}

// ---------------------------------------------------------------- database log-in (AT-3.5)

async function cmdDbLogin(root: string, passwordFile: string) {
  const { createDb, closeRegisteredClients } = await import("../../packages/db/src/index.js");
  const url = dbUrl(root, passwordFile);
  try {
    await createDb(url).$client.unsafe("select 1");
    process.stdout.write("ok\n");
  } catch (err) {
    process.stdout.write(`refused: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}\n`);
  } finally {
    await closeRegisteredClients(url).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- seed (AT-3.6)

interface Seed {
  marker: string;
  companyId: string;
  companyName: string;
  issueId: string;
  issueIdentifier: string;
  commentId: string;
  documentId: string;
  projectId: string;
  secretId: string;
  secretValue: string;
  userIds: string[];
  emails: string[];
}

/**
 * Business content with a marker in every text: an issue, a comment, a
 * document and a project through the API as the client board user, and an
 * encrypted company secret straight into the database (company secrets are a
 * hidden setting, so the API refuses them on a managed instance).
 */
async function cmdSeed(root: string, marker: string, out: string) {
  const email = env("ISO_CLIENT_EMAIL");
  const client = await signedIn(baseUrl(root), email, env("ISO_CLIENT_PASSWORD"));
  const [company] = (await client.read("/api/companies")) as Array<{ id: string; name: string }>;
  const companyId = company!.id;
  const issue = await client.write("POST", `/api/companies/${companyId}/issues`, { title: `${marker} issue title`, description: `${marker} issue description` });
  const comment = await client.write("POST", `/api/issues/${issue.id}/comments`, { body: `${marker} comment body` });
  const document = await client.write("PUT", `/api/issues/${issue.id}/documents/plan`, { title: `${marker} document title`, format: "markdown", body: `${marker} document body` });
  const project = await client.write("POST", `/api/companies/${companyId}/projects`, { name: `${marker} project` });
  const session = await client.read("/api/auth/get-session");

  // The server's own secrets module, with this instance's master key.
  process.env.GSAM_SECRETS_MASTER_KEY_FILE = masterKeyFile(root);
  const { localEncryptedProvider } = await import("../../server/src/secrets/local-encrypted-provider.js");
  const db = await import("../../packages/db/src/index.js");
  const url = dbUrl(root);
  const secretValue = `${marker}-secret-value`;
  let secretId: string;
  try {
    const conn = db.createDb(url);
    const prepared = await localEncryptedProvider.createSecret({ value: secretValue } as never);
    const [secret] = await conn
      .insert(db.companySecrets)
      .values({ companyId, key: `${marker.toLowerCase()}_secret`, name: `${marker} secret`, description: `${marker} secret description` })
      .returning({ id: db.companySecrets.id });
    secretId = secret!.id;
    await conn.insert(db.companySecretVersions).values({
      secretId,
      version: 1,
      material: prepared.material as Record<string, unknown>,
      valueSha256: prepared.valueSha256,
      fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
    });
  } finally {
    await db.closeRegisteredClients(url);
  }

  const seed: Seed = {
    marker,
    companyId,
    companyName: company!.name,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    commentId: comment.id,
    documentId: document.id ?? document.document?.id,
    projectId: project.id,
    secretId,
    secretValue,
    userIds: [session?.user?.id].filter(Boolean),
    emails: [email],
  };
  for (const [key, value] of Object.entries(seed)) {
    if (value === undefined || value === null || value === "") die(`seed: no ${key} in the answers`);
  }
  writeFileSync(out, `${JSON.stringify(seed)}\n`);
  process.stdout.write(`seeded ${marker}: issue ${seed.issueIdentifier}, comment, document, project, secret\n`);
}

// ---------------------------------------------------------------- decrypt (AT-3.5)

/** Exit 0 when the key opens the secret, 3 when it does not. */
async function cmdDecrypt(root: string, keyFile: string, secretId: string) {
  process.env.GSAM_SECRETS_MASTER_KEY_FILE = keyFile;
  const { localEncryptedProvider } = await import("../../server/src/secrets/local-encrypted-provider.js");
  const db = await import("../../packages/db/src/index.js");
  const url = dbUrl(root);
  let material: Record<string, unknown>;
  try {
    const rows = await db.createDb(url).$client.unsafe("select material from company_secret_versions where secret_id = $1", [secretId]);
    if (!rows[0]) die(`no secret ${secretId}`);
    material = rows[0].material as Record<string, unknown>;
  } finally {
    await db.closeRegisteredClients(url);
  }
  try {
    await localEncryptedProvider.resolveVersion({ material } as never);
    process.stdout.write("decrypted\n");
  } catch (err) {
    process.stdout.write(`refused: ${(err instanceof Error ? err.message : String(err)).split("(")[0]!.trim()}\n`);
    process.exit(3);
  }
}

// ---------------------------------------------------------------- cross access (AT-3.5)

async function cmdCross(rootA: string, rootB: string, seedAFile: string, seedBFile: string) {
  const [baseA, baseB] = [baseUrl(rootA), baseUrl(rootB)];
  const [seedA, seedB] = [readJson<Seed>(seedAFile), readJson<Seed>(seedBFile)];
  const clientEmail = env("ISO_CLIENT_EMAIL");

  // A's log-ins on B: same e-mail (create uses fixed sandbox e-mails), other password.
  for (const [who, email, password] of [
    ["operator", OPERATOR_EMAIL, env("ISO_A_OPERATOR")],
    ["client", clientEmail, env("ISO_A_CLIENT")],
  ] as const) {
    const status = await new Session(baseB).signIn(email, password);
    check(status === 401 || status === 403, `A's ${who} log-in fails on B (sign-in -> ${status})`);
  }

  // A's session cookie on B: B does not know it.
  const onA = await signedIn(baseA, clientEmail, env("ISO_A_CLIENT"));
  check(((await onA.read("/api/companies")) as unknown[]).length === 1, "A's client session works on A (control)");
  const replayed = new Session(baseB);
  replayed.useCookies(onA.cookieJar());
  const sessionOnB = await replayed.request("GET", "/api/auth/get-session");
  check(!sessionOnB.json?.user, `A's session cookie is no session on B (get-session -> ${sessionOnB.status}, no user)`);
  const companiesOnB = await replayed.request("GET", "/api/companies");
  check(companiesOnB.status === 401 || companiesOnB.status === 403, `A's session cookie reads no company on B (-> ${companiesOnB.status})`);

  // B's records through A's port, as A's instance admin and as A's client.
  const operatorA = await signedIn(baseA, OPERATOR_EMAIL, env("ISO_A_OPERATOR"));
  const ownIds = ((await operatorA.read("/api/companies")) as Array<{ id: string }>).map((c) => c.id);
  check(ownIds.length === 1 && ownIds[0] === seedA.companyId && !ownIds.includes(seedB.companyId), "A's port lists only A's company");
  for (const [label, session] of [["A's operator", operatorA], ["A's client", onA]] as const) {
    for (const route of [
      `/api/companies/${seedB.companyId}`,
      `/api/companies/${seedB.companyId}/issues`,
      `/api/issues/${seedB.issueId}`,
      `/api/issues/${seedB.issueId}/comments`,
      `/api/issues/${seedB.issueId}/documents/plan`,
      `/api/projects/${seedB.projectId}`,
    ]) {
      const res = await session.request("GET", route);
      const leaked = res.text.includes(seedB.marker);
      check((res.status === 403 || res.status === 404) && !leaked, `${label}: GET ${route.replace(/[0-9a-f-]{36}/g, "<B id>")} on A -> ${res.status}`);
    }
    // Identifiers (CLI-1) start again in each instance: on A the name finds A's own issue only.
    const byIdentifier = await session.request("GET", `/api/issues/${seedB.issueIdentifier}`);
    check(
      byIdentifier.json?.id !== seedB.issueId && !byIdentifier.text.includes(seedB.marker),
      `${label}: GET /api/issues/${seedB.issueIdentifier} on A -> ${byIdentifier.status}, ${byIdentifier.json?.id === seedA.issueId ? "A's own issue" : "not B's issue"}`,
    );
  }
  // And the other way round, for B's client on B with A's records.
  const onB = await signedIn(baseB, clientEmail, env("ISO_B_CLIENT"));
  for (const route of [`/api/companies/${seedA.companyId}`, `/api/issues/${seedA.issueId}`]) {
    const res = await onB.request("GET", route);
    check((res.status === 403 || res.status === 404) && !res.text.includes(seedA.marker), `B's client: GET ${route.replace(/[0-9a-f-]{36}/g, "<A id>")} on B -> ${res.status}`);
  }
}

// ---------------------------------------------------------------- fleet routes on a client instance (AT-3.5)

const FLEET_ROUTES: Array<[string, string, unknown?]> = [
  ["GET", "/api/fleet/instances"],
  ["POST", "/api/fleet/instances", { code: "c999" }],
  ["POST", "/api/fleet/instances/00000000-0000-0000-0000-000000000000/registration-code", {}],
  ["POST", "/api/fleet/instances/00000000-0000-0000-0000-000000000000/revoke", {}],
  ["GET", "/api/fleet/instances/00000000-0000-0000-0000-000000000000/check-ins"],
  ["POST", "/api/fleet/spoke/register", {}],
  ["POST", "/api/fleet/spoke/check-in", { message: "x.y.z" }],
  ["POST", "/api/fleet/spoke/revoke", { message: "x.y.z" }],
];

async function cmdFleet404(root: string) {
  const base = baseUrl(root);
  const sessions: Array<[string, Session]> = [
    ["client board user", await signedIn(base, env("ISO_CLIENT_EMAIL"), env("ISO_CLIENT_PASSWORD"))],
    ["operator (instance admin)", await signedIn(base, OPERATOR_EMAIL, env("ISO_OPERATOR"))],
    ["no log-in", new Session(base)],
  ];
  for (const [who, session] of sessions) {
    const statuses = [];
    for (const [method, route, body] of FLEET_ROUTES) {
      const res = await session.request(method, route, body);
      statuses.push(res.status);
      if (res.status !== 404) fail(`${who}: ${method} ${route} -> ${res.status}, not 404`);
    }
    if (statuses.every((s) => s === 404)) pass(`${who}: all ${FLEET_ROUTES.length} /api/fleet routes -> 404`);
  }
}

// ---------------------------------------------------------------- forged check-ins (AT-3.5)

function captured(logFile: string): Array<{ path: string; body: any }> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function postHub(hub: string, route: string, body: unknown) {
  const res = await fetch(`${hub}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, error: ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "" };
}

async function cmdForge(rootA: string, rootB: string, hub: string, logFile: string) {
  const keyA = readJson<FleetKey>(path.join(rootA, "fleet/key.json"));
  const regA = readJson<FleetRegistration>(path.join(rootA, "fleet/hub.json"));
  const regB = readJson<FleetRegistration>(path.join(rootB, "fleet/hub.json"));
  const checkIn = buildCheckIn({
    edition: "managed",
    appUp: true,
    newestBackupAt: null,
    releaseTag: null,
    appVersion: null,
    usage: { companies: 1, activeAgents: 0, runsLast24h: 0, spendCentsMonth: 0, budgetCentsMonth: 0, storageBytes: 0 },
    signals: [],
  });
  // A far-future seq: if the hub took it, B's next honest check-in would be refused as a replay.
  const seq = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
  const refused = (r: { status: number; error: string }) => r.status >= 400 && r.status < 500;

  const asB = await postHub(hub, "/api/fleet/spoke/check-in", { message: signFleetMessage(keyA.privateJwk, { act: "check-in", sub: regB.instanceId, seq, checkIn }) });
  check(refused(asB) && asB.error === "fleet_bad_signature", `A's key, check-in as B: hub -> ${asB.status} ${asB.error}`);
  const revokeB = await postHub(hub, "/api/fleet/spoke/revoke", { message: signFleetMessage(keyA.privateJwk, { act: "revoke", sub: regB.instanceId, seq }) });
  check(refused(revokeB) && revokeB.error === "fleet_bad_signature", `A's key, revoke B: hub -> ${revokeB.status} ${revokeB.error}`);

  // A's own honest message, sent again: refused as a replay.
  const mine = captured(logFile).filter((r) => r.path === "/api/fleet/spoke/check-in" && typeof r.body?.message === "string");
  const fromA = mine.filter((r) => JSON.parse(Buffer.from(r.body.message.split(".")[0], "base64url").toString()).kid === regA.instanceId);
  if (fromA.length === 0) {
    fail("no check-in of A was captured to replay");
  } else {
    const replay = await postHub(hub, "/api/fleet/spoke/check-in", { message: fromA.at(-1)!.body.message });
    check(refused(replay) && replay.error === "fleet_replay", `A's captured check-in sent again: hub -> ${replay.status} ${replay.error}`);
    // A's signed payload with B's id put in: the signature no longer matches.
    const [h, c, sig] = fromA.at(-1)!.body.message.split(".");
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const swapped = `${enc({ ...header, kid: regB.instanceId })}.${enc({ ...claims, sub: regB.instanceId, seq })}.${sig}`;
    const swap = await postHub(hub, "/api/fleet/spoke/check-in", { message: swapped });
    check(refused(swap) && swap.error === "fleet_bad_signature", `A's signed check-in re-addressed to B: hub -> ${swap.status} ${swap.error}`);
  }
}

// ---------------------------------------------------------------- capture proxy (AT-3.6)

function cmdProxy(port: number, hub: string, logFile: string, pidFile: string) {
  writeFileSync(pidFile, `${process.pid}\n`);
  createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.url?.startsWith("/ping")) {
        res.end("OK");
        return;
      }
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        /* kept as text */
      }
      appendFileSync(logFile, `${JSON.stringify({ path: req.url, body })}\n`);
      try {
        const upstream = await fetch(`${hub}${req.url}`, { method: req.method, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: raw || undefined });
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(await upstream.text());
      } catch (err) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }).listen(port, "127.0.0.1", () => process.stdout.write(`proxy on ${port}\n`));
}

// ---------------------------------------------------------------- scan (AT-3.6)

/**
 * Every captured check-in (decoded) and every extra JSON file must hold none
 * of the seeded markers, ids (whole, or their first 8 characters), e-mails,
 * company names or secret values.
 */
function cmdScan(logFile: string, rest: string[]) {
  const seeds: Seed[] = [];
  const extras: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--also") extras.push(rest[(i += 1)]!);
    else seeds.push(readJson<Seed>(rest[i]!));
  }
  const needles = new Set<string>();
  for (const s of seeds) {
    needles.add(s.marker);
    needles.add(s.secretValue);
    needles.add(s.issueIdentifier);
    for (const e of s.emails) needles.add(e);
    for (const id of [s.companyId, s.issueId, s.commentId, s.documentId, s.projectId, s.secretId, ...s.userIds]) {
      needles.add(id);
      needles.add(id.slice(0, 8));
    }
  }
  const companyNames = seeds.map((s) => s.companyName);

  const texts: Array<[string, string]> = [];
  let checkIns = 0;
  for (const r of captured(logFile)) {
    texts.push([`raw request to ${r.path}`, JSON.stringify(r.body)]);
    const message = r.body?.message;
    if (typeof message !== "string" || message.split(".").length !== 3) continue;
    const [h, c] = message.split(".");
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    texts.push([`decoded ${claims.act} payload`, `${Buffer.from(h, "base64url").toString()} ${JSON.stringify(claims)}`]);
    if (claims.act !== "check-in") continue;
    checkIns += 1;
    const keys = Object.keys(claims).sort().join(",");
    check(keys === "act,aud,checkIn,exp,iat,seq,sub,v", `check-in ${checkIns}: claims are the fixed set (${keys})`);
    check(Object.keys(claims.checkIn).sort().join(",") === "alerts,edition,health,schema,usage,version", `check-in ${checkIns}: check-in fields are the fixed set`);
  }
  for (const file of extras) texts.push([path.basename(file), readFileSync(file, "utf8")]);
  check(checkIns > 0, `${checkIns} signed check-in(s) captured and decoded`);

  for (const [label, text] of texts) {
    const hits = [...needles].filter((n) => text.includes(n));
    // The default company name is a common word; look for it as a JSON string only.
    const nameHits = companyNames.filter((n) => text.includes(`"${n}"`));
    check(hits.length === 0 && nameHits.length === 0, `${label}: no seeded text, id, e-mail or secret${hits.length || nameHits.length ? ` (found: ${[...hits, ...nameHits].join(", ")})` : ""}`);
  }
}

// ---------------------------------------------------------------- main

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "compare":
    await cmdCompare(args[0]!, args[1]!);
    break;
  case "db-login":
    await cmdDbLogin(args[0]!, args[1]!);
    break;
  case "seed":
    await cmdSeed(args[0]!, args[1]!, args[2]!);
    break;
  case "decrypt":
    await cmdDecrypt(args[0]!, args[1]!, args[2]!);
    break;
  case "cross":
    await cmdCross(args[0]!, args[1]!, args[2]!, args[3]!);
    break;
  case "fleet-404":
    await cmdFleet404(args[0]!);
    break;
  case "forge":
    await cmdForge(args[0]!, args[1]!, args[2]!, args[3]!);
    break;
  case "proxy":
    cmdProxy(Number(args[0]), args[1]!, args[2]!, args[3]!);
    break;
  case "scan":
    cmdScan(args[0]!, args.slice(1));
    break;
  default:
    die(`unknown command ${command ?? ""}`);
}
if (command !== "proxy") process.exit(failures ? 1 : 0);
