import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type LocalProcessSandboxAccess = "ro" | "rw";
export type LocalProcessNetworkScope = "deny" | "allowlist";

export interface LocalProcessSandboxPath {
  path: string;
  access: LocalProcessSandboxAccess;
}

export interface LocalProcessSandboxPathAlias {
  path: string;
  target: string;
}

export interface LocalProcessSandboxOptions {
  workspaceDir: string;
  filesystemScope?: "workspace" | null;
  managedPaths?: LocalProcessSandboxPath[];
  extraPaths?: LocalProcessSandboxPath[];
  pathAliases?: LocalProcessSandboxPathAlias[];
  outboundRestorePaths?: string[];
  homeDir?: string | null;
  networkScope?: LocalProcessNetworkScope | null;
  networkAllowlist?: string[];
  networkTrustedUrls?: string[];
  command?: string;
}

export interface LocalProcessSandboxSpawnTarget {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  cleanup?: () => Promise<void>;
}

interface NetworkAllowlistRule {
  hostname: string;
  port: string | null;
}

interface NetworkAllowlistProxy {
  close: () => Promise<void>;
}

const SYSTEM_READ_PATHS = [
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/etc/ca-certificates",
  "/etc/ssl",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/timezone",
  "/etc/gitconfig",
] as const;

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;
const SANDBOX_PROXY_PORT = 31_337;
const UNIX_SOCKET_PATH_MAX_BYTES = 107;
const NETWORK_PROXY_TEMP_PREFIX = "paperclip-network-sandbox-";

// Secret shield (GRE-1094): every local agent spawn runs in bwrap with the
// normal view of `/`, a tmpfs over host secret directories, and a fresh PID
// namespace and `/proc`. The fresh `/proc` matters as much as the tmpfs: Yama
// ptrace scope 1 blocks attach but not same-uid reads of the server's
// `/proc/<pid>/environ`. Without a working bwrap the spawn runs unwrapped and
// warns, so a missing package never stops agents.
export const AGENT_SECRET_SHIELD_ENV = "GSAM_AGENT_SECRET_SHIELD";
export const AGENT_SECRET_SHIELD_HIDDEN_PATHS_ENV = "GSAM_AGENT_SECRET_SHIELD_HIDDEN_PATHS";
export const AGENT_SECRET_SHIELD_COMMAND_ENV = "GSAM_AGENT_SECRET_SHIELD_BWRAP";
const DEFAULT_SECRET_DIRS = [path.join("gs-memory", "secrets")] as const;
const SECRET_SHIELD_PROBE_TIMEOUT_MS = 5_000;
const SECRET_SHIELD_RETRY_AFTER_MS = 5 * 60_000;

export type AgentSecretShieldStatus =
  | { state: "active"; command: string; hiddenPaths: string[] }
  | { state: "disabled"; reason: string; hiddenPaths: string[] }
  | { state: "unavailable"; reason: string; command: string | null; hiddenPaths: string[] };

let secretShieldCache: { key: string; status: AgentSecretShieldStatus; checkedAt: number } | null = null;

/** The host directories a wrapped agent sees as empty: `~/gs-memory/secrets` plus the env list. */
export function resolveAgentSecretShieldHiddenPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const homes = new Set<string>();
  for (const candidate of [os.homedir(), safeUserInfoHome()]) {
    if (candidate && path.isAbsolute(candidate)) homes.add(path.resolve(candidate));
  }
  const paths = new Set<string>();
  for (const home of homes) for (const dir of DEFAULT_SECRET_DIRS) paths.add(path.join(home, dir));
  for (const entry of (env[AGENT_SECRET_SHIELD_HIDDEN_PATHS_ENV] ?? "").split(path.delimiter)) {
    const trimmed = entry.trim();
    if (trimmed && path.isAbsolute(trimmed)) paths.add(path.resolve(trimmed));
  }
  return Array.from(paths);
}

function safeUserInfoHome(): string | null {
  try {
    return os.userInfo().homedir;
  } catch {
    return null;
  }
}

/** Existing hidden paths and their real paths; bwrap cannot mount over a missing path without creating it. */
async function existingHiddenPaths(hiddenPaths: string[]): Promise<string[]> {
  const result = new Set<string>();
  for (const candidate of hiddenPaths) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (!stat?.isDirectory()) continue;
    result.add(candidate);
    const real = await fs.realpath(candidate).catch(() => candidate);
    result.add(real);
  }
  return Array.from(result);
}

/**
 * bwrap arguments up to and including `--`. `dieWithParent` also kills the
 * sandbox when its spawner exits, so leave it off for children that must
 * outlive a server restart (hot-restart adoption).
 */
export function buildAgentSecretShieldArgs(input: { hiddenPaths: string[]; dieWithParent: boolean }): string[] {
  const args = ["--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc"];
  if (input.dieWithParent) args.push("--die-with-parent");
  for (const hidden of input.hiddenPaths) args.push("--tmpfs", hidden);
  args.push("--");
  return args;
}

async function resolveExecutableOnPath(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (path.isAbsolute(command)) {
    return fs.access(command, fs.constants.X_OK).then(() => command).catch(() => null);
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (await fs.access(candidate, fs.constants.X_OK).then(() => true).catch(() => false)) return candidate;
  }
  return null;
}

function probeSecretShield(command: string, hiddenPaths: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(error);
    };
    const child = spawn(command, [...buildAgentSecretShieldArgs({ hiddenPaths, dieWithParent: true }), "true"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(`probe timed out after ${SECRET_SHIELD_PROBE_TIMEOUT_MS}ms`);
    }, SECRET_SHIELD_PROBE_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error.message));
    child.on("close", (code, signal) => {
      if (code === 0) finish(null);
      else finish(stderr.trim() || `probe exited with ${signal ?? `code ${code}`}`);
    });
  });
}

/**
 * Whether local agent spawns can be wrapped. A working result is cached for
 * the process lifetime; a failed one is re-checked after five minutes, so
 * installing bubblewrap takes effect without a restart.
 */
export async function resolveAgentSecretShield(
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; refresh?: boolean } = {},
): Promise<AgentSecretShieldStatus> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const hiddenPaths = resolveAgentSecretShieldHiddenPaths(env);
  const toggle = (env[AGENT_SECRET_SHIELD_ENV] ?? "").trim().toLowerCase();
  if (["0", "off", "false", "disabled"].includes(toggle)) {
    return { state: "disabled", reason: `${AGENT_SECRET_SHIELD_ENV}=${toggle}`, hiddenPaths };
  }
  if (platform !== "linux") {
    return { state: "disabled", reason: `not supported on ${platform}`, hiddenPaths };
  }
  const requested = env[AGENT_SECRET_SHIELD_COMMAND_ENV]?.trim() || "bwrap";
  const key = JSON.stringify([requested, env.PATH ?? "", hiddenPaths]);
  const now = Date.now();
  if (!opts.refresh && secretShieldCache?.key === key) {
    const cached = secretShieldCache;
    if (cached.status.state === "active" || now - cached.checkedAt < SECRET_SHIELD_RETRY_AFTER_MS) return cached.status;
  }
  const command = await resolveExecutableOnPath(requested, env);
  let status: AgentSecretShieldStatus;
  if (!command) {
    status = {
      state: "unavailable",
      reason: `"${requested}" was not found on PATH; install bubblewrap`,
      command: null,
      hiddenPaths,
    };
  } else {
    const failure = await probeSecretShield(command, await existingHiddenPaths(hiddenPaths));
    status = failure
      ? { state: "unavailable", reason: `${command} failed to start a sandbox: ${failure}`, command, hiddenPaths }
      : { state: "active", command, hiddenPaths };
  }
  secretShieldCache = { key, status, checkedAt: now };
  return status;
}

export function resetAgentSecretShieldCacheForTests(): void {
  secretShieldCache = null;
}

export function describeAgentSecretShieldWarning(status: AgentSecretShieldStatus): string | null {
  if (status.state !== "unavailable") return null;
  return `Agent secret sandbox is OFF: ${status.reason}. Local agent runs start unwrapped and can read ${status.hiddenPaths.join(", ")}.`;
}

export interface AgentSecretShieldWrap {
  command: string;
  args: string[];
  status: AgentSecretShieldStatus;
}

/**
 * Wrap one local agent spawn. Returns the original command and args when the
 * shield is disabled or unavailable; the unavailable case logs one warning.
 */
export async function wrapWithAgentSecretShield(input: {
  command: string;
  args: string[];
  dieWithParent: boolean;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}): Promise<AgentSecretShieldWrap> {
  const status = await resolveAgentSecretShield({ env: input.env });
  if (status.state !== "active") {
    const warning = describeAgentSecretShieldWarning(status);
    if (warning) (input.warn ?? ((message) => console.warn(`[gsam] ${message}`)))(warning);
    return { command: input.command, args: input.args, status };
  }
  const hidden = await existingHiddenPaths(status.hiddenPaths);
  return {
    command: status.command,
    args: [...buildAgentSecretShieldArgs({ hiddenPaths: hidden, dieWithParent: input.dieWithParent }), input.command, ...input.args],
    status,
  };
}

function normalizeAbsolutePath(candidate: string, label: string): string {
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(trimmed);
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.lstat(candidate).then(() => true).catch(() => false);
}

function parentDirectories(candidate: string): string[] {
  const directories: string[] = [];
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    directories.push(current);
    current = path.dirname(current);
  }
  return directories.reverse();
}

function addParentDirectories(args: string[], created: Set<string>, candidate: string): void {
  for (const directory of parentDirectories(candidate)) {
    if (created.has(directory)) continue;
    args.push("--dir", directory);
    created.add(directory);
  }
}

async function nearestPackageRoot(candidate: string): Promise<string> {
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    if (await pathExists(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return path.dirname(candidate);
}

async function executableReadPaths(command: string): Promise<string[]> {
  const paths = new Set<string>();
  paths.add(path.dirname(command));
  const realCommand = await fs.realpath(command).catch(() => command);
  paths.add(await nearestPackageRoot(realCommand));
  return Array.from(paths);
}

function parseNetworkAllowlistEntry(entry: string, index: number): NetworkAllowlistRule {
  const trimmed = entry.trim();
  if (!trimmed) throw new Error(`networkAllowlist[${index}] must not be empty.`);
  let hostname: string;
  let port: string | null;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("path");
    }
    hostname = parsed.hostname.toLowerCase();
    port = parsed.port || null;
  } catch {
    throw new Error(`networkAllowlist[${index}] must be a hostname, hostname:port, or origin URL.`);
  }
  if (!hostname || hostname === "*" || hostname.startsWith("*.")) {
    throw new Error(`networkAllowlist[${index}] must use an exact hostname; wildcards are not supported.`);
  }
  return { hostname, port };
}

export function parseLocalProcessNetworkAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`networkAllowlist[${index}] must be a string.`);
    const rule = parseNetworkAllowlistEntry(entry, index);
    return rule.port ? `${rule.hostname}:${rule.port}` : rule.hostname;
  });
}

export function parseLocalProcessNetworkScope(value: unknown): LocalProcessNetworkScope | null {
  if (value == null || value === "") return null;
  if (value === "deny" || value === "allowlist") return value;
  throw new Error('networkScope must be "deny" or "allowlist".');
}

export function parseLocalProcessFilesystemScope(value: unknown): "workspace" | null {
  if (value == null || value === "") return null;
  if (value === "workspace") return value;
  throw new Error('filesystemScope must be "workspace".');
}

function isNetworkTargetAllowed(hostname: string, port: string, rules: NetworkAllowlistRule[]): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return rules.some((rule) => rule.hostname === normalizedHostname && (rule.port === null || rule.port === port));
}

function assertUnixSocketPathLength(socketPath: string): void {
  const pathBytes = Buffer.byteLength(socketPath);
  if (pathBytes > UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `GS Agentic Manager sandbox proxy socket path is ${pathBytes} bytes, exceeding the Linux limit of ${UNIX_SOCKET_PATH_MAX_BYTES}: ${socketPath}`,
    );
  }
}

async function createNetworkProxyTempDir(): Promise<string> {
  const candidates = Array.from(new Set(["/tmp", os.tmpdir()]));
  let lastError: unknown;
  for (const baseDir of candidates) {
    try {
      const tempDir = await fs.mkdtemp(path.join(baseDir, NETWORK_PROXY_TEMP_PREFIX));
      try {
        assertUnixSocketPathLength(path.join(tempDir, "proxy.sock"));
        return tempDir;
      } catch (error) {
        await fs.rm(tempDir, { recursive: true, force: true });
        lastError = error;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Unable to create a Linux-safe GS Agentic Manager sandbox proxy socket directory.", { cause: lastError });
}

function parseTrustedNetworkUrl(value: string): NetworkAllowlistRule | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return {
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return null;
  }
}

function writeProxyError(response: http.ServerResponse, status: number, code: string, message: string): void {
  const body = `${JSON.stringify({ error: { code, message } })}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  }).end(body);
}

function connectProxyError(code: string, message: string): string {
  const body = `${JSON.stringify({ error: { code, message } })}\n`;
  return [
    "HTTP/1.1 403 Forbidden",
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
}

async function startNetworkAllowlistProxy(
  allowlist: string[],
  trustedUrls: string[],
  socketPath: string,
): Promise<NetworkAllowlistProxy> {
  assertUnixSocketPathLength(socketPath);
  const rules = [
    ...allowlist.map(parseNetworkAllowlistEntry),
    ...trustedUrls.map(parseTrustedNetworkUrl).filter((rule): rule is NetworkAllowlistRule => rule !== null),
  ];
  if (rules.length === 0) {
    throw new Error(
      'networkScope="allowlist" requires at least one valid networkAllowlist hostname or HTTP(S) networkTrustedUrl.',
    );
  }
  const server = http.createServer((request, response) => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      writeProxyError(response, 400, "invalid_request_url", "GS Agentic Manager sandbox proxy requires an absolute request URL.");
      return;
    }
    const port = target.port || (target.protocol === "https:" ? "443" : "80");
    if (target.protocol !== "http:") {
      writeProxyError(response, 400, "https_requires_connect", "HTTPS targets must use CONNECT through the GS Agentic Manager sandbox proxy.");
      return;
    }
    if (!isNetworkTargetAllowed(target.hostname, port, rules)) {
      writeProxyError(response, 403, "network_target_denied", "Network target denied by GS Agentic Manager sandbox policy.");
      return;
    }
    const upstream = http.request(target, {
      method: request.method,
      headers: { ...request.headers, host: target.host },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => response.destroy(error));
    request.pipe(upstream);
  });
  server.on("connect", (request, clientSocket, head) => {
    const separator = request.url?.lastIndexOf(":") ?? -1;
    const hostname = separator > 0 ? request.url!.slice(0, separator).replace(/^\[|\]$/g, "") : "";
    const port = separator > 0 ? request.url!.slice(separator + 1) : "443";
    if (!hostname || !/^\d+$/.test(port) || !isNetworkTargetAllowed(hostname, port, rules)) {
      clientSocket.end(connectProxyError(
        "network_target_denied",
        "Network target denied by GS Agentic Manager sandbox policy.",
      ));
      return;
    }
    const upstream = net.connect(Number(port), hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("close", () => upstream.destroy());
  });
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function createNetworkProxyBridge(): Promise<string> {
  const source = `
const net = require("node:net");
const { spawn } = require("node:child_process");
const socketPath = process.argv[2];
const executable = process.argv[3];
const args = process.argv.slice(4);
const server = net.createServer((client) => {
  const upstream = net.connect(socketPath);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", close);
  upstream.on("error", close);
});
server.listen(${SANDBOX_PROXY_PORT}, "127.0.0.1", () => {
  const child = spawn(executable, args, { stdio: "inherit", env: process.env });
  const forward = (signal) => { if (!child.killed) child.kill(signal); };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  child.on("exit", (code, signal) => server.close(() => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 1 : code);
  }));
});
`;
  return source.trimStart();
}

export async function buildLocalProcessSandboxSpawnTarget(input: {
  executable: string;
  args: string[];
  cwd: string;
  options: LocalProcessSandboxOptions;
}): Promise<LocalProcessSandboxSpawnTarget> {
  if (process.platform !== "linux") {
    throw new Error("Local process filesystem and network scopes are currently supported only on Linux.");
  }
  const filesystemScope = input.options.filesystemScope ?? null;
  const networkScope = input.options.networkScope ?? null;
  if (!filesystemScope && !networkScope) throw new Error("Local process sandbox requires a filesystem or network scope.");

  const workspaceDir = normalizeAbsolutePath(input.options.workspaceDir, "Sandbox workspaceDir");
  const cwd = normalizeAbsolutePath(input.cwd, "Sandbox cwd");
  if (filesystemScope === "workspace") {
    const relativeCwd = path.relative(workspaceDir, cwd);
    if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
      throw new Error(`Sandbox cwd "${cwd}" must be inside workspaceDir "${workspaceDir}".`);
    }
    const outboundRestorePaths = (input.options.outboundRestorePaths ?? []).map((candidate, index) =>
      normalizeAbsolutePath(candidate, `Sandbox outboundRestorePaths[${index}]`));
    for (const [index, extraPath] of (input.options.extraPaths ?? []).entries()) {
      if (extraPath.access !== "rw") continue;
      const normalizedExtraPath = normalizeAbsolutePath(extraPath.path, `Sandbox extraPaths[${index}].path`);
      const relativeToWorkspace = path.relative(workspaceDir, normalizedExtraPath);
      const synchronized = !relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace);
      const restored = outboundRestorePaths.some((restorePath) => {
        const relative = path.relative(restorePath, normalizedExtraPath);
        return !relative.startsWith("..") && !path.isAbsolute(relative);
      });
      if (!synchronized && !restored) {
        throw new Error(
          `Writable sandbox path "${normalizedExtraPath}" is outside synchronized workspace "${workspaceDir}" and has no outbound restore mapping.`,
        );
      }
    }
  }

  const bwrapCommand = input.options.command?.trim() || "bwrap";
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];
  const env: Record<string, string | undefined> = {};
  let cleanup: (() => Promise<void>) | undefined;
  let executable = input.executable;
  let executableArgs = input.args;

  if (filesystemScope === "workspace") {
    args.push("--tmpfs", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
    args.push(
      "--symlink", "usr/bin", "/bin",
      "--symlink", "usr/sbin", "/sbin",
      "--symlink", "usr/lib", "/lib",
      "--symlink", "usr/lib64", "/lib64",
    );
    const created = new Set<string>(["/", "/proc", "/dev", "/tmp"]);
    const mounted = new Set<string>();
    const mount = async (source: string, access: LocalProcessSandboxAccess) => {
      const normalized = normalizeAbsolutePath(source, "Sandbox path");
      if (mounted.has(normalized) || !(await pathExists(normalized))) return;
      addParentDirectories(args, created, normalized);
      args.push(access === "rw" ? "--bind" : "--ro-bind", normalized, normalized);
      mounted.add(normalized);
      created.add(normalized);
    };
    for (const systemPath of SYSTEM_READ_PATHS) await mount(systemPath, "ro");
    for (const executablePath of await executableReadPaths(input.executable)) await mount(executablePath, "ro");
    if (networkScope === "allowlist") {
      for (const nodePath of await executableReadPaths(process.execPath)) await mount(nodePath, "ro");
    }
    for (const managedPath of input.options.managedPaths ?? []) await mount(managedPath.path, managedPath.access);
    for (const extraPath of input.options.extraPaths ?? []) await mount(extraPath.path, extraPath.access);
    await mount(workspaceDir, "rw");
    for (const [index, alias] of (input.options.pathAliases ?? []).entries()) {
      const aliasPath = normalizeAbsolutePath(alias.path, `Sandbox pathAliases[${index}].path`);
      const aliasTarget = normalizeAbsolutePath(alias.target, `Sandbox pathAliases[${index}].target`);
      const relativeTarget = path.relative(workspaceDir, aliasTarget);
      if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
        throw new Error(
          `Sandbox path alias "${aliasPath}" must target the synchronized workspace "${workspaceDir}".`,
        );
      }
      if (!(await pathExists(aliasTarget))) {
        throw new Error(`Sandbox path alias target "${aliasTarget}" does not exist.`);
      }
      addParentDirectories(args, created, aliasPath);
      args.push("--bind", aliasTarget, aliasPath);
      created.add(aliasPath);
    }

    if (networkScope === "allowlist") {
      const tempDir = await createNetworkProxyTempDir();
      const socketPath = path.join(tempDir, "proxy.sock");
      const bridgePath = path.join(tempDir, "bridge.cjs");
      await fs.writeFile(bridgePath, await createNetworkProxyBridge(), { mode: 0o500 });
      const proxy = await startNetworkAllowlistProxy(
        input.options.networkAllowlist ?? [],
        input.options.networkTrustedUrls ?? [],
        socketPath,
      ).catch(async (error) => {
        await fs.rm(tempDir, { recursive: true, force: true });
        throw error;
      });
      await mount(tempDir, "rw");
      executable = process.execPath;
      executableArgs = [bridgePath, socketPath, input.executable, ...input.args];
      cleanup = async () => {
        await proxy.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      };
    }
  } else {
    // The normal view of `/` would otherwise expose host secrets and, through
    // the inherited `/proc`, the server's environment (GRE-1094).
    args.push("--dev-bind", "/", "/", "--proc", "/proc");
    for (const hidden of await existingHiddenPaths(resolveAgentSecretShieldHiddenPaths())) {
      args.push("--tmpfs", hidden);
    }
    if (networkScope === "allowlist") {
      const tempDir = await createNetworkProxyTempDir();
      const socketPath = path.join(tempDir, "proxy.sock");
      const bridgePath = path.join(tempDir, "bridge.cjs");
      await fs.writeFile(bridgePath, await createNetworkProxyBridge(), { mode: 0o500 });
      const proxy = await startNetworkAllowlistProxy(
        input.options.networkAllowlist ?? [],
        input.options.networkTrustedUrls ?? [],
        socketPath,
      ).catch(async (error) => {
        await fs.rm(tempDir, { recursive: true, force: true });
        throw error;
      });
      executable = process.execPath;
      executableArgs = [bridgePath, socketPath, input.executable, ...input.args];
      cleanup = async () => {
        await proxy.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      };
    }
  }

  if (networkScope) {
    args.push("--unshare-net");
    for (const key of PROXY_ENV_KEYS) env[key] = undefined;
    env.NO_PROXY = "";
    env.no_proxy = "";
  }
  if (networkScope === "allowlist") {
    const proxyUrl = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
  }

  args.push("--chdir", cwd, "--", executable, ...executableArgs);
  return { command: bwrapCommand, args, cwd: "/", env, cleanup };
}

export function parseLocalProcessSandboxExtraPaths(value: unknown): LocalProcessSandboxPath[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry === "string") {
      return { path: normalizeAbsolutePath(entry, `filesystemExtraPaths[${index}]`), access: "ro" };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`filesystemExtraPaths[${index}] must be an absolute path or { path, access } object.`);
    }
    const raw = entry as Record<string, unknown>;
    const access = raw.access === "rw" ? "rw" : raw.access === "ro" || raw.access == null ? "ro" : null;
    if (!access || typeof raw.path !== "string") {
      throw new Error(`filesystemExtraPaths[${index}] must use access "ro" or "rw" and an absolute path.`);
    }
    return { path: normalizeAbsolutePath(raw.path, `filesystemExtraPaths[${index}].path`), access };
  });
}
