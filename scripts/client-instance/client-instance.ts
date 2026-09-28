// One client instance of GS Agentic Manager per client (GRE-86 / GRE-87).
// Run-book: doc/CLIENT-INSTANCES.md.
//
//   scripts/client-instance.sh create --root <dir> --edition managed|managed-plus
//                                     [--passed-features a,b] [--port N] [--db-port N]
//                                     [--company-name X] [--client-email X]
//   scripts/client-instance.sh start|stop|status|backup --root <dir>
//   scripts/client-instance.sh verify --root <dir>     (needs CLIENT_INSTANCE_OPERATOR_PASSWORD)
//
// Each instance lives in its own <root>: config, database, storage, secrets,
// logs and backups, its own server port and its own database port. The
// server gets a clean environment, so nothing from the caller's shell (agent
// tokens, DATABASE_URL, GSAM_HOME) can reach it. Log-ins are printed once to
// this terminal and never written to disk.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { FEEDBACK_DATA_SHARING_PREFERENCES } from "../../packages/shared/src/types/feedback.js";
import { DAILY_RETENTION_PRESETS, DEFAULT_BACKUP_RETENTION } from "../../packages/shared/src/types/instance.js";
import { INSTANCE_FEATURE_KEYS } from "../../packages/shared/src/feature-catalog.js";
import { parseHiddenSettingsList } from "../../packages/shared/src/settings-visibility.js";
import { EDITIONS, buildEditionValues, type Edition, type EditionValues } from "./editions.js";

const CODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INSTANCE_ID = "default";
const STATE_FILE = "client-instance.json";
const PID_FILE = "server.pid";
const LOG_FILE = "server.log";
const FORBIDDEN_PORTS = new Set([3100, 3200, 54329]);
const OPERATOR_EMAIL = "operator@instance.invalid";

interface InstanceState {
  edition: Edition;
  passedBetaFeatures: string[];
  port: number;
  dbPort: number;
  createdAt: string;
}

function say(message: string) {
  process.stdout.write(`client-instance: ${message}\n`);
}

function die(message: string): never {
  process.stderr.write(`client-instance: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) die(`unexpected argument "${arg}"`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) die(`${arg} needs a value`);
    opts[arg.slice(2)] = value;
    i += 1;
  }
  return { command, opts };
}

// ---------------------------------------------------------------- paths and guards

function resolveRoot(raw: string | undefined): string {
  if (!raw) die("--root <dir> is required");
  const root = path.resolve(raw.replace(/^~(?=$|\/)/, homedir()));
  // Both $HOME and the account's real home: a changed HOME must not open a way into the live folders.
  const homes = [...new Set([homedir(), userInfo().homedir])];
  const forbidden = homes.flatMap((home) => [path.join(home, "GSAM"), path.join(home, ".gsam")]);
  const real = existsSync(root) ? realpathSync(root) : root;
  for (const dir of forbidden) {
    const realDir = existsSync(dir) ? realpathSync(dir) : dir;
    if (real === realDir || real.startsWith(`${realDir}${path.sep}`) || root.startsWith(`${dir}${path.sep}`)) {
      die(`${root} is inside ${dir}; a client instance must never use the live app's folders`);
    }
  }
  return root;
}

const instanceDir = (root: string) => path.join(root, "instances", INSTANCE_ID);
const configPath = (root: string) => path.join(instanceDir(root), "config.json");
const backupDir = (root: string) => path.join(instanceDir(root), "data", "backups");

function readState(root: string): InstanceState {
  const file = path.join(root, STATE_FILE);
  if (!existsSync(file)) die(`no client instance at ${root} (missing ${STATE_FILE})`);
  return JSON.parse(readFileSync(file, "utf8")) as InstanceState;
}

function checkPort(port: number, label: string) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) die(`${label} ${port} is not a valid port`);
  if (FORBIDDEN_PORTS.has(port)) die(`${label} ${port} is reserved for the live app or its preview`);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function firstFreePort(from: number, to: number, skip: Set<number>): Promise<number> {
  for (let port = from; port <= to; port += 1) {
    if (FORBIDDEN_PORTS.has(port) || skip.has(port)) continue;
    if (await portFree(port)) return port;
  }
  die(`no free port between ${from} and ${to}`);
}

// ---------------------------------------------------------------- config

function writeInstanceFiles(root: string, state: InstanceState) {
  const dir = instanceDir(root);
  mkdirSync(dir, { recursive: true });
  const config = {
    $meta: { version: 1, updatedAt: new Date().toISOString(), source: "onboard" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(dir, "db"),
      embeddedPostgresPort: state.dbPort,
      backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: backupDir(root) },
    },
    logging: { mode: "file", logDir: path.join(dir, "logs") },
    server: {
      deploymentMode: "authenticated",
      exposure: "private",
      bind: "loopback",
      host: "127.0.0.1",
      port: state.port,
      allowedHostnames: [],
      serveUi: true,
    },
    telemetry: { enabled: false },
    updates: { checkEnabled: false },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: path.join(dir, "data", "storage") },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: path.join(dir, "secrets", "master.key") },
    },
  };
  writeFileSync(configPath(root), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // The auth secret is made here and stays in this instance only.
  writeFileSync(path.join(dir, ".env"), `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  writeFileSync(path.join(root, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

function catalogVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(CODE_DIR, "server", "package.json"), "utf8")) as { version?: string };
  return pkg.version || "0.0.0";
}

function editionValues(state: InstanceState): EditionValues {
  return buildEditionValues({
    edition: state.edition,
    passedBetaFeatures: state.passedBetaFeatures,
    catalogVersion: catalogVersion(),
  });
}

/** The only variables the server and the CLI get. */
function cleanEnv(root: string, state: InstanceState, extra: Record<string, string>): Record<string, string> {
  const pick = (key: string) => (process.env[key] ? { [key]: process.env[key]! } : {});
  return {
    ...pick("HOME"),
    ...pick("USER"),
    ...pick("LOGNAME"),
    ...pick("LANG"),
    ...pick("TMPDIR"),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    SHELL: "/bin/bash",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    GSAM_HOME: root,
    GSAM_INSTANCE_ID: INSTANCE_ID,
    GSAM_CONFIG: configPath(root),
    PORT: String(state.port),
    GSAM_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    ...extra,
  };
}

// ---------------------------------------------------------------- server process

function readPid(root: string): number | null {
  const file = path.join(root, PID_FILE);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

const baseUrl = (state: InstanceState) => `http://127.0.0.1:${state.port}`;

async function health(state: InstanceState): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${baseUrl(state)}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Start the server. `provision` starts it once without GSAM_MANAGED_CONFIG,
 * only to make the operator, the company and the client log-in: the app
 * refuses company creation while GSAM_MANAGED_CONFIG is set. Every normal
 * start sets both edition values.
 */
async function startServer(root: string, state: InstanceState, mode: "normal" | "provision") {
  if (readPid(root)) die(`the instance at ${root} is already running (pid ${readPid(root)})`);
  if (!(await portFree(state.port))) die(`port ${state.port} is in use by another process`);
  if (!(await portFree(state.dbPort))) die(`database port ${state.dbPort} is in use by another process`);
  const values = editionValues(state);
  const env = cleanEnv(root, state, {
    GSAM_HIDDEN_SETTINGS: values.hiddenSettings,
    ...(mode === "normal" ? { GSAM_MANAGED_CONFIG: values.managedConfig } : {}),
  });
  env.GSAM_MIGRATION_AUTO_APPLY = "true";
  env.GSAM_MIGRATION_PROMPT = "never";
  // Serve the built UI when this checkout has one, else the UI dev middleware.
  env.GSAM_UI_DEV_MIDDLEWARE = existsSync(path.join(CODE_DIR, "ui", "dist", "index.html")) ? "false" : "true";
  const log = openSync(path.join(root, LOG_FILE), "a");
  // The server loads the plugin SDK from its build output (the dev runner
  // builds it the same way).
  if (!existsSync(path.join(CODE_DIR, "packages", "plugins", "sdk", "dist", "index.js"))) {
    say("building the plugin SDK (first start of this checkout)");
    const built = spawnSync("pnpm", ["--filter", "@greatstone/plugin-sdk", "build"], { cwd: CODE_DIR, env, stdio: ["ignore", log, log] });
    if (built.status !== 0) die(`plugin SDK build failed; see ${path.join(root, LOG_FILE)}`);
  }
  // The server itself, not the dev runner (which serves one checkout's own
  // data), in its own process group so stop can end it and its database.
  const child = spawn("pnpm", ["--filter", "@greatstone/server", "exec", "tsx", "src/index.ts"], {
    cwd: CODE_DIR,
    env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(path.join(root, PID_FILE), `${child.pid}\n`);
  say(`starting ${mode === "provision" ? "(setup only, no edition features yet) " : ""}on ${baseUrl(state)} (log: ${path.join(root, LOG_FILE)})`);
  for (let i = 0; i < 150; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (!readPid(root)) die(`the server exited; see ${path.join(root, LOG_FILE)}`);
    const body = await health(state);
    if (body?.status === "ok") {
      if (body.deploymentMode !== undefined && body.deploymentMode !== "authenticated") {
        await stopServer(root, state);
        die(`the server started in "${String(body.deploymentMode)}" mode, not "authenticated"; stopped it`);
      }
      say(`up on ${baseUrl(state)}`);
      return;
    }
  }
  die(`the server did not answer within 5 minutes; see ${path.join(root, LOG_FILE)}`);
}

async function stopServer(root: string, state: InstanceState) {
  const pid = readPid(root);
  if (pid) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 30 && readPid(root); i += 1) await new Promise((r) => setTimeout(r, 1000));
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // The embedded database, if it outlived the server.
  const pgPidFile = path.join(instanceDir(root), "db", "postmaster.pid");
  if (existsSync(pgPidFile)) {
    const pgPid = Number(readFileSync(pgPidFile, "utf8").split("\n")[0]);
    if (Number.isInteger(pgPid) && pgPid > 0) {
      try {
        process.kill(pgPid, "SIGINT");
        for (let i = 0; i < 20; i += 1) {
          process.kill(pgPid, 0);
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch {
        /* stopped */
      }
    }
  }
  writeFileSync(path.join(root, PID_FILE), "");
  if (!(await portFree(state.port))) die(`port ${state.port} is still in use after stop`);
  say("stopped");
}

function runCli(root: string, state: InstanceState, args: string[]): string {
  const result = spawnSync("pnpm", ["--silent", "gsam", ...args, "--data-dir", root], {
    cwd: CODE_DIR,
    env: cleanEnv(root, state, {}),
    encoding: "utf8",
  });
  if (result.status !== 0) die(`gsam ${args[0]} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

// ---------------------------------------------------------------- HTTP session

class Session {
  private cookies = new Map<string, string>();
  constructor(private readonly base: string) {}

  async request(method: string, route: string, body?: unknown) {
    const headers: Record<string, string> = { Origin: this.base, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookies.size > 0) {
      headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const res = await fetch(`${this.base}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      if (eq > 0) this.cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, text };
  }

  async expect(method: string, route: string, body: unknown, okStatuses: number[]) {
    const res = await this.request(method, route, body);
    if (!okStatuses.includes(res.status)) {
      die(`${method} ${route} returned ${res.status}: ${res.text.slice(0, 300)}`);
    }
    return res.json as Record<string, any>;
  }

  async signUp(name: string, email: string, password: string) {
    await this.expect("POST", "/api/auth/sign-up/email", { name, email, password }, [200]);
  }

  async signIn(email: string, password: string) {
    await this.expect("POST", "/api/auth/sign-in/email", { email, password }, [200]);
  }
}

function newPassword() {
  return randomBytes(18).toString("base64url");
}

// ---------------------------------------------------------------- verify

interface CheckResult {
  ok: boolean;
  line: string;
}

async function verifyInstance(root: string, state: InstanceState, operator: Session, client: Session | null) {
  const values = editionValues(state);
  const results: CheckResult[] = [];
  const check = (ok: boolean, line: string) => results.push({ ok, line });

  const healthBody = (await health(state)) ?? {};
  check(healthBody.status === "ok", `health is ok on port ${state.port}`);
  const expectedHidden = parseHiddenSettingsList(values.hiddenSettings).hidden;
  const shownHidden = new Set(Array.isArray(healthBody.hiddenSettings) ? (healthBody.hiddenSettings as string[]) : []);
  const missingHidden = expectedHidden.filter((key) => !shownHidden.has(key));
  check(missingHidden.length === 0, `all ${expectedHidden.length} hidden settings are hidden${missingHidden.length ? ` (missing: ${missingHidden.join(", ")})` : ""}`);

  // Features.
  const experimental = await operator.expect("GET", "/api/instance/settings/experimental", undefined, [200]);
  for (const key of values.expectOn) check(experimental[key] === true, `feature ${key} is on`);
  for (const key of values.expectOff) check(experimental[key] === false, `feature ${key} is off`);
  const managedKeys = (experimental.managedKeys ?? {}) as Record<string, unknown>;
  check(Object.keys(managedKeys).length > 0, "GSAM_MANAGED_CONFIG is applied (managed keys reported)");

  // Each hidden setting: a change request must fail with 403. When the request
  // is not refused, the change is put back and the check fails.
  const floored = async (label: string, method: string, route: string, body: unknown, codes: string[], revert?: () => Promise<unknown>) => {
    const res = await operator.request(method, route, body);
    const matched = codes.find((code) => res.text.includes(code));
    const ok = res.status === 403 && matched !== undefined;
    if (!ok && res.status < 300 && revert) await revert();
    check(ok, `${label}: ${method} ${route} -> ${res.status}${matched ? ` ${matched}` : ""}`);
  };
  const OPERATOR_MANAGED = ["settings_operator_managed"];

  for (const key of INSTANCE_FEATURE_KEYS) {
    const current = experimental[key] === true;
    await floored(
      `instance.experimental.${key}`,
      "PATCH",
      "/api/instance/settings/experimental",
      { [key]: !current },
      OPERATOR_MANAGED,
      () => operator.request("PATCH", "/api/instance/settings/experimental", { [key]: current }),
    );
  }
  const general = await operator.expect("GET", "/api/instance/settings/general", undefined, [200]);
  const currentRetention = { ...DEFAULT_BACKUP_RETENTION, ...(general.backupRetention ?? {}) };
  const otherDaily = DAILY_RETENTION_PRESETS.find((days) => days !== currentRetention.dailyDays);
  await floored(
    "instance.general.backupRetention",
    "PATCH",
    "/api/instance/settings/general",
    { backupRetention: { ...currentRetention, dailyDays: otherDaily } },
    OPERATOR_MANAGED,
    () => operator.request("PATCH", "/api/instance/settings/general", { backupRetention: currentRetention }),
  );
  const otherFeedback = FEEDBACK_DATA_SHARING_PREFERENCES.find((p) => p !== general.feedbackDataSharingPreference);
  await floored(
    "instance.general.feedbackDataSharingPreference",
    "PATCH",
    "/api/instance/settings/general",
    { feedbackDataSharingPreference: otherFeedback },
    OPERATOR_MANAGED,
    () => operator.request("PATCH", "/api/instance/settings/general", { feedbackDataSharingPreference: general.feedbackDataSharingPreference }),
  );
  await floored(
    "instance.adapters",
    "PATCH",
    "/api/adapters/claude_local",
    { disabled: true },
    OPERATOR_MANAGED,
    () => operator.request("PATCH", "/api/adapters/claude_local", { disabled: false }),
  );
  await floored("instance.plugins", "POST", "/api/plugins/install", { packageName: "sandbox-check-not-a-plugin" }, OPERATOR_MANAGED);
  await floored("instance.access", "GET", "/api/admin/users", undefined, OPERATOR_MANAGED);
  // A managed instance refuses import before the hidden-settings floor runs.
  await floored("company.import", "POST", "/api/companies/import/preview", {}, [...OPERATOR_MANAGED, "cloud_managed"]);

  // Company and client log-in.
  const companies = (await operator.expect("GET", "/api/companies", undefined, [200])) as unknown as unknown[];
  check(Array.isArray(companies) && companies.length === 1, `exactly one company (found ${Array.isArray(companies) ? companies.length : "?"})`);
  if (client) {
    const clientCompanies = (await client.expect("GET", "/api/companies", undefined, [200])) as unknown as unknown[];
    check(Array.isArray(clientCompanies) && clientCompanies.length === 1, "the client log-in sees its one company");
    // Releases are hidden on every client edition (GRE-129): 403 even for the client's board log-in.
    const companyId = (clientCompanies[0] as { id?: string } | undefined)?.id;
    const releases = await client.request("GET", `/api/companies/${companyId}/releases`);
    check(
      releases.status === 403 && releases.text.includes("settings_operator_managed"),
      `instance.releases: the client log-in gets 403 on GET /api/companies/:id/releases (-> ${releases.status})`,
    );
    const res = await client.request("PATCH", "/api/instance/settings/experimental", { enablePipelines: true });
    check(res.status === 403, `the client log-in is not an instance admin (PATCH experimental -> ${res.status})`);
  }

  const signUp = await new Session(baseUrl(state)).request("POST", "/api/auth/sign-up/email", {
    name: "Sign-up check",
    email: "signup-check@instance.invalid",
    password: newPassword(),
  });
  check(signUp.status >= 400, `new sign-ups are refused (-> ${signUp.status})`);

  // Settings that only hide the UI: say so, do not claim a 403.
  const uiOnly = ["instance.environments", "company.secrets", "company.export", "company.invites"];
  for (const key of uiOnly) {
    check(shownHidden.has(key), `${key} is hidden in the UI (the app has no 403 route for it)`);
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) say(`${r.ok ? "PASS" : "FAIL"} ${r.line}`);
  say(`${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0;
}

// ---------------------------------------------------------------- backup

function backupNow(root: string, state: InstanceState): string {
  const out = runCli(root, state, ["db:backup", "--json", "--filename-prefix", "client-instance"]);
  const match = out.match(/\{[\s\S]*\}/);
  const parsed = match ? (JSON.parse(match[0]) as { backupFile?: string }) : {};
  const file = parsed.backupFile;
  if (!file || !existsSync(file)) die(`backup did not report a file:\n${out}`);
  const real = realpathSync(file);
  if (!real.startsWith(`${realpathSync(backupDir(root))}${path.sep}`)) {
    die(`backup was written outside this instance: ${real}`);
  }
  return real;
}

// ---------------------------------------------------------------- commands

async function cmdCreate(opts: Record<string, string>) {
  const root = resolveRoot(opts.root);
  const edition = (opts.edition ?? "managed") as Edition;
  if (!EDITIONS.includes(edition)) die(`--edition must be one of: ${EDITIONS.join(", ")}`);
  const passed = (opts["passed-features"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (edition === "managed-plus" && opts["passed-features"] === undefined) {
    die("managed-plus needs --passed-features: the beta features whose Beacon verdict (GRE-81) has passed (\"\" for none)");
  }
  if (existsSync(root) && readdirSync(root).length > 0) die(`${root} is not empty; pick a new folder for a new instance`);

  const port = opts.port ? Number(opts.port) : await firstFreePort(3300, 3399, new Set());
  const dbPort = opts["db-port"] ? Number(opts["db-port"]) : await firstFreePort(55400, 55499, new Set([port]));
  checkPort(port, "--port");
  checkPort(dbPort, "--db-port");
  if (port === dbPort) die("--port and --db-port must differ");

  const state: InstanceState = { edition, passedBetaFeatures: [...passed].sort(), port, dbPort, createdAt: new Date().toISOString() };
  editionValues(state); // fail before anything is written
  mkdirSync(root, { recursive: true });
  writeInstanceFiles(root, state);
  say(`instance folder ${root}, edition ${edition}${passed.length ? ` + ${passed.join(", ")}` : ""}, port ${port}, database port ${dbPort}`);

  // 1. Setup start: operator (instance admin), one company, one client log-in.
  await startServer(root, state, "provision");
  const base = baseUrl(state);
  const bootstrapOut = runCli(root, state, ["auth", "bootstrap-ceo", "--base-url", base]);
  const token = bootstrapOut.match(/pcp_bootstrap_[0-9a-f]+/)?.[0];
  if (!token) die(`no bootstrap invite in:\n${bootstrapOut}`);

  const operatorPassword = newPassword();
  const operator = new Session(base);
  await operator.signUp("Greatstone operator", OPERATOR_EMAIL, operatorPassword);
  await operator.expect("POST", `/api/invites/${token}/accept`, { requestType: "human" }, [200, 202]);

  const company = await operator.expect("POST", "/api/companies", { name: opts["company-name"] ?? "Client company" }, [200, 201]);
  const invite = await operator.expect(
    "POST",
    `/api/companies/${company.id}/invites`,
    { allowedJoinTypes: "human", humanRole: "owner" },
    [200, 201],
  );
  const clientEmail = opts["client-email"] ?? "client@instance.invalid";
  const clientPassword = newPassword();
  const client = new Session(base);
  await client.signUp("Client board member", clientEmail, clientPassword);
  await client.expect("POST", `/api/invites/${invite.token}/accept`, { requestType: "human" }, [200, 201, 202]);
  await stopServer(root, state);
  // Both log-ins exist; nobody else may sign up.
  const config = JSON.parse(readFileSync(configPath(root), "utf8"));
  config.auth.disableSignUp = true;
  writeFileSync(configPath(root), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  // 2. Normal start with both edition values, then prove it.
  await startServer(root, state, "normal");
  const operatorAgain = new Session(base);
  await operatorAgain.signIn(OPERATOR_EMAIL, operatorPassword);
  const clientAgain = new Session(base);
  await clientAgain.signIn(clientEmail, clientPassword);
  const ok = await verifyInstance(root, state, operatorAgain, clientAgain);
  const backupFile = backupNow(root, state);
  say(`backup written: ${backupFile}`);

  // Printed once. Not written to any file or log.
  process.stdout.write(
    [
      "",
      "Log-ins (shown once; give them to John, do not store them in the app, issues or logs):",
      `  URL:       ${base}`,
      `  Operator:  ${OPERATOR_EMAIL} / ${operatorPassword}   (instance admin, Greatstone only)`,
      `  Client:    ${clientEmail} / ${clientPassword}   (board owner of the one company)`,
      "",
    ].join("\n"),
  );
  if (!ok) die("some checks failed; the instance is running so you can look, stop it with: stop --root");
}

async function cmdVerify(root: string, state: InstanceState) {
  const password = process.env.CLIENT_INSTANCE_OPERATOR_PASSWORD;
  if (!password) die("set CLIENT_INSTANCE_OPERATOR_PASSWORD to the operator password");
  const operator = new Session(baseUrl(state));
  await operator.signIn(OPERATOR_EMAIL, password);
  if (!(await verifyInstance(root, state, operator, null))) process.exit(1);
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (command === "create") return cmdCreate(opts);
  const root = resolveRoot(opts.root);
  const state = readState(root);
  switch (command) {
    case "start":
      return startServer(root, state, "normal");
    case "stop":
      return stopServer(root, state);
    case "status": {
      const body = await health(state);
      const pid = readPid(root);
      say(`${root}: edition ${state.edition}${state.passedBetaFeatures.length ? ` + ${state.passedBetaFeatures.join(", ")}` : ""}, port ${state.port}, database port ${state.dbPort}`);
      say(pid ? `running (pid ${pid}), health ${String(body?.status ?? "no answer")}` : "not running");
      return;
    }
    case "backup":
      if (!readPid(root)) die("the instance is not running; start it first (the backup reads the running database)");
      say(`backup written: ${backupNow(root, state)}`);
      return;
    case "verify":
      return cmdVerify(root, state);
    default:
      die("usage: create|start|stop|status|backup|verify --root <dir> (see doc/CLIENT-INSTANCES.md)");
  }
}

try {
  await main();
} catch (err) {
  die(err instanceof Error ? err.message : String(err));
}
