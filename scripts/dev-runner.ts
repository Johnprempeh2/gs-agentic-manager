#!/usr/bin/env -S node --import tsx
// Adopt legacy env names (packages/shared/src/legacy-env.ts) before any module reads process.env.
import "../packages/shared/src/legacy-env-bootstrap.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createMigrationStatusTracker } from "./dev-runner-migration-status.ts";
import { createCapturedOutputBuffer, parseJsonResponseWithLimit } from "./dev-runner-output.ts";
import {
  paperclipRunnerBinaryNeedsBuild,
  resolveNativeRunnerRequirement,
} from "./dev-runner-native-binary.mjs";
import { applyDevRunnerOptions } from "./dev-runner-options.ts";
import {
  SERVER_TREE_STOP_TIMEOUT_MS,
  serverChildUsesProcessGroup,
  signalServerProcessTreeOnExit,
  stopServerProcessTree,
  type ServerChildExit,
  type ServerProcessTree,
  type StopServerProcessTreeResult,
} from "./dev-runner-process.ts";
import { collectWatchedSnapshot as collectDevServerWatchedSnapshot, diffSnapshots } from "./dev-runner-snapshot.mjs";
import { createDevServiceIdentity, repoRoot } from "./dev-service-profile.ts";
import { bootstrapDevRunnerWorktreeEnv, shouldBlockDevRunnerForPendingSeed } from "../server/src/dev-runner-worktree.ts";
import { applySharedRunnerBuildDir } from "../server/src/runner-build-dir.ts";
import {
  readDevServerRestartRequest,
  removeDevServerRestartRequest,
} from "../server/src/dev-server-status.ts";
import {
  findAdoptableLocalService,
  removeLocalServiceRegistryRecord,
  touchLocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
} from "../server/src/services/local-service-supervisor.ts";

// Keep these values local so the dev runner can boot from the server package's
// tsx context without requiring workspace package resolution first.
const BIND_MODES = ["loopback", "lan", "tailnet", "custom"] as const;
type BindMode = (typeof BIND_MODES)[number];

const mode = process.argv[2] === "watch" ? "watch" : "dev";
let cliArgs: string[];
let dataDir: string | null;
try {
  const appliedOptions = applyDevRunnerOptions(process.argv.slice(3), process.env, repoRoot);
  cliArgs = appliedOptions.forwardedArgs;
  dataDir = appliedOptions.dataDir;
} catch (error) {
  console.error(`[paperclip] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const worktreeEnvBootstrap = bootstrapDevRunnerWorktreeEnv(repoRoot, process.env);
if (worktreeEnvBootstrap.missingEnv) {
  console.error(
    `[paperclip] linked git worktree at ${repoRoot} is missing ${path.relative(repoRoot, worktreeEnvBootstrap.envPath)}. Run \`gsam worktree init\` in this worktree before \`pnpm dev\`.`,
  );
  process.exit(1);
}
// Before any child starts: the runner build below, the server and, through the
// server, every local agent run and worktree provision inherit it (GRE-210).
applySharedRunnerBuildDir(process.env);
if (shouldBlockDevRunnerForPendingSeed(repoRoot, dataDir)) {
  console.error(
    "[paperclip] this worktree database is seed-pending. Run `pnpm gsam worktree ensure-seeded` before `pnpm dev`, or start an isolated sandbox with `pnpm dev:once --data-dir ./tmp/sandbox`.",
  );
  process.exit(1);
}

const scanIntervalMs = 1500;
const autoRestartPollIntervalMs = 2500;
const gracefulShutdownTimeoutMs = SERVER_TREE_STOP_TIMEOUT_MS;
const changedPathSampleLimit = 5;
const devServerStatusFilePath = path.join(repoRoot, ".gsam", "dev-server-status.json");
const devServerRestartRequestFilePath = path.join(repoRoot, ".gsam", "dev-server-restart-request.json");
const devServerStatusToken = mode === "dev" ? randomUUID() : null;
const devServerStatusTokenHeader = "x-paperclip-dev-server-status-token";

const watchedDirectories = [
  "cli",
  "scripts",
  "server",
  "packages/adapter-utils",
  "packages/adapters",
  "packages/db",
  "packages/skills-catalog",
  "packages/plugins/sdk",
  "packages/shared",
].map((relativePath) => path.join(repoRoot, relativePath));

const watchedFiles = [
  ".env",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
].map((relativePath) => path.join(repoRoot, relativePath));

const ignoredDirectoryNames = new Set([
  ".git",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "ui-dist",
]);

const ignoredRelativePaths = new Set([
  ".gsam/dev-server-restart-request.json",
  ".gsam/dev-server-status.json",
]);

const tailscaleAuthFlagNames = new Set([
  "--tailscale-auth",
  "--authenticated-private",
]);

let tailscaleAuth = false;
let bindMode: BindMode | null = null;
let bindHost: string | null = null;
const managedRuntimeExposure = process.env.GSAM_MANAGED_RUNTIME_EXPOSURE === "tailscale_https";
const forwardedArgs: string[] = [];

for (let index = 0; index < cliArgs.length; index += 1) {
  const arg = cliArgs[index];
  if (tailscaleAuthFlagNames.has(arg)) {
    tailscaleAuth = true;
    continue;
  }
  if (arg === "--bind") {
    const value = cliArgs[index + 1];
    if (!value || value.startsWith("--") || !BIND_MODES.includes(value as BindMode)) {
      console.error(`[paperclip] invalid --bind value. Use one of: ${BIND_MODES.join(", ")}`);
      process.exit(1);
    }
    bindMode = value as BindMode;
    index += 1;
    continue;
  }
  if (arg === "--bind-host") {
    const value = cliArgs[index + 1];
    if (!value || value.startsWith("--")) {
      console.error("[paperclip] --bind-host requires a value");
      process.exit(1);
    }
    bindHost = value;
    index += 1;
    continue;
  }
  forwardedArgs.push(arg);
}

if (process.env.npm_config_tailscale_auth === "true") {
  tailscaleAuth = true;
}
if (process.env.npm_config_authenticated_private === "true") {
  tailscaleAuth = true;
}
if (!bindMode && process.env.npm_config_bind && BIND_MODES.includes(process.env.npm_config_bind as BindMode)) {
  bindMode = process.env.npm_config_bind as BindMode;
}
if (!bindHost && process.env.npm_config_bind_host) {
  bindHost = process.env.npm_config_bind_host;
}
if (managedRuntimeExposure) {
  bindMode = "custom";
  bindHost = "127.0.0.1";
}
if (bindMode === "custom" && !bindHost) {
  console.error("[paperclip] --bind custom requires --bind-host <host>");
  process.exit(1);
}

// Managed HTTPS runtimes serve the built UI bundle: the Vite dev middleware's
// unbundled module waterfall stalls behind the Tailscale HTTPS proxy and the
// first page load in a fresh browser profile stays blank forever (PAP-18043).
const explicitUiDevMiddleware = process.env.GSAM_UI_DEV_MIDDLEWARE;
const serveBuiltUiForManagedRuntime = managedRuntimeExposure && explicitUiDevMiddleware === undefined;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GSAM_UI_DEV_MIDDLEWARE: explicitUiDevMiddleware ?? (serveBuiltUiForManagedRuntime ? "false" : "true"),
};

if (mode === "dev") {
  env.GSAM_DEV_SERVER_STATUS_FILE = devServerStatusFilePath;
  env.GSAM_DEV_SERVER_STATUS_TOKEN = devServerStatusToken ?? "";
  env.GSAM_MIGRATION_AUTO_APPLY ??= "true";
}

if (mode === "watch") {
  delete env.GSAM_DEV_SERVER_STATUS_TOKEN;
  env.GSAM_MIGRATION_PROMPT ??= "never";
  env.GSAM_MIGRATION_AUTO_APPLY ??= "true";
}

if (tailscaleAuth || bindMode) {
  const effectiveBind = bindMode ?? "lan";
  if (tailscaleAuth) {
    console.log("[paperclip] note: --tailscale-auth/--authenticated-private are legacy aliases for --bind lan");
  }
  env.GSAM_BIND = effectiveBind;
  if (bindHost) {
    env.GSAM_BIND_HOST = bindHost;
  } else {
    delete env.GSAM_BIND_HOST;
  }
  if (effectiveBind === "loopback" && !tailscaleAuth) {
    delete env.GSAM_DEPLOYMENT_MODE;
    delete env.GSAM_DEPLOYMENT_EXPOSURE;
    delete env.GSAM_AUTH_BASE_URL_MODE;
    console.log("[paperclip] dev mode: local_trusted (bind=loopback)");
  } else {
    env.GSAM_DEPLOYMENT_MODE = "authenticated";
    env.GSAM_DEPLOYMENT_EXPOSURE = "private";
    env.GSAM_AUTH_BASE_URL_MODE = managedRuntimeExposure ? "explicit" : "auto";
    console.log(
      `[paperclip] dev mode: authenticated/private (bind=${effectiveBind}${bindHost ? `:${bindHost}` : ""})`,
    );
  }
} else {
  delete env.GSAM_BIND;
  delete env.GSAM_BIND_HOST;
  delete env.GSAM_DEPLOYMENT_MODE;
  delete env.GSAM_DEPLOYMENT_EXPOSURE;
  delete env.GSAM_AUTH_BASE_URL_MODE;
  console.log("[paperclip] dev mode: local_trusted (default)");
}

const serverPort = Number.parseInt(env.PORT ?? process.env.PORT ?? "3100", 10) || 3100;
const devService = createDevServiceIdentity({
  mode,
  forwardedArgs: dataDir ? [...forwardedArgs, `--data-dir=${dataDir}`] : forwardedArgs,
  networkProfile: tailscaleAuth ? `legacy:${bindMode ?? "lan"}` : (bindMode ?? "default"),
  port: serverPort,
});

const existingRunner = await findAdoptableLocalService({
  serviceKey: devService.serviceKey,
  cwd: repoRoot,
  envFingerprint: devService.envFingerprint,
  port: serverPort,
});
if (existingRunner) {
  console.log(
    `[paperclip] ${devService.serviceName} already running (pid ${existingRunner.pid}${typeof existingRunner.metadata?.childPid === "number" ? `, child ${existingRunner.metadata.childPid}` : ""})`,
  );
  process.exit(0);
}

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let previousSnapshot = collectWatchedSnapshot();
let dirtyPaths = new Set<string>();
let pendingMigrations: string[] = [];
let lastChangedAt: string | null = null;
let lastRestartAt: string | null = null;
let scanInFlight = false;
let restartInFlight = false;
let shuttingDown = false;
let childExitWasExpected = false;
let child: ReturnType<typeof spawn> | null = null;
let childExitPromise: Promise<ServerChildExit> | null = null;
// The server child's whole process tree (see dev-runner-process.ts). It stays
// set after the head exits until the runner knows the rest of the tree is gone.
let serverTree: ServerProcessTree | null = null;
let serverTreeStop: {
  tree: ServerProcessTree;
  promise: Promise<StopServerProcessTreeResult>;
} | null = null;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let autoRestartTimer: ReturnType<typeof setInterval> | null = null;

function toError(error: unknown, context = "Dev runner command failed") {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(context);
  if (typeof error === "string") return new Error(`${context}: ${error}`);

  try {
    return new Error(`${context}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${context}: ${String(error)}`);
  }
}

process.on("uncaughtException", async (error) => {
  await removeLocalServiceRegistryRecord(devService.serviceKey);
  const err = toError(error, "Uncaught exception in dev runner");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  await removeLocalServiceRegistryRecord(devService.serviceKey);
  const err = toError(reason, "Unhandled promise rejection in dev runner");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});

function formatPendingMigrationSummary(migrations: string[]) {
  if (migrations.length === 0) return "none";
  return migrations.length > 3
    ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
    : migrations.join(", ");
}

function exitForSignal(signal: NodeJS.Signals) {
  if (signal === "SIGINT") {
    process.exit(130);
  }
  if (signal === "SIGTERM") {
    process.exit(143);
  }
  if (signal === "SIGHUP") {
    process.exit(129);
  }
  process.exit(1);
}

function logServerTree(message: string) {
  process.stderr.write(`[paperclip] ${message}\n`);
}

function collectWatchedSnapshot() {
  return collectDevServerWatchedSnapshot({
    repoRoot,
    watchedDirectories,
    watchedFiles,
    ignoredDirectoryNames,
    ignoredRelativePaths,
  }) as Map<string, string>;
}

function ensureDevStatusDirectory() {
  mkdirSync(path.dirname(devServerStatusFilePath), { recursive: true });
}

function writeDevServerStatus() {
  if (mode !== "dev") return;

  ensureDevStatusDirectory();
  const changedPaths = [...dirtyPaths].sort();
  writeFileSync(
    devServerStatusFilePath,
    `${JSON.stringify({
      dirty: changedPaths.length > 0 || pendingMigrations.length > 0,
      lastChangedAt,
      changedPathCount: changedPaths.length,
      changedPathsSample: changedPaths.slice(0, changedPathSampleLimit),
      pendingMigrations,
      lastRestartAt,
      // Lets the server tell a live supervisor from a stale file (GRE-166).
      supervisorPid: process.pid,
    }, null, 2)}\n`,
    "utf8",
  );
}

function clearDevServerStatus() {
  if (mode !== "dev") return;
  rmSync(devServerStatusFilePath, { force: true });
  rmSync(devServerRestartRequestFilePath, { force: true });
}

function getDevServerRestartRequest() {
  if (mode !== "dev" || !existsSync(devServerRestartRequestFilePath)) return null;
  return readDevServerRestartRequest(env);
}

async function updateDevServiceRecord(extra?: Record<string, unknown>) {
  await writeLocalServiceRegistryRecord({
    version: 1,
    serviceKey: devService.serviceKey,
    profileKind: "paperclip-dev",
    serviceName: devService.serviceName,
    command: "dev-runner.ts",
    cwd: repoRoot,
    envFingerprint: devService.envFingerprint,
    port: serverPort,
    url: `http://127.0.0.1:${serverPort}`,
    pid: process.pid,
    processGroupId: null,
    provider: "local_process",
    runtimeServiceId: null,
    reuseKey: null,
    startedAt: lastRestartAt ?? new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    metadata: {
      repoRoot,
      mode,
      childPid: child?.pid ?? null,
      url: `http://127.0.0.1:${serverPort}`,
      ...extra,
    },
  });
}

async function runPnpm(args: string[], options: {
  stdio?: "inherit" | ["ignore", "pipe", "pipe"];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}) {
  return await new Promise<{ code: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const spawned = spawn(pnpmBin, args, {
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      cwd: options.cwd,
      shell: process.platform === "win32",
    });

    const stdoutBuffer = createCapturedOutputBuffer();
    const stderrBuffer = createCapturedOutputBuffer();

    if (spawned.stdout) {
      spawned.stdout.on("data", (chunk) => {
        stdoutBuffer.append(chunk);
      });
    }
    if (spawned.stderr) {
      spawned.stderr.on("data", (chunk) => {
        stderrBuffer.append(chunk);
      });
    }

    spawned.on("error", reject);
    spawned.on("exit", (code, signal) => {
      const stdout = stdoutBuffer.finish();
      const stderr = stderrBuffer.finish();
      resolve({
        code: code ?? 0,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
      });
    });
  });
}

const migrationStatus = createMigrationStatusTracker({
  runCheck: () =>
    runPnpm(
      ["--silent", "--filter", "@greatstone/db", "exec", "tsx", "src/migration-status.ts", "--json"],
      { env },
    ),
  onFatal: (failure) => {
    process.stderr.write(failure.detail);
    process.exit(failure.code);
  },
  warn: (message) => {
    process.stderr.write(message);
  },
});

// Only the startup preflight may exit on a failed check; once a server child
// runs, a failure is retried on the next scan instead (GRE-166).
async function refreshPendingMigrations(options: { fatal?: boolean } = {}) {
  const payload = await migrationStatus.refresh({ fatal: options.fatal ?? false });
  pendingMigrations = migrationStatus.pendingMigrations;
  writeDevServerStatus();
  return payload;
}

async function maybePreflightMigrations(
  options: { interactive?: boolean; autoApply?: boolean; exitOnDecline?: boolean; fatal?: boolean } = {},
): Promise<boolean> {
  const interactive = options.interactive ?? mode === "watch";
  const autoApply = options.autoApply ?? env.GSAM_MIGRATION_AUTO_APPLY === "true";
  const exitOnDecline = options.exitOnDecline ?? mode === "watch";

  const payload = await refreshPendingMigrations({ fatal: options.fatal ?? true });
  if (!payload) return false;
  if (payload.status !== "needsMigrations" || pendingMigrations.length === 0) {
    return true;
  }

  let shouldApply = autoApply;

  if (!autoApply && interactive) {
    if (!stdin.isTTY || !stdout.isTTY) {
      shouldApply = true;
    } else {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        const answer = (
          await prompt.question(
            `Apply pending migrations (${formatPendingMigrationSummary(pendingMigrations)}) now? (y/N): `,
          )
        )
          .trim()
          .toLowerCase();
        shouldApply = answer === "y" || answer === "yes";
      } finally {
        prompt.close();
      }
    }
  }

  if (!shouldApply) {
    if (exitOnDecline) {
      process.stderr.write(
        `[paperclip] Pending migrations detected (${formatPendingMigrationSummary(pendingMigrations)}). Refusing to start watch mode against a stale schema.\n`,
      );
      process.exit(1);
    }
    return true;
  }

  const exit = await runPnpm(["db:migrate"], {
    stdio: "inherit",
    env,
    cwd: repoRoot,
  });
  if (exit.signal) {
    exitForSignal(exit.signal);
    return false;
  }
  if (exit.code !== 0) {
    process.exit(exit.code);
  }

  return (await refreshPendingMigrations({ fatal: options.fatal ?? true })) !== null;
}

async function buildPluginSdk() {
  console.log("[paperclip] building plugin sdk...");
  const result = await runPnpm(
    ["--filter", "@greatstone/plugin-sdk", "build"],
    { stdio: "inherit" },
  );
  if (result.signal) {
    exitForSignal(result.signal);
    return;
  }
  if (result.code !== 0) {
    console.error("[paperclip] plugin sdk build failed");
    process.exit(result.code);
  }
}

async function getNativeRunnerRequired(): Promise<boolean> {
  const status = await runPnpm(
    [
      "--silent",
      "--filter",
      "@greatstone/server",
      "exec",
      "tsx",
      "src/dev-native-runner-status.ts",
    ],
    { env },
  );
  if (status.signal) {
    exitForSignal(status.signal);
    return true;
  }
  const requirement = resolveNativeRunnerRequirement({
    exitCode: status.code,
    stdout: status.stdout,
  });
  if (!requirement.valid) {
    const detail = status.stderr || status.stdout;
    process.stderr.write(
      `[paperclip] unable to determine the native runner requirement; conservatively preparing the native runner${detail ? `\n${detail}` : "\n"}`,
    );
  }
  return requirement.nativeRunnerRequired;
}

async function buildPaperclipRunner() {
  console.log("[paperclip] building paperclip runner...");
  const typescriptResult = await runPnpm(
    ["--filter", "@greatstone/paperclip-runner", "build:typescript"],
    { stdio: "inherit" },
  );
  if (typescriptResult.signal) {
    exitForSignal(typescriptResult.signal);
    return;
  }
  if (typescriptResult.code !== 0) {
    console.error("[paperclip] paperclip runner build failed");
    process.exit(typescriptResult.code);
  }

  if (
    !paperclipRunnerBinaryNeedsBuild({
      repoRoot,
      nativeRunnerRequired: await getNativeRunnerRequired(),
      configuredBinary: env.GSAM_RUNNER_BINARY,
    })
  ) {
    return;
  }

  console.log("[paperclip] building paperclip runner native binary...");
  const binaryResult = await runPnpm(
    ["--filter", "@greatstone/paperclip-runner", "build:binary"],
    { stdio: "inherit" },
  );
  if (binaryResult.signal) {
    exitForSignal(binaryResult.signal);
    return;
  }
  if (binaryResult.code !== 0) {
    console.error("[paperclip] paperclip runner native binary build failed");
    process.exit(binaryResult.code);
  }
}

function newestMtimeMs(target: string): number {
  const stat = statSync(target, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(target)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const childNewest = newestMtimeMs(path.join(target, entry));
    if (childNewest > newest) newest = childNewest;
  }
  return newest;
}

function uiBundleIsFresh(): boolean {
  const distIndex = path.join(repoRoot, "ui", "dist", "index.html");
  const distStat = statSync(distIndex, { throwIfNoEntry: false });
  if (!distStat) return false;
  const sources = [
    path.join(repoRoot, "ui", "src"),
    path.join(repoRoot, "ui", "public"),
    path.join(repoRoot, "ui", "index.html"),
    path.join(repoRoot, "ui", "package.json"),
    path.join(repoRoot, "ui", "vite.config.ts"),
    path.join(repoRoot, "packages", "shared", "src"),
  ];
  return sources.every((source) => newestMtimeMs(source) <= distStat.mtimeMs);
}

async function buildUiBundleForManagedRuntime(): Promise<boolean> {
  console.log("[paperclip] managed runtime: building the UI bundle for static serving...");
  const result = await runPnpm(
    ["--filter", "@greatstone/ui", "build"],
    { stdio: "inherit" },
  );
  if (result.signal) {
    exitForSignal(result.signal);
    return false;
  }
  if (result.code !== 0) {
    console.error(
      "[paperclip] UI bundle build failed; falling back to the Vite dev middleware (the page may load slowly or stay blank over HTTPS)",
    );
    return false;
  }
  return true;
}

async function markChildAsCurrent() {
  previousSnapshot = collectWatchedSnapshot();
  dirtyPaths = new Set();
  lastChangedAt = null;
  lastRestartAt = new Date().toISOString();
  await refreshPendingMigrations();
  await updateDevServiceRecord();
}

async function scanForBackendChanges() {
  if (mode !== "dev" || scanInFlight || restartInFlight) return;
  scanInFlight = true;
  try {
    const nextSnapshot = collectWatchedSnapshot();
    const changed = diffSnapshots(previousSnapshot, nextSnapshot);
    previousSnapshot = nextSnapshot;
    if (changed.length === 0 && !migrationStatus.retryPending) return;

    if (changed.length > 0) {
      for (const relativePath of changed) {
        dirtyPaths.add(relativePath);
      }
      lastChangedAt = new Date().toISOString();
    }
    await refreshPendingMigrations();
  } finally {
    scanInFlight = false;
  }
}

async function getDevHealthPayload() {
  const response = await fetch(`http://127.0.0.1:${serverPort}/api/health`, {
    headers: devServerStatusToken ? { [devServerStatusTokenHeader]: devServerStatusToken } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Health request failed (${response.status})`);
  }
  return await parseJsonResponseWithLimit(response);
}

async function waitForChildExit() {
  if (!childExitPromise) {
    return { code: 0, signal: null };
  }
  return await childExitPromise;
}

// One stop per tree: a shutdown signal that arrives while a restart is already
// stopping the old server waits for that stop instead of signalling again.
function stopServerTree(tree: ServerProcessTree) {
  if (serverTreeStop?.tree === tree) return serverTreeStop.promise;
  const promise = stopServerProcessTree(tree, {
    signal: "SIGTERM",
    timeoutMs: gracefulShutdownTimeoutMs,
    log: logServerTree,
  });
  serverTreeStop = { tree, promise };
  return promise;
}

// Resolves only when the whole old server tree has gone: the next server must
// not start while the old one still holds its port, its embedded PostgreSQL or
// an unwritten hot-restart shutdown snapshot.
async function stopChildForRestart(): Promise<ServerChildExit> {
  const tree = serverTree;
  if (!child || !tree) return { code: 0, signal: null };
  childExitWasExpected = true;
  const result = await stopServerTree(tree);
  if (serverTree === tree) serverTree = null;
  console.log(
    `[paperclip] old server stopped for restart (${result.outcome}, ${(result.elapsedMs / 1000).toFixed(1)}s)`,
  );
  return result.exit ?? { code: 0, signal: null };
}

async function startServerChild() {
  await buildPaperclipRunner();
  await buildPluginSdk();

  const serverScript = mode === "watch" ? "dev:watch" : "dev";
  // Its own process group on POSIX, so stopping it can reach every process of
  // the server tree (see dev-runner-process.ts).
  const detached = serverChildUsesProcessGroup();
  child = spawn(
    pnpmBin,
    ["--filter", "@greatstone/server", serverScript, ...forwardedArgs],
    { stdio: "inherit", env, shell: process.platform === "win32", detached },
  );

  childExitPromise = new Promise((resolve, reject) => {
    child?.on("error", reject);
    child?.on("exit", (code, signal) => {
      const expected = childExitWasExpected;
      childExitWasExpected = false;
      child = null;
      childExitPromise = null;
      void touchLocalServiceRegistryRecord(devService.serviceKey, {
        metadata: {
          repoRoot,
          mode,
          childPid: null,
          url: `http://127.0.0.1:${serverPort}`,
        },
      });
      resolve({ code: code ?? 0, signal });

      if (restartInFlight || expected || shuttingDown) {
        return;
      }
      if (signal) {
        exitForSignal(signal);
        return;
      }
      process.exit(code ?? 0);
    });
  });
  serverTree = child.pid
    ? { pid: child.pid, processGroupId: detached ? child.pid : null, exited: childExitPromise }
    : null;

  await markChildAsCurrent();
}

async function maybeAutoRestartChild() {
  if (mode !== "dev" || restartInFlight || !child) return;
  const manualRestartRequest = getDevServerRestartRequest();
  if (!manualRestartRequest && dirtyPaths.size === 0 && pendingMigrations.length === 0) return;

  restartInFlight = true;
  let health: { devServer?: { enabled?: boolean; autoRestartEnabled?: boolean; activeRunCount?: number } } | null = null;
  try {
    health = await getDevHealthPayload();
  } catch {
    restartInFlight = false;
    return;
  }

  const devServer = health?.devServer;
  if (!devServer?.enabled) {
    restartInFlight = false;
    return;
  }
  const observedServerIdentity =
    typeof (health as { serverInfo?: { processStartedAt?: unknown } })
      .serverInfo?.processStartedAt === "string"
      ? (health as { serverInfo: { processStartedAt: string } }).serverInfo
          .processStartedAt
      : null;
  // Drop a request only when the server that made it has clearly been
  // replaced. An unreadable identity (a server that hides serverInfo from this
  // supervisor, as login mode did) is not proof, so the request stands.
  if (
    manualRestartRequest?.previousServerIdentity &&
    observedServerIdentity &&
    observedServerIdentity !== manualRestartRequest.previousServerIdentity
  ) {
    removeDevServerRestartRequest(
      manualRestartRequest.requestId
        ? { requestId: manualRestartRequest.requestId }
        : undefined,
      env,
    );
    restartInFlight = false;
    return;
  }
  if (!manualRestartRequest && devServer.autoRestartEnabled !== true) {
    restartInFlight = false;
    return;
  }
  if (!manualRestartRequest && (devServer.activeRunCount ?? 0) > 0) {
    restartInFlight = false;
    return;
  }

  try {
    const migrationsReady = await maybePreflightMigrations({
      autoApply: true,
      interactive: false,
      exitOnDecline: false,
      fatal: false,
    });
    // The check failed (for example mid `pnpm install`); keep the current
    // child and let the next poll retry the restart.
    if (!migrationsReady) return;
    await stopChildForRestart();
    // A shutdown signal that arrived during the stop owns the exit now.
    if (shuttingDown) return;
    const restartRequestConsumed = manualRestartRequest
      ? removeDevServerRestartRequest(
        manualRestartRequest.requestId
          ? { requestId: manualRestartRequest.requestId }
          : undefined,
        env,
      )
      : true;
    await startServerChild();
    if (manualRestartRequest && !restartRequestConsumed) {
      // A live writer may briefly hold the request lock. Starting the child is
      // still correct because the requested restart already happened; retry
      // correlated cleanup afterward without terminating the supervisor.
      removeDevServerRestartRequest(
        manualRestartRequest.requestId
          ? { requestId: manualRestartRequest.requestId }
          : undefined,
        env,
      );
    }
  } catch (error) {
    const err = toError(error, "Auto-restart failed");
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  } finally {
    restartInFlight = false;
  }
}

function installDevIntervals() {
  if (mode !== "dev") return;

  scanTimer = setInterval(() => {
    void scanForBackendChanges();
  }, scanIntervalMs);
  autoRestartTimer = setInterval(() => {
    void maybeAutoRestartChild();
  }, autoRestartPollIntervalMs);
}

function clearDevIntervals() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (autoRestartTimer) {
    clearInterval(autoRestartTimer);
    autoRestartTimer = null;
  }
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Ask the server to stop before tidying up, so it is already stopping if
  // something kills this supervisor in the meantime. The server tree no longer
  // shares the terminal's process group, so this is the only way a Ctrl-C or a
  // hangup reaches it. SIGTERM is what its coordinated shutdown is built around.
  const tree = serverTree;
  const stopInProgress = tree !== null && serverTreeStop?.tree === tree;
  if (tree && child) childExitWasExpected = true;
  const stopping = tree && (child || stopInProgress) ? stopServerTree(tree) : null;
  clearDevIntervals();
  clearDevServerStatus();
  await removeLocalServiceRegistryRecord(devService.serviceKey);

  if (!stopping) {
    exitForSignal(signal);
    return;
  }

  const { exit } = await stopping;
  if (serverTree === tree) serverTree = null;
  if (!exit) {
    exitForSignal(signal);
    return;
  }
  if (exit.signal) {
    exitForSignal(exit.signal);
    return;
  }
  process.exit(exit.code ?? 0);
}

// Whatever ends the supervisor, do not leave a status file that tells the
// server a supervisor is still listening (GRE-166), and do not leave the server
// tree running in its own process group with nobody supervising it (an
// uncaught error, a failed restart, or a server that exited and left its
// embedded PostgreSQL behind).
process.on("exit", () => {
  clearDevServerStatus();
  const tree = serverTree;
  if (!tree) return;
  const signalled = signalServerProcessTreeOnExit(tree, { headRunning: child !== null });
  if (signalled === "head") {
    logServerTree(`dev runner exiting; sent SIGTERM to the server (pid ${tree.pid})`);
  } else if (signalled === "group") {
    logServerTree(`dev runner exiting; sent SIGTERM to what is left of process group ${tree.processGroupId}`);
  }
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
// Closing the terminal used to hang up the server too, because it shared the
// terminal's process group. It now has its own, so stop it on purpose.
process.on("SIGHUP", () => {
  void shutdown("SIGHUP");
});

// The managed runtime readiness window is tight, so reuse a fresh bundle
// when possible and overlap a needed rebuild with the migration preflight.
let uiBundleBuild: Promise<boolean> | null = null;
if (serveBuiltUiForManagedRuntime) {
  if (uiBundleIsFresh()) {
    console.log("[paperclip] managed runtime: reusing the up-to-date UI bundle in ui/dist");
  } else {
    uiBundleBuild = buildUiBundleForManagedRuntime();
  }
}
await maybePreflightMigrations();
if (uiBundleBuild) {
  env.GSAM_UI_DEV_MIDDLEWARE = (await uiBundleBuild) ? "false" : "true";
}
await startServerChild();
installDevIntervals();

if (mode === "watch") {
  const exit = await waitForChildExit();
  // Once a signal started shutdown(), it owns the exit: it is still waiting for
  // the rest of the server tree after the head process exits.
  if (!shuttingDown) {
    await removeLocalServiceRegistryRecord(devService.serviceKey);
    if (exit.signal) {
      exitForSignal(exit.signal);
    }
    process.exit(exit.code ?? 0);
  }
}
