/**
 * What a GS Agentic Manager server must not inherit from the agent run that
 * started it.
 *
 * An agent's shell carries its run's identity and credentials: the run API
 * key, the agent, company and task ids, the wake context, its workspace and
 * scratch folders, its GitHub access, and the address of the server it talks
 * to, each also under its legacy PAPERCLIP_* name (see legacy-env.ts). A
 * sandbox started from that shell (`pnpm dev:once --data-dir ./tmp/sandbox`,
 * `gsam run`) used to inherit all of it: the server took the parent's
 * GSAM_API_URL as its own public URL, and the sandbox and anything it started
 * could reach the parent (live) server as that agent. On 5 Oct 2026 five
 * sandbox servers started by one agent run carried the agent's keys.
 *
 * `scrubAgentRunEnvForServer` removes those names when the run marker is set
 * and keeps the marker, so the parent server's leftover cleanup
 * (server/src/services/run-process-cleanup.ts) still finds the sandbox: the run
 * id stays in GSAM_RUN_ID, and the parent server's API URL moves to
 * GSAM_PARENT_RUN_API_URL, which only that cleanup reads.
 *
 * Every name is listed exactly, never by prefix: operator settings share
 * prefixes with run variables (GSAM_WORKSPACE_REAPER_COOLDOWN_DAYS,
 * GSAM_GITHUB_REPO) and must reach the sandbox.
 */
import { toLegacyEnvKey } from "./legacy-env.js";

type EnvRecord = Record<string, string | undefined>;

/** The run marker. Kept: the parent server's leftover cleanup matches on it. */
export const AGENT_RUN_ID_ENV_KEYS: readonly string[] = ["GSAM_RUN_ID", toLegacyEnvKey("GSAM_RUN_ID")];

/**
 * The API URL of the server whose run GSAM_RUN_ID names, recorded when a
 * server starts inside that run. Nothing reads it except the leftover cleanup.
 */
export const PARENT_RUN_API_URL_ENV_KEY = "GSAM_PARENT_RUN_API_URL";

/**
 * Where a process records the server that owns its GSAM_RUN_ID, most specific
 * first. A sandbox server sets GSAM_API_URL to its own URL once it listens, so
 * in its processes the recorded parent URL must win.
 */
export const RUN_OWNER_API_URL_ENV_KEYS: readonly string[] = [
  PARENT_RUN_API_URL_ENV_KEY,
  "GSAM_API_URL",
  toLegacyEnvKey("GSAM_API_URL"),
];

/**
 * The run's own variables, by their GSAM_* names. Their legacy PAPERCLIP_*
 * aliases are removed too (`agentRunEnvKeyNames`).
 */
export const AGENT_RUN_ENV_KEYS: readonly string[] = [
  // Who the run is, its credential, and the server it talks to.
  "GSAM_AGENT_ID",
  "GSAM_COMPANY_ID",
  "GSAM_API_KEY",
  "GSAM_API_URL",
  "GSAM_RUNTIME_API_URL",
  "GSAM_RUNTIME_API_CANDIDATES_JSON",
  "GSAM_LISTEN_HOST",
  "GSAM_LISTEN_PORT",
  // What woke it and what it works on.
  "GSAM_TASK_ID",
  "GSAM_ISSUE_WORK_MODE",
  "GSAM_WAKE_REASON",
  "GSAM_WAKE_COMMENT_ID",
  "GSAM_WAKE_PAYLOAD_JSON",
  "GSAM_APPROVAL_ID",
  "GSAM_APPROVAL_STATUS",
  "GSAM_LINKED_ISSUE_IDS",
  // Its workspace and scratch folders.
  "GSAM_WORKSPACE_CWD",
  "GSAM_WORKSPACE_SOURCE",
  "GSAM_WORKSPACE_STRATEGY",
  "GSAM_WORKSPACE_ID",
  "GSAM_WORKSPACE_REPO_URL",
  "GSAM_WORKSPACE_REPO_REF",
  "GSAM_WORKSPACE_BRANCH",
  "GSAM_WORKSPACE_WORKTREE_PATH",
  "GSAM_WORKSPACES_JSON",
  "GSAM_RUN_SCRATCH_DIR",
  "GSAM_TASK_SCRATCH_DIR",
  "GSAM_SCRATCH_DIR",
  "GSAM_TMPDIR",
  // Its GitHub access and network policy.
  "GSAM_GIT_TOKEN",
  "GSAM_GITHUB_AUTH_MODE",
  "GSAM_GITHUB_BROKER_URL",
  "GSAM_GITHUB_BROKER_TOKEN",
  "GSAM_GITHUB_BRIDGE_TOKEN",
  "GSAM_GITHUB_HOST_HOME",
  "GSAM_GITHUB_LAUNCHER_DIR",
  "GSAM_GITHUB_OPERATION_ACTIVE",
  "GSAM_GIT_METADATA_ROOTS",
  "GSAM_RUNNER_NETWORK_ACCESS",
  "GSAM_RUNNER_NETWORK_ROOTS",
  // Its other run-scoped tool credentials.
  "GSAM_RUNTIME_TOOLS_MCP_URL",
  "GSAM_RUNTIME_TOOLS_TOKEN",
  "GSAM_RUNTIME_TOOLS_EXPIRES_AT",
  "GSAM_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL",
  "GSAM_RUNTIME_TOOLS_CONNECTION_REQUEST_URL",
  "GSAM_RUNTIME_TOOLS_AVAILABLE",
  "GSAM_RUNTIME_TOOLS_GUIDANCE",
  "GSAM_NATIVE_MCP_NAME",
  "GSAM_NATIVE_MCP_URL",
  "GSAM_NATIVE_MCP_TOKEN",
  "GSAM_BRIDGE_TOKEN",
  "GSAM_BRIDGE_API_KEY",
  "GSAM_RUNNER_BOOTSTRAP_TICKET",
];

/** Every name the scrub removes: each run variable and its legacy alias. */
export function agentRunEnvKeyNames(): string[] {
  return AGENT_RUN_ENV_KEYS.flatMap((key) => [key, toLegacyEnvKey(key)]);
}

function firstNonEmpty(env: EnvRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

/** The run id when `env` belongs to an agent run (GSAM_RUN_ID, else its legacy alias), else null. */
export function agentRunIdFromEnv(env: EnvRecord = process.env): string | null {
  return firstNonEmpty(env, AGENT_RUN_ID_ENV_KEYS);
}

export interface AgentRunEnvScrub {
  /** The run that started this server. */
  runId: string;
  /** The API URL of the server that owns that run, now in GSAM_PARENT_RUN_API_URL. */
  parentApiUrl: string | null;
  /** The names removed (never their values), sorted. */
  removed: string[];
}

/**
 * Call before a GS Agentic Manager server starts. Outside an agent run it does
 * nothing and returns null. Inside one it removes the run's variables from
 * `env` (mutating it), keeps the run id marker and records the parent's API
 * URL under GSAM_PARENT_RUN_API_URL. Running it twice changes nothing more.
 */
export function scrubAgentRunEnvForServer(env: EnvRecord = process.env): AgentRunEnvScrub | null {
  const runId = agentRunIdFromEnv(env);
  if (!runId) return null;
  const parentApiUrl = firstNonEmpty(env, RUN_OWNER_API_URL_ENV_KEYS);
  const removed: string[] = [];
  for (const key of agentRunEnvKeyNames()) {
    if (env[key] === undefined) continue;
    delete env[key];
    removed.push(key);
  }
  if (parentApiUrl) env[PARENT_RUN_API_URL_ENV_KEY] = parentApiUrl;
  return { runId, parentApiUrl, removed: removed.sort() };
}
