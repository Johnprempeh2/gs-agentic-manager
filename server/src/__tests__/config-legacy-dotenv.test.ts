import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_ENV_PREFIX } from "@greatstone/shared/legacy-env";

const keys = [
  "GSAM_TEST_LEGACY_DOTENV_URL",
  `${LEGACY_ENV_PREFIX}TEST_LEGACY_DOTENV_URL`,
  "GSAM_TEST_DOTENV_BOTH",
  `${LEGACY_ENV_PREFIX}TEST_DOTENV_BOTH`,
];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of keys) delete process.env[key];
});

describe("legacy variable names in .env files", () => {
  it("adopts a legacy key from the instance .env, and a GSAM_* value still wins", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gsam-legacy-dotenv-"));
    try {
      writeFileSync(
        path.join(dir, ".env"),
        [
          `${LEGACY_ENV_PREFIX}TEST_LEGACY_DOTENV_URL=https://legacy.example.test`,
          "GSAM_TEST_DOTENV_BOTH=modern",
          `${LEGACY_ENV_PREFIX}TEST_DOTENV_BOTH=legacy`,
        ].join("\n"),
      );
      vi.stubEnv("GSAM_CONFIG", path.join(dir, "config.json"));
      vi.resetModules();
      await import("../config.js");
      expect(process.env.GSAM_TEST_LEGACY_DOTENV_URL).toBe("https://legacy.example.test");
      expect(process.env.GSAM_TEST_DOTENV_BOTH).toBe("modern");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
