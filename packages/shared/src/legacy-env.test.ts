import { describe, expect, it } from "vitest";
import {
  adoptLegacyEnv,
  fromLegacyEnvKey,
  toLegacyEnvKey,
  withLegacyEnvAliases,
} from "./legacy-env.js";

describe("legacy env bridge", () => {
  it("maps keys in both directions and leaves others alone", () => {
    expect(fromLegacyEnvKey("PAPERCLIP_API_URL")).toBe("GSAM_API_URL");
    expect(toLegacyEnvKey("GSAM_API_URL")).toBe("PAPERCLIP_API_URL");
    expect(fromLegacyEnvKey("HOME")).toBe("HOME");
    expect(toLegacyEnvKey("PORT")).toBe("PORT");
  });

  it("adopts legacy operator config without overriding the new name", () => {
    const env: Record<string, string | undefined> = {
      PAPERCLIP_HOME: "/legacy/home",
      PAPERCLIP_PORT: "4000",
      GSAM_PORT: "5000",
      UNRELATED: "x",
    };
    const adopted = adoptLegacyEnv(env);
    expect(adopted).toEqual(["GSAM_HOME"]);
    expect(env.GSAM_HOME).toBe("/legacy/home");
    expect(env.GSAM_PORT).toBe("5000");
  });

  it("gives agents both names, and the GSAM_* value always wins", () => {
    const env = withLegacyEnvAliases({
      GSAM_API_URL: "http://localhost:3100",
      GSAM_API_KEY: "minted-run-token",
      PAPERCLIP_API_KEY: "forged-from-config",
      PATH: "/usr/bin",
    });
    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:3100");
    expect(env.GSAM_API_URL).toBe("http://localhost:3100");
    expect(env.PAPERCLIP_API_KEY).toBe("minted-run-token");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("returns a copy and never mutates the input", () => {
    const input = { GSAM_AGENT_ID: "a1" };
    const out = withLegacyEnvAliases(input);
    expect(input).toEqual({ GSAM_AGENT_ID: "a1" });
    expect(out).not.toBe(input);
  });
});
