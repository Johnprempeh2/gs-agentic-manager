import { describe, expect, it } from "vitest";
import { canGiveQaLogin } from "./AgentQaLoginButton";

describe("canGiveQaLogin (GRE-2387)", () => {
  const access = (membershipRole: string, extra: Record<string, unknown> = {}) =>
    ({ source: "session", isInstanceAdmin: false, memberships: [{ companyId: "c1", membershipRole, status: "active" }], ...extra }) as never;

  it("shows the button to a board owner only", () => {
    expect(canGiveQaLogin("c1", access("owner"))).toBe(true);
    expect(canGiveQaLogin("c1", access("admin"))).toBe(false);
    expect(canGiveQaLogin("c1", access("operator"))).toBe(false);
    expect(canGiveQaLogin("c2", access("owner"))).toBe(false);
    expect(canGiveQaLogin("c1", undefined)).toBe(false);
  });

  it("shows it to the hosting operator", () => {
    expect(canGiveQaLogin("c1", access("viewer", { isInstanceAdmin: true }))).toBe(true);
  });
});
