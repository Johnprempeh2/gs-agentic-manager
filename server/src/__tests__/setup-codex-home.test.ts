import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateCodexCredentialReadiness } from "@greatstone/adapter-codex-local/server";

// GRE-109: the test setup must give every test a Codex home with a login, even
// when the host exports a CODEX_HOME without one (agent runs, previews).
// Reproduce the old failure with: CODEX_HOME=$(mktemp -d) pnpm vitest run <this file>
describe("vitest setup Codex home", () => {
  it("replaces any inherited CODEX_HOME with a seeded fake home", async () => {
    expect(path.basename(process.env.CODEX_HOME ?? "")).toMatch(/^paperclip-vitest-codex-home-/);
    const readiness = await evaluateCodexCredentialReadiness({
      companyId: "company-1",
      configuredCodexHome: null,
      configuredApiKey: null,
    });
    expect(readiness.ready).toBe(true);
  });
});
