/**
 * What a GS Agentic Manager server must not inherit from the agent run that
 * started it.
 *
 * An agent's shell carries its run's identity and credentials: the run API
 * key, the agent, company and task ids, the wake context, its workspace and
 * scratch folders, its GitHub access, and the address of the server it talks
 * to, each also under its legacy alias (see legacy-env.ts). A
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
 * GSAM_PARENT_RUN_API_URL, which only that cleanup reads. An agent that wants
 * one of the removed names in its sandbox on purpose sets GSAM_SANDBOX_<NAME>
 * (credentials excepted; see SANDBOX_OVERRIDE_PREFIX).
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
 * The run's own variables, by their GSAM_* names. Their legacy aliases are
 * removed too (`agentRunEnvKeyNames`).
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

/**
 * A deliberate value for the sandbox: inside a run, `GSAM_SANDBOX_<NAME>=value`
 * sets `GSAM_<NAME>=value` after the scrub, when `GSAM_<NAME>` is a name the
 * scrub removes. The agent cannot otherwise tell the scrub a value is meant
 * for the sandbox, because an inherited value and a deliberate one look the
 * same. Every GSAM_SANDBOX_* name is then removed, so nothing the sandbox
 * starts inherits it.
 */
export const SANDBOX_OVERRIDE_PREFIX = "GSAM_SANDBOX_";

/**
 * Never set from a GSAM_SANDBOX_* override: the run's credentials and tokens.
 * Deliberately passing the parent's credentials into a sandbox would undo the
 * isolation: the sandbox, and every agent it runs, could act on the parent
 * server as the parent agent again.
 */
export const SANDBOX_OVERRIDE_REFUSED_KEYS: readonly string[] = [
  "GSAM_API_KEY",
  "GSAM_GIT_TOKEN",
  "GSAM_GITHUB_BROKER_TOKEN",
  "GSAM_GITHUB_BRIDGE_TOKEN",
  "GSAM_RUNTIME_TOOLS_TOKEN",
  "GSAM_NATIVE_MCP_TOKEN",
  "GSAM_BRIDGE_TOKEN",
  "GSAM_BRIDGE_API_KEY",
  "GSAM_RUNNER_BOOTSTRAP_TICKET",
];

/**
 * The GSAM_* names an earlier scrub in this process tree set on purpose
 * (comma separated, names only). The dev runner scrubs, then the server it
 * starts scrubs again: this keeps the deliberate values through the second
 * scrub. Only the scrub reads it.
 */
export const SANDBOX_KEPT_ENV_KEY = "GSAM_AGENT_RUN_KEPT_ENV";

/** The start log's hint, printed whenever the scrub did something. */
export const SANDBOX_OVERRIDE_HINT =
  "to keep one of these on purpose for this sandbox, set GSAM_SANDBOX_<NAME> (credentials excepted)";

// An override may never move the ownership marker the parent's cleanup reads.
const MARKER_ENV_KEYS = new Set<string>([...AGENT_RUN_ID_ENV_KEYS, PARENT_RUN_API_URL_ENV_KEY, SANDBOX_KEPT_ENV_KEY]);

function overridable(name: string): boolean {
  return AGENT_RUN_ENV_KEYS.includes(name) && !SANDBOX_OVERRIDE_REFUSED_KEYS.includes(name);
}

/** The names an earlier scrub in this process tree set on purpose and that may stay. */
export function keptAgentRunEnvNames(env: EnvRecord = process.env): Set<string> {
  const names = (env[SANDBOX_KEPT_ENV_KEY] ?? "").split(",").map((name) => name.trim());
  return new Set(names.filter((name) => overridable(name) && env[name] !== undefined));
}

export interface AgentRunEnvScrub {
  /** The run that started this server. */
  runId: string;
  /** The API URL of the server that owns that run, now in GSAM_PARENT_RUN_API_URL. */
  parentApiUrl: string | null;
  /** The names removed (never their values), sorted. */
  removed: string[];
  /** GSAM_* names set on purpose from a GSAM_SANDBOX_* override in this call, sorted. */
  applied: string[];
  /** GSAM_* names an earlier scrub in this process tree set on purpose, left as they are. */
  kept: string[];
  /** GSAM_SANDBOX_* names refused: a credential or the run marker. */
  refused: string[];
  /** GSAM_SANDBOX_* names ignored: empty, or not a name the scrub removes (set that one directly). */
  ignored: string[];
}

/**
 * Call before a GS Agentic Manager server starts. Outside an agent run it does
 * nothing and returns null (GSAM_SANDBOX_* names are left alone too). Inside
 * one it removes the run's variables from `env` (mutating it), applies the
 * GSAM_SANDBOX_* overrides, removes the GSAM_SANDBOX_* names, keeps the run id
 * marker and records the parent's API URL under GSAM_PARENT_RUN_API_URL.
 * Running it twice changes nothing more.
 */
export function scrubAgentRunEnvForServer(env: EnvRecord = process.env): AgentRunEnvScrub | null {
  const runId = agentRunIdFromEnv(env);
  if (!runId) return null;
  const parentApiUrl = firstNonEmpty(env, RUN_OWNER_API_URL_ENV_KEYS);

  const kept = keptAgentRunEnvNames(env);
  const removed: string[] = [];
  for (const key of agentRunEnvKeyNames()) {
    if (env[key] === undefined || kept.has(key)) continue;
    delete env[key];
    removed.push(key);
  }

  const applied: string[] = [];
  const refused: string[] = [];
  const ignored: string[] = [];
  const legacyOverridePrefix = toLegacyEnvKey(SANDBOX_OVERRIDE_PREFIX);
  for (const key of Object.keys(env)) {
    if (key.startsWith(SANDBOX_OVERRIDE_PREFIX)) {
      const value = env[key];
      const target = `GSAM_${key.slice(SANDBOX_OVERRIDE_PREFIX.length)}`;
      if (MARKER_ENV_KEYS.has(target) || SANDBOX_OVERRIDE_REFUSED_KEYS.includes(target)) {
        refused.push(key);
      } else if (!AGENT_RUN_ENV_KEYS.includes(target) || !value?.trim()) {
        ignored.push(key);
      } else {
        env[target] = value;
        applied.push(target);
      }
      delete env[key];
    } else if (key.startsWith(legacyOverridePrefix)) {
      // Its legacy alias: the entry points already adopted it as GSAM_SANDBOX_*.
      delete env[key];
    }
  }

  const deliberate = [...new Set([...kept, ...applied])].sort();
  if (deliberate.length > 0) env[SANDBOX_KEPT_ENV_KEY] = deliberate.join(",");
  else delete env[SANDBOX_KEPT_ENV_KEY];
  if (parentApiUrl) env[PARENT_RUN_API_URL_ENV_KEY] = parentApiUrl;
  return {
    runId,
    parentApiUrl,
    removed: removed.sort(),
    applied: applied.sort(),
    kept: [...kept].filter((name) => !applied.includes(name)).sort(),
    refused: refused.sort(),
    ignored: ignored.sort(),
  };
}

/**
 * The one start-log line for a scrub (names only, never values), or null when
 * there is nothing to say: outside a run, or a second scrub that only kept
 * what the first one set.
 */
export function describeAgentRunEnvScrub(scrub: AgentRunEnvScrub | null): string | null {
  if (!scrub) return null;
  if (!scrub.removed.length && !scrub.applied.length && !scrub.refused.length && !scrub.ignored.length) return null;
  const parts = [
    `started from agent run ${scrub.runId}: removed ${scrub.removed.length} of the run's variables (API key, agent, task, workspace, GitHub) from this server's environment; GSAM_RUN_ID stays so the run's cleanup can stop it`,
  ];
  if (scrub.applied.length) parts.push(`applied on purpose: ${scrub.applied.join(", ")}`);
  if (scrub.refused.length) parts.push(`refused (credentials and the run marker are never passed on): ${scrub.refused.join(", ")}`);
  if (scrub.ignored.length) parts.push(`ignored (empty, or not a removed name; set it directly): ${scrub.ignored.join(", ")}`);
  parts.push(SANDBOX_OVERRIDE_HINT);
  return parts.join("; ");
}
