import { describe, expect, it } from "vitest";
import { isTwoStepExemptEmail, isTwoStepSetupPath, needsTwoStepSetup } from "../auth/two-step-requirement.js";

describe("compulsory two-step sign-in", () => {
  it("leaves sign-in, setup, health and invite links reachable, and nothing else", () => {
    for (const path of ["/api/auth/get-session", "/api/auth/two-factor/enable", "/api/auth/two-step-status", "/api/health", "/api/invites/abc/accept"]) {
      expect(isTwoStepSetupPath(path), path).toBe(true);
    }
    for (const path of ["/api/companies", "/api/cli-auth/me", "/api/authx", "/api/auth/../companies", "/api/invites/a%2f..%2fcompanies"]) {
      expect(isTwoStepSetupPath(path), path).toBe(false);
    }
  });

  it("holds only password sessions without it, and not the exempt operator log-in", () => {
    const session = { type: "board", source: "session", userId: "u1", userEmail: "Person@Example.com" } as const;
    expect(needsTwoStepSetup(session as never)).toBe(true);
    expect(needsTwoStepSetup({ ...session, twoFactorEnabled: true } as never)).toBe(false);
    expect(needsTwoStepSetup({ ...session, source: "board_key" } as never)).toBe(false);
    expect(needsTwoStepSetup({ type: "agent", agentId: "a1" } as never)).toBe(false);
    const env = { GSAM_TWO_STEP_EXEMPT_EMAILS: " operator@instance.invalid , other@example.com" };
    expect(isTwoStepExemptEmail("OPERATOR@instance.invalid", env)).toBe(true);
    expect(isTwoStepExemptEmail("person@example.com", env)).toBe(false);
    expect(isTwoStepExemptEmail(null, env)).toBe(false);
    expect(isTwoStepExemptEmail("operator@instance.invalid", {})).toBe(false);
  });
});
