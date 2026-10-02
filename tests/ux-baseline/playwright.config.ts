import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { scrubParentInstanceEnv } from "../fixtures/sandbox-env";

const PORT = Number(process.env.GSAM_UX_BASELINE_PORT ?? 3203);
// Optional: reuse a disposable local instance while editing the flows. It must be
// started with a clean environment, because its scripted agents run inside it.
const EXTERNAL_URL = process.env.GSAM_UX_BASELINE_BASE_URL;
if (EXTERNAL_URL) {
  const target = new URL(EXTERNAL_URL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.pathname !== "/") {
    throw new Error("GSAM_UX_BASELINE_BASE_URL must be a loopback origin for a disposable local instance; the run seeds data.");
  }
}
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`;
const GSAM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gsam-ux-baseline-home-"));
const GSAM_INSTANCE_ID = "playwright-ux-baseline";
const GSAM_CONFIG = path.join(GSAM_HOME, "instances", GSAM_INSTANCE_ID, "config.json");

scrubParentInstanceEnv(["GSAM_UX_BASELINE_"]);
process.env.GSAM_HOME = GSAM_HOME;
process.env.GSAM_CONFIG = GSAM_CONFIG;

// Always a fresh, empty, loopback-only instance: the spec seeds its own company.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 60 * 60_000,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: BASE_URL,
    browserName: "chromium",
    headless: true,
    // A stuck step should fail the run with a screenshot, not hang it.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  webServer: EXTERNAL_URL ? undefined : {
    command: "pnpm gsam onboard --yes --run",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "development",
      // Time the built bundle users load (ui/dist, from `pnpm build`), not Vite's dev modules.
      GSAM_UI_DEV_MIDDLEWARE: "false",
      PORT: String(PORT),
      GSAM_OPEN_ON_LISTEN: "false",
      GSAM_HOME,
      GSAM_INSTANCE_ID,
      GSAM_CONFIG,
      GSAM_AGENT_JWT_SECRET: "playwright-ux-baseline-agent-jwt-secret",
      GSAM_TOOL_ACTION_SIGNING_SECRET: "playwright-ux-baseline-tool-action-signing-secret",
      GSAM_BIND: "loopback",
      GSAM_DEPLOYMENT_MODE: "local_trusted",
      GSAM_DEPLOYMENT_EXPOSURE: "private",
    },
  },
  outputDir: "../../test-results/ux-baseline/playwright",
  reporter: [["list"]],
});
