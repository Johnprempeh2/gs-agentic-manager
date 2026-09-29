import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "dotenv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planAuthModeEnv, setAuthMode } from "../commands/auth-mode.js";
import { readEmbeddedPostgresPort, resolveResetPasswordDbUrl } from "../commands/auth-reset-password.js";

let counter = 0;
const randomSecret = () => `secret-${++counter}`;

describe("planAuthModeEnv", () => {
  beforeEach(() => {
    counter = 0;
  });

  it("switches a bare install to authenticated + private and pins the agent JWT key", () => {
    expect(
      planAuthModeEnv({
        mode: "authenticated",
        current: {},
        allowedHostnames: ["my-mac.tailnet.ts.net"],
        generatedAgentJwtKey: "generated-key\n",
        randomSecret,
      }),
    ).toEqual({
      GSAM_AGENT_JWT_SECRET: "generated-key",
      GSAM_DEPLOYMENT_MODE: "authenticated",
      GSAM_DEPLOYMENT_EXPOSURE: "private",
      GSAM_BIND: "lan",
      BETTER_AUTH_SECRET: "secret-1",
      GSAM_ALLOWED_HOSTNAMES: "127.0.0.1,localhost,my-mac.tailnet.ts.net",
      GSAM_AUTH_DISABLE_SIGN_UP: "false",
    });
  });

  it("keeps secrets and hostnames already written, and closes sign-up on request", () => {
    expect(
      planAuthModeEnv({
        mode: "authenticated",
        current: {
          GSAM_AGENT_JWT_SECRET: "pinned",
          BETTER_AUTH_SECRET: "existing",
          GSAM_ALLOWED_HOSTNAMES: "localhost,127.0.0.1,my-mac",
          GSAM_AUTH_DISABLE_SIGN_UP: "false",
        },
        signUp: "closed",
        generatedAgentJwtKey: "other-key",
        randomSecret,
      }),
    ).toEqual({
      GSAM_DEPLOYMENT_MODE: "authenticated",
      GSAM_DEPLOYMENT_EXPOSURE: "private",
      GSAM_BIND: "lan",
      GSAM_ALLOWED_HOSTNAMES: "127.0.0.1,localhost,my-mac",
      GSAM_AUTH_DISABLE_SIGN_UP: "true",
    });
  });

  it("switches back to local_trusted on loopback without dropping the pinned key", () => {
    expect(
      planAuthModeEnv({
        mode: "local_trusted",
        current: { GSAM_AGENT_JWT_SECRET: "pinned", BETTER_AUTH_SECRET: "existing" },
        generatedAgentJwtKey: "generated-key",
        randomSecret,
      }),
    ).toEqual({
      GSAM_DEPLOYMENT_MODE: "local_trusted",
      GSAM_DEPLOYMENT_EXPOSURE: "private",
      GSAM_BIND: "loopback",
    });
  });

  it("makes a fresh agent key when the install never generated one", () => {
    expect(
      planAuthModeEnv({ mode: "authenticated", current: {}, generatedAgentJwtKey: null, randomSecret }),
    ).toMatchObject({ GSAM_AGENT_JWT_SECRET: "secret-1", BETTER_AUTH_SECRET: "secret-2" });
  });
});

describe("setAuthMode", () => {
  let dir: string;
  let configPath: string;
  let envPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsam-auth-mode-"));
    configPath = path.join(dir, "config.json");
    envPath = path.join(dir, ".env");
    fs.mkdirSync(path.join(dir, "secrets"));
    fs.writeFileSync(path.join(dir, "secrets", "agent-jwt.key"), "generated-agent-key-value\n");
    process.exitCode = undefined;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("goes to authenticated and back, keeping unrelated lines and a backup of each step", () => {
    fs.writeFileSync(envPath, "# mine\nOTHER_SETTING=keep-me\n");

    setAuthMode("authenticated", { config: configPath, allowedHostname: ["my-mac"] });
    const afterSwitch = parse(fs.readFileSync(envPath, "utf8"));
    expect(afterSwitch).toMatchObject({
      OTHER_SETTING: "keep-me",
      GSAM_DEPLOYMENT_MODE: "authenticated",
      GSAM_DEPLOYMENT_EXPOSURE: "private",
      GSAM_BIND: "lan",
      GSAM_AGENT_JWT_SECRET: "generated-agent-key-value",
      GSAM_ALLOWED_HOSTNAMES: "127.0.0.1,localhost,my-mac",
      GSAM_AUTH_DISABLE_SIGN_UP: "false",
    });
    expect(afterSwitch.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);

    setAuthMode("authenticated", { config: configPath, signUp: "closed" });
    const afterLock = parse(fs.readFileSync(envPath, "utf8"));
    expect(afterLock.GSAM_AUTH_DISABLE_SIGN_UP).toBe("true");
    expect(afterLock.BETTER_AUTH_SECRET).toBe(afterSwitch.BETTER_AUTH_SECRET);

    setAuthMode("local_trusted", { config: configPath });
    const afterBack = parse(fs.readFileSync(envPath, "utf8"));
    expect(afterBack).toMatchObject({
      OTHER_SETTING: "keep-me",
      GSAM_DEPLOYMENT_MODE: "local_trusted",
      GSAM_BIND: "loopback",
      GSAM_AGENT_JWT_SECRET: "generated-agent-key-value",
    });

    const backups = fs.readdirSync(dir).filter((name) => name.startsWith(".env.before-auth-mode-"));
    expect(backups).toHaveLength(3);
    expect(process.exitCode).toBeUndefined();
  });

  it("is a no-op when run twice", () => {
    setAuthMode("authenticated", { config: configPath });
    const first = fs.readFileSync(envPath, "utf8");
    setAuthMode("authenticated", { config: configPath });
    expect(fs.readFileSync(envPath, "utf8")).toBe(first);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith(".env.before-auth-mode-"))).toHaveLength(0);
  });

  it("refuses unknown modes and authenticated-only flags on local_trusted", () => {
    expect(setAuthMode("public", { config: configPath })).toBeNull();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(setAuthMode("local_trusted", { config: configPath, bind: "lan" })).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(envPath)).toBe(false);
  });
});

describe("resolveResetPasswordDbUrl", () => {
  it("finds the embedded Postgres port of an install with no config.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsam-reset-db-"));
    try {
      fs.mkdirSync(path.join(dir, "db"));
      fs.writeFileSync(path.join(dir, "db", "postmaster.pid"), "123\n/x/db\n1790000000\n54329\n/tmp\n");
      const previous = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        expect(readEmbeddedPostgresPort(path.join(dir, "db"))).toBe(54329);
        expect(resolveResetPasswordDbUrl(path.join(dir, "config.json"))).toBe(
          "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
        );
        expect(resolveResetPasswordDbUrl(path.join(dir, "config.json"), "postgres://explicit")).toBe(
          "postgres://explicit",
        );
      } finally {
        if (previous !== undefined) process.env.DATABASE_URL = previous;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
