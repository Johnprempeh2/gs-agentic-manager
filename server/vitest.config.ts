import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The release test gate sets GSAM_VITEST_TIMEOUT_MS to stretch the defaults
// below while every lane loads the machine (scripts/greatstone-test-gate.lanes).
// It is read here because scripts/run-vitest-stable.mjs's --hookTimeout does not
// reach this project's config: on rc-2026-10-16.1 a route suite's beforeEach
// still timed out at 30s under the 60s gate setting (GRE-1605).
const gateTimeoutMs = Number(process.env.GSAM_VITEST_TIMEOUT_MS) || 0;

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@greatstone\/paperclip-runner$/,
        replacement: fileURLToPath(
          new URL("../packages/paperclip-runner/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Each server suite boots + tears down its own embedded Postgres in
    // beforeAll/afterAll. Under the loaded serial shard (maxWorkers=1) the
    // graceful shutdown can occasionally cross vitest's default 10s hookTimeout,
    // producing flaky "Hook timed out in 10000ms" afterAll failures on CI. Give
    // the boot/teardown hooks generous headroom; 30s is far above the observed
    // worst-case teardown yet still catches a genuinely hung hook. teardownTimeout
    // mirrors it for the same reason.
    hookTimeout: Math.max(30000, gateTimeoutMs),
    teardownTimeout: Math.max(30000, gateTimeoutMs),
    // The route/authz suites import very large modules (for example
    // src/routes/issues.ts and its dependency graph). The first test in each
    // file pays the one-time transform cost inside its own timeout budget. On
    // the loaded serial shard (maxWorkers=1) that cost can cross vitest's
    // default 5s testTimeout and fail the first test, which also lets its
    // fire-and-forget wake leak into the next test. Give each test generous
    // headroom; 15s is far above the observed module-load cost yet still
    // catches a genuinely hung test well inside the 20 minute job limit.
    testTimeout: Math.max(15000, gateTimeoutMs),
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
