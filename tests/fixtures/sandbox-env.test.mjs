// Proves that no Playwright harness that boots a GS Agentic Manager sandbox
// passes the launching agent's live GSAM_* context to that server (GRE-366).
// Run: pnpm test:sandbox-env
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const tsx = path.join(root, "cli/node_modules/tsx/dist/cli.mjs");
const probe = path.join(root, "tests/fixtures/print-web-server-env.ts");

// What a live instance puts in an agent's shell. Values are fakes.
const LIVE = {
  GSAM_API_URL: "http://127.0.0.1:3100/api",
  GSAM_API_KEY: "live-api-key",
  GSAM_AGENT_ID: "live-agent",
  GSAM_COMPANY_ID: "live-company",
  GSAM_RUN_ID: "live-run",
  GSAM_TASK_ID: "live-task",
  GSAM_WAKE_REASON: "issue_assigned",
  GSAM_GIT_TOKEN: "live-git-token",
  GSAM_GITHUB_BROKER_TOKEN: "live-broker-token",
  GSAM_WORKSPACE_CWD: "/live/worktree",
  GSAM_RUN_SCRATCH_DIR: "/live/scratch",
  PAPERCLIP_API_KEY: "live-legacy-key",
};

const CONFIGS = [
  "tests/perf/issue-detail/playwright.config.ts",
  "tests/ux-baseline/playwright.config.ts",
  "tests/e2e/playwright.config.ts",
  "tests/e2e/playwright-composer-stop.config.ts",
  "tests/e2e/connection-reviews.config.ts",
  "tests/canary-onboarding/playwright.config.ts",
];

function webServerEnvs(config, extraEnv = {}) {
  const out = execFileSync(process.execPath, [tsx, probe, config], {
    cwd: root,
    env: { ...process.env, ...LIVE, ...extraEnv },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

for (const config of CONFIGS) {
  test(`${config}: sandbox server sees none of the live GSAM_* context`, () => {
    const envs = webServerEnvs(config, { PAPERCLIPAI_VERSION: "0.0.0-test" });
    assert.ok(envs.length > 0, "expected a webServer");
    for (const env of envs) {
      for (const [key, value] of Object.entries(LIVE)) {
        assert.notEqual(env[key], value, `${key} leaked into the sandbox server`);
      }
    }
  });
}

test("harness knobs survive the scrub", () => {
  const [env] = webServerEnvs("tests/perf/issue-detail/playwright.config.ts", {
    GSAM_ISSUE_PERF_RUNS: "3",
    GSAM_UI_DEV_MIDDLEWARE: "true",
  });
  assert.equal(env.GSAM_ISSUE_PERF_RUNS, "3");
  assert.equal(env.GSAM_UI_DEV_MIDDLEWARE, "true");
  assert.match(env.GSAM_HOME, /paperclip-issue-perf-home-/);
});
