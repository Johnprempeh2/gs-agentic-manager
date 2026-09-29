import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyDevRunnerOptions } from "../../../scripts/dev-runner-options.ts";

describe("applyDevRunnerOptions", () => {
  it("turns --data-dir into isolated GS Agentic Manager paths and consumes the option", () => {
    const env: NodeJS.ProcessEnv = {};
    const cwd = path.join(os.tmpdir(), "paperclip-dev-runner-options");
    const previousInstanceId = process.env.GSAM_INSTANCE_ID;
    process.env.GSAM_INSTANCE_ID = "ambient-test-instance";

    try {
      const result = applyDevRunnerOptions(
        ["--bind", "loopback", "--data-dir", "./tmp", "--future-option"],
        env,
        cwd,
      );

      const expectedHome = path.resolve(cwd, "tmp");
      expect(result).toEqual({
        forwardedArgs: ["--bind", "loopback", "--future-option"],
        dataDir: expectedHome,
      });
      expect(env.GSAM_HOME).toBe(expectedHome);
      expect(env.GSAM_INSTANCE_ID).toBe("default");
      expect(env.GSAM_CONFIG).toBe(
        path.join(expectedHome, "instances", "default", "config.json"),
      );
      expect(env.GSAM_CONTEXT).toBe(path.join(expectedHome, "context.json"));
    } finally {
      if (previousInstanceId === undefined) {
        delete process.env.GSAM_INSTANCE_ID;
      } else {
        process.env.GSAM_INSTANCE_ID = previousInstanceId;
      }
    }
  });

  it.each([
    ["short option", ["-d", "~/paperclip-dev"]],
    ["equals form", ["--data-dir=~/paperclip-dev"]],
  ])("supports the %s", (_label, args) => {
    const env: NodeJS.ProcessEnv = {};

    const result = applyDevRunnerOptions(args, env, "/unused");

    expect(result.forwardedArgs).toEqual([]);
    expect(result.dataDir).toBe(path.join(os.homedir(), "paperclip-dev"));
  });

  it("uses the selected instance for the default config path", () => {
    const env: NodeJS.ProcessEnv = { GSAM_INSTANCE_ID: "experiment" };

    applyDevRunnerOptions(["--data-dir", "/isolated/home"], env, "/unused");

    expect(env.GSAM_CONFIG).toBe(
      path.join("/isolated/home", "instances", "experiment", "config.json"),
    );
  });

  it("preserves explicit config and context paths", () => {
    const env: NodeJS.ProcessEnv = {
      GSAM_CONFIG: "/explicit/config.json",
      GSAM_CONTEXT: "/explicit/context.json",
    };

    applyDevRunnerOptions(["--data-dir", "/isolated/home"], env, "/unused");

    expect(env.GSAM_HOME).toBe("/isolated/home");
    expect(env.GSAM_CONFIG).toBe("/explicit/config.json");
    expect(env.GSAM_CONTEXT).toBe("/explicit/context.json");
  });

  it("drops the parent server's API URL and key so sandbox agents use the sandbox port (GRE-219)", () => {
    const env: NodeJS.ProcessEnv = {
      GSAM_API_URL: "http://127.0.0.1:3100",
      GSAM_API_KEY: "live-agent-key",
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_API_KEY: "live-agent-key",
    };

    applyDevRunnerOptions(["--data-dir", "/isolated/home"], env, "/unused");

    expect(env.GSAM_API_URL).toBeUndefined();
    expect(env.GSAM_API_KEY).toBeUndefined();
    expect(env.PAPERCLIP_API_URL).toBeUndefined();
    expect(env.PAPERCLIP_API_KEY).toBeUndefined();
  });

  it("keeps the API URL when no --data-dir is given", () => {
    const env: NodeJS.ProcessEnv = { GSAM_API_URL: "http://127.0.0.1:3100" };

    applyDevRunnerOptions(["--bind", "loopback"], env, "/unused");

    expect(env.GSAM_API_URL).toBe("http://127.0.0.1:3100");
  });

  it.each([["--data-dir"], ["-d"], ["--data-dir="]])(
    "rejects a missing value for %s",
    (...args) => {
      expect(() => applyDevRunnerOptions(args, {}, "/unused")).toThrow(
        /requires a value/,
      );
    },
  );
});
