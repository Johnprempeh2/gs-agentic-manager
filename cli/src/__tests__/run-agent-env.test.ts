import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PARENT_RUN_API_URL_ENV_KEY, agentRunEnvKeyNames } from "@greatstone/shared/agent-run-env";
import { toLegacyEnvKey, withLegacyEnvAliases } from "@greatstone/shared/legacy-env";

// `gsam run` (and `gsam test-drive`, which reuses it) starts the server in its
// own process. Every value here is fake.

const seen = vi.hoisted(() => ({
  home: `${process.env.TMPDIR || "/tmp"}/gsam-run-agent-env-${process.pid}`,
  atDoctor: null as Record<string, string | undefined> | null,
  atServerStart: null as Record<string, string | undefined> | null,
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  log: { message: vi.fn(), step: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock("../config/home.js", () => ({
  resolvePaperclipInstanceId: () => "default",
  resolvePaperclipHomeDir: () => seen.home,
  describeLocalInstancePaths: () => ({
    homeDir: seen.home,
    instanceId: "default",
    instanceRoot: `${seen.home}/instances/default`,
  }),
}));
vi.mock("../services/service-manager.js", () => ({ assertForegroundRunAllowed: vi.fn(async () => {}) }));
vi.mock("../config/env.js", () => ({ loadPaperclipEnvFile: vi.fn() }));
vi.mock("../update-notice.js", () => ({ printUpdateNotice: vi.fn(async () => {}) }));
vi.mock("../config/store.js", () => ({
  configExists: () => true,
  resolveConfigPath: () => "/fake/instances/default/config.json",
  readConfig: () => ({ server: { deploymentMode: "local_trusted" }, database: { mode: "embedded-postgres" }, auth: {} }),
}));
vi.mock("../commands/onboard.js", () => ({ onboard: vi.fn() }));
vi.mock("../commands/doctor.js", () => ({
  doctor: vi.fn(async () => {
    seen.atDoctor = { ...process.env };
    return { failed: 0 };
  }),
}));
vi.mock("../commands/worktree.js", () => ({ ensureWorktreeSeeded: vi.fn(async () => ({ seeded: false })) }));
vi.mock("../runtime-info.js", () => ({ writeRuntimeInfo: vi.fn(), removeRuntimeInfoForPid: vi.fn() }));
vi.mock("../commands/auth-bootstrap-ceo.js", () => ({ bootstrapCeoInvite: vi.fn() }));
// Take the published-package branch of the server import, so the stub below
// stands in for the server.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = (target: Parameters<typeof actual.existsSync>[0]) =>
    String(target).replaceAll("\\", "/").endsWith("/server/src/index.ts") ? false : actual.existsSync(target);
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});
vi.mock("@greatstone/server", () => ({
  startServer: vi.fn(async () => {
    seen.atServerStart = { ...process.env };
    return { apiUrl: "http://127.0.0.1:45992/api", databaseUrl: "postgres://fake", host: "127.0.0.1", listenPort: 45992 };
  }),
}));

const { isolateServerFromAgentRun, runCommand } = await import("../commands/run.js");

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
  seen.atDoctor = null;
  seen.atServerStart = null;
});
afterAll(() => {
  rmSync(seen.home, { recursive: true, force: true });
});

const RUN = "33333333-3333-4333-8333-333333333333";
const PARENT_API = "http://127.0.0.1:3100";

function enterFakeAgentRun() {
  for (const key of [...agentRunEnvKeyNames(), "GSAM_RUN_ID", toLegacyEnvKey("GSAM_RUN_ID"), PARENT_RUN_API_URL_ENV_KEY]) {
    delete process.env[key];
  }
  Object.assign(
    process.env,
    withLegacyEnvAliases({
      GSAM_RUN_ID: RUN,
      GSAM_API_URL: PARENT_API,
      GSAM_API_KEY: "fake-agent-key",
      GSAM_AGENT_ID: "fake-agent",
      GSAM_COMPANY_ID: "fake-company",
      GSAM_TASK_ID: "fake-task",
      GSAM_GIT_TOKEN: "fake-git-token",
    }),
  );
}

describe("gsam run inside an agent run", () => {
  it("starts the server without the run's identity and credentials, keeping the marker", async () => {
    enterFakeAgentRun();
    await runCommand({ yes: true, skipServiceManagerCheck: true });

    const env = seen.atServerStart!;
    expect(env).not.toBeNull();
    for (const key of agentRunEnvKeyNames()) expect(env[key], key).toBeUndefined();
    expect(env.GSAM_RUN_ID).toBe(RUN);
    expect(env[toLegacyEnvKey("GSAM_RUN_ID")]).toBe(RUN);
    expect(env[PARENT_RUN_API_URL_ENV_KEY]).toBe(PARENT_API);
    // The CLI's own checks before the server starts are unchanged.
    expect(seen.atDoctor?.GSAM_COMPANY_ID).toBe("fake-company");
  });

  it("changes nothing outside an agent run", async () => {
    for (const key of ["GSAM_RUN_ID", toLegacyEnvKey("GSAM_RUN_ID")]) delete process.env[key];
    process.env.GSAM_API_URL = "https://gsam.example.ts.net";
    await runCommand({ yes: true, skipServiceManagerCheck: true });
    expect(seen.atServerStart?.GSAM_API_URL).toBe("https://gsam.example.ts.net");
    expect(seen.atServerStart?.[PARENT_RUN_API_URL_ENV_KEY]).toBeUndefined();
  });

  it("isolateServerFromAgentRun works on a given environment", () => {
    const env: NodeJS.ProcessEnv = { GSAM_RUN_ID: RUN, GSAM_API_URL: PARENT_API, GSAM_API_KEY: "fake-agent-key", PATH: "/usr/bin" };
    isolateServerFromAgentRun(env);
    expect(env).toEqual({ GSAM_RUN_ID: RUN, [PARENT_RUN_API_URL_ENV_KEY]: PARENT_API, PATH: "/usr/bin" });
  });
});
