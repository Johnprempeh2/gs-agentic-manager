import { describe, expect, it } from "vitest";
import { totpSecretFromUri } from "./TwoStepSignInSection";

describe("totpSecretFromUri", () => {
  it("reads the key from an authenticator address", () => {
    expect(totpSecretFromUri("otpauth://totp/GSAM:ben%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GSAM")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("returns null for anything else", () => {
    expect(totpSecretFromUri("not a url")).toBeNull();
    expect(totpSecretFromUri("otpauth://totp/GSAM")).toBeNull();
  });
});
