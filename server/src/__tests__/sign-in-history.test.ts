import { describe, expect, it } from "vitest";
import { signInOutcome } from "../auth/sign-in-history.js";

const unauthorized = Object.assign(new Error("Invalid email or password"), { statusCode: 401 });
const tooMany = Object.assign(new Error("Too many requests"), { statusCode: 429 });

describe("signInOutcome", () => {
  it("reads the password step", () => {
    expect(signInOutcome("/sign-in/email", { token: "t" }, true)).toBe("signed_in");
    expect(signInOutcome("/sign-in/email", { twoFactorRedirect: true }, false)).toBe("code_needed");
    expect(signInOutcome("/sign-in/email", unauthorized, false)).toBe("wrong_password");
    expect(signInOutcome("/sign-in/email", tooMany, false)).toBeNull();
  });

  it("counts a code step only inside a sign-in", () => {
    expect(signInOutcome("/two-factor/verify-totp", { token: "t" }, true, true)).toBe("signed_in");
    expect(signInOutcome("/two-factor/verify-backup-code", { token: "t" }, true, true)).toBe("signed_in");
    expect(signInOutcome("/two-factor/verify-totp", { token: "t" }, true, false)).toBeNull();
    expect(signInOutcome("/two-factor/verify-totp", unauthorized, false, true)).toBeNull();
  });

  it("ignores other paths", () => {
    expect(signInOutcome("/sign-up/email", { token: "t" }, true)).toBeNull();
  });
});
