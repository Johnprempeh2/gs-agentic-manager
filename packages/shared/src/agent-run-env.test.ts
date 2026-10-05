import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_ENV_KEYS,
  PARENT_RUN_API_URL_ENV_KEY,
  RUN_OWNER_API_URL_ENV_KEYS,
  agentRunEnvKeyNames,
  agentRunIdFromEnv,
  scrubAgentRunEnvForServer,
} from "./agent-run-env.js";
import { toLegacyEnvKey, withLegacyEnvAliases } from "./legacy-env.js";

// Fake values only: nothing here is a real credential.
const RUN = "11111111-1111-4111-8111-111111111111";
const PARENT_API = "http://127.0.0.1:3100";
const LEGACY_RUN_ID = toLegacyEnvKey("GSAM_RUN_ID");

type Env = Record<string, string | undefined>;

/**
 * The GSAM_* names a local agent run carried on this machine (read from
 * /proc/<pid>/environ, names only, 5 Oct 2026). The run gets each under its
 * legacy name as well.
 */
const OBSERVED_AGENT_RUN_NAMES = [
  "GSAM_AGENT_ID",
  "GSAM_API_KEY",
  "GSAM_API_URL",
  "GSAM_COMPANY_ID",
  "GSAM_GITHUB_AUTH_MODE",
  "GSAM_GITHUB_BROKER_TOKEN",
  "GSAM_GITHUB_BROKER_URL",
  "GSAM_GITHUB_LAUNCHER_DIR",
  "GSAM_GITHUB_OPERATION_ACTIVE",
  "GSAM_GIT_METADATA_ROOTS",
  "GSAM_GIT_TOKEN",
  "GSAM_ISSUE_WORK_MODE",
  "GSAM_OPENCODE_PROVIDERS",
  "GSAM_RUNNER_NETWORK_ACCESS",
  "GSAM_RUNNER_NETWORK_ROOTS",
  "GSAM_RUN_ID",
  "GSAM_RUN_SCRATCH_DIR",
  "GSAM_SCRATCH_DIR",
  "GSAM_TASK_ID",
  "GSAM_TASK_SCRATCH_DIR",
  "GSAM_TMPDIR",
  "GSAM_WAKE_REASON",
  "GSAM_WORKSPACE_BRANCH",
  "GSAM_WORKSPACE_CWD",
  "GSAM_WORKSPACE_ID",
  "GSAM_WORKSPACE_REPO_REF",
  "GSAM_WORKSPACE_REPO_URL",
  "GSAM_WORKSPACE_SOURCE",
  "GSAM_WORKSPACE_STRATEGY",
  "GSAM_WORKSPACE_WORKTREE_PATH",
];

/** An agent shell: every run variable (and its alias) with a fake value, plus host settings. */
function agentShellEnv(overrides: Env = {}): Env {
  const run: Record<string, string> = {};
  for (const key of [...AGENT_RUN_ENV_KEYS, ...OBSERVED_AGENT_RUN_NAMES]) run[key] = `fake-${key.toLowerCase()}`;
  run.GSAM_RUN_ID = RUN;
  run.GSAM_API_URL = PARENT_API;
  return {
    ...withLegacyEnvAliases(run),
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/agent-home",
    TMPDIR: "/tmp/run-scratch",
    // Operator settings that share a prefix with run variables.
    GSAM_HOME: "/tmp/sandbox",
    GSAM_DB_BACKUP_ENABLED: "false",
    GSAM_WORKSPACE_REAPER_COOLDOWN_DAYS: "3",
    GSAM_GITHUB_REPO: "example/repo",
    ...overrides,
  };
}

const gsamNames = (env: Env) =>
  Object.keys(env)
    .filter((key) => key.startsWith("GSAM_") || key.startsWith(toLegacyEnvKey("GSAM_")))
    .sort();

describe("agentRunIdFromEnv", () => {
  it("reads GSAM_RUN_ID, else its legacy alias, and ignores empty values", () => {
    expect(agentRunIdFromEnv({ GSAM_RUN_ID: RUN })).toBe(RUN);
    expect(agentRunIdFromEnv({ [LEGACY_RUN_ID]: RUN })).toBe(RUN);
    expect(agentRunIdFromEnv({ GSAM_RUN_ID: "  " })).toBeNull();
    expect(agentRunIdFromEnv({})).toBeNull();
  });
});

describe("scrubAgentRunEnvForServer", () => {
  it("does nothing outside an agent run (live, the preview and client instances)", () => {
    const env: Env = { GSAM_API_URL: "https://gsam.example.ts.net", GSAM_API_KEY: "operator-set", PATH: "/usr/bin" };
    const before = { ...env };
    expect(scrubAgentRunEnvForServer(env)).toBeNull();
    expect(env).toEqual(before);
  });

  it("removes the run's identity, credentials and context under both names", () => {
    const env = agentShellEnv();
    const result = scrubAgentRunEnvForServer(env);

    expect(result).toEqual({
      runId: RUN,
      parentApiUrl: PARENT_API,
      removed: expect.any(Array),
    });
    for (const key of agentRunEnvKeyNames()) expect(env[key], key).toBeUndefined();
    // What is left of GS Agentic Manager's names: the marker, the parent's
    // URL for the cleanup, and the operator's own settings.
    expect(gsamNames(env)).toEqual(
      [
        "GSAM_DB_BACKUP_ENABLED",
        "GSAM_GITHUB_REPO",
        "GSAM_HOME",
        "GSAM_OPENCODE_PROVIDERS",
        PARENT_RUN_API_URL_ENV_KEY,
        "GSAM_RUN_ID",
        "GSAM_WORKSPACE_REAPER_COOLDOWN_DAYS",
        toLegacyEnvKey("GSAM_OPENCODE_PROVIDERS"),
        LEGACY_RUN_ID,
      ].sort(),
    );
    expect(env.GSAM_RUN_ID).toBe(RUN);
    expect(env[LEGACY_RUN_ID]).toBe(RUN);
    expect(env[PARENT_RUN_API_URL_ENV_KEY]).toBe(PARENT_API);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/tmp/agent-home");
    expect(env.TMPDIR).toBe("/tmp/run-scratch");
  });

  it("covers every GSAM_* name a real agent run carried, except operator config", () => {
    const listed = new Set(AGENT_RUN_ENV_KEYS);
    const notRemoved = OBSERVED_AGENT_RUN_NAMES.filter((key) => !listed.has(key));
    // GSAM_RUN_ID is the marker; GSAM_OPENCODE_PROVIDERS is adapter config
    // (custom provider definitions the server also reads), not identity.
    expect(notRemoved.sort()).toEqual(["GSAM_OPENCODE_PROVIDERS", "GSAM_RUN_ID"]);
  });

  it("reports names only, never values", () => {
    const env = agentShellEnv();
    const result = scrubAgentRunEnvForServer(env)!;
    expect(result.removed).toEqual([...result.removed].sort());
    expect(result.removed).toContain("GSAM_API_KEY");
    expect(result.removed).toContain(toLegacyEnvKey("GSAM_API_KEY"));
    expect(JSON.stringify(result.removed)).not.toContain("fake-");
  });

  it("detects a run that only carries the legacy names", () => {
    const env: Env = {
      [LEGACY_RUN_ID]: RUN,
      [toLegacyEnvKey("GSAM_API_URL")]: PARENT_API,
      [toLegacyEnvKey("GSAM_API_KEY")]: "fake-key",
      [toLegacyEnvKey("GSAM_AGENT_ID")]: "fake-agent",
    };
    expect(scrubAgentRunEnvForServer(env)?.parentApiUrl).toBe(PARENT_API);
    expect(env).toEqual({ [LEGACY_RUN_ID]: RUN, [PARENT_RUN_API_URL_ENV_KEY]: PARENT_API });
  });

  it("is idempotent, and a recorded parent URL wins over a later GSAM_API_URL", () => {
    const env = agentShellEnv();
    scrubAgentRunEnvForServer(env);
    const once = { ...env };
    expect(scrubAgentRunEnvForServer(env)).toEqual({ runId: RUN, parentApiUrl: PARENT_API, removed: [] });
    expect(env).toEqual(once);

    // A sandbox server sets GSAM_API_URL to its own URL once it listens. A
    // server started from inside that sandbox's process tree still belongs to
    // the parent run, so the parent's URL stays.
    env.GSAM_API_URL = "http://127.0.0.1:3101";
    expect(scrubAgentRunEnvForServer(env)?.parentApiUrl).toBe(PARENT_API);
    expect(env[PARENT_RUN_API_URL_ENV_KEY]).toBe(PARENT_API);
    expect(env.GSAM_API_URL).toBeUndefined();
  });

  it("records no parent URL when the run had none", () => {
    const env: Env = { GSAM_RUN_ID: RUN, GSAM_API_KEY: "fake-key" };
    expect(scrubAgentRunEnvForServer(env)).toEqual({ runId: RUN, parentApiUrl: null, removed: ["GSAM_API_KEY"] });
    expect(env).toEqual({ GSAM_RUN_ID: RUN });
  });

  it("works on process.env itself", () => {
    const saved = { ...process.env };
    try {
      process.env.GSAM_RUN_ID = RUN;
      process.env.GSAM_API_URL = PARENT_API;
      process.env.GSAM_API_KEY = "fake-key";
      scrubAgentRunEnvForServer();
      expect(process.env.GSAM_API_KEY).toBeUndefined();
      expect(process.env.GSAM_API_URL).toBeUndefined();
      expect(process.env[PARENT_RUN_API_URL_ENV_KEY]).toBe(PARENT_API);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("RUN_OWNER_API_URL_ENV_KEYS", () => {
  it("puts the recorded parent URL first, then GSAM_API_URL, then its alias", () => {
    expect(RUN_OWNER_API_URL_ENV_KEYS).toEqual([
      PARENT_RUN_API_URL_ENV_KEY,
      "GSAM_API_URL",
      toLegacyEnvKey("GSAM_API_URL"),
    ]);
  });
});
