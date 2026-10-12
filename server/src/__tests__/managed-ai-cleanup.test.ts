import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ManagedAiCleanupError,
  describeManagedAiCleanupFailure,
  managedAiCleanupLogFields,
  runManagedAiCleanup,
} from "../services/managed-ai-cleanup.js";
import { claimManagedAiHome, removeManagedAiHome } from "../services/managed-ai-home-sweep.js";

// Live, 2 to 4 Oct 2026: 36 "AI connection refresh or cleanup failed" warnings
// with no cause. Every one was an Anthropic subscription run, where removing the
// per-run AI home is the only step, and the provider can still be writing there
// as the run ends.

const exists = (target: string) => stat(target).then(() => true, () => false);

function fsError(code: string, syscall: string, target: string) {
  return Object.assign(new Error(`${code}: directory not empty, ${syscall} '${target}'`), {
    code, errno: -39, syscall, path: target,
  });
}

describe("removing a per-run AI home", () => {
  it("succeeds while the provider is still writing into it", { timeout: 20_000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-cleanup-race-"));
    const logs = path.join(home, "provider", "Library", "Caches", "logs");
    await mkdir(logs, { recursive: true });
    for (let i = 0; i < 200; i += 1) await writeFile(path.join(logs, `seed-${i}.txt`), "x".repeat(100));
    await claimManagedAiHome(home);
    // A separate process keeps adding log files for 400 ms, as an exiting CLI
    // does. It never recreates the folder, so a removed home stays removed.
    const writer = spawn(process.execPath, ["-e", `
      const fs = require("node:fs"), p = require("node:path");
      const dir = ${JSON.stringify(logs)};
      process.stdout.write("ready\\n");
      const end = Date.now() + 400; let i = 0;
      while (Date.now() < end) { try { fs.writeFileSync(p.join(dir, "late-" + (i++) + ".txt"), "y"); } catch {} }
    `], { stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise((resolve) => writer.once("exit", resolve));
    try {
      await new Promise<void>((resolve) => writer.stdout!.once("data", () => resolve()));
      await expect(removeManagedAiHome(home, { lateWriteRetryMs: 0 })).resolves.toBeUndefined();
      await exited;
      expect(await exists(home)).toBe(false);
    } finally {
      writer.kill();
      await exited;
      await rm(home, { recursive: true, force: true, maxRetries: 10 });
    }
  });
});

describe("describeManagedAiCleanupFailure", () => {
  it("keeps the class, code and system call, and shortens the per-run home path", () => {
    const home = path.join(os.tmpdir(), "paperclip-ai-34dad57e-b5ad-4a72-9400-9eba645c99f6-76090ae8-f0ab-48cd-9c81-b34b79298e92-AbC123");
    expect(describeManagedAiCleanupFailure(fsError("ENOTEMPTY", "rmdir", path.join(home, "provider", "Library", "Caches")))).toEqual({
      chain: "Error [ENOTEMPTY]",
      code: "ENOTEMPTY",
      syscall: "rmdir",
      message: "ENOTEMPTY: directory not empty, rmdir '<ai-home>/provider/Library/Caches'",
    });
  });

  it("removes anything that looks like a credential from the message", () => {
    const secrets = [
      "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU",
    ];
    const cause = describeManagedAiCleanupFailure(
      new Error(`Refresh failed: Authorization: Bearer ${secrets[0]} token=${secrets[1]} jwt ${secrets[2]}`),
    );
    expect(cause.chain).toBe("Error");
    expect(cause.message).toMatch(/^Refresh failed:/);
    for (const secret of secrets) expect(JSON.stringify(cause)).not.toContain(secret.slice(0, 16));
  });

  it("omits parser messages, which can quote the auth file", () => {
    let parseError: unknown;
    try {
      JSON.parse('{"tokens":{"access_token":"secret-value-from-auth-file"');
    } catch (error) {
      parseError = error;
    }
    const cause = describeManagedAiCleanupFailure(parseError);
    expect(cause).toEqual({ chain: "SyntaxError" });
    expect(JSON.stringify(cause)).not.toContain("secret-value");
  });

  it("follows causes, keeping only names and codes that look like names and codes", () => {
    const inner = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const outer = Object.assign(new Error("write-back failed", { cause: inner }), {
      name: "evil\nname", code: "not a code",
    });
    expect(describeManagedAiCleanupFailure(outer)).toEqual({
      chain: "Error > Error [ECONNRESET]",
      code: "ECONNRESET",
      message: "write-back failed",
    });
  });

  it("describes a rejection that is not an Error without repeating it", () => {
    expect(describeManagedAiCleanupFailure("raw provider text")).toEqual({ chain: "non-error rejection" });
  });

  it("keeps the message short and on one line", () => {
    const cause = describeManagedAiCleanupFailure(new Error(`first line\n${"word ".repeat(100)}`));
    expect(cause.message!.length).toBeLessThanOrEqual(160);
    expect(cause.message).not.toContain("\n");
    expect(cause.message).toMatch(/^first line word/);
  });
});

describe("runManagedAiCleanup", () => {
  it("runs the refresh, then removes the home", async () => {
    const order: string[] = [];
    await runManagedAiCleanup({
      provider: "openai", method: "subscription",
      refresh: async () => { order.push("refresh"); },
      remove: async () => { order.push("cleanup"); },
    });
    expect(order).toEqual(["refresh", "cleanup"]);
  });

  it("still removes the home when the refresh fails, and names the step and provider", async () => {
    const remove = vi.fn(async () => {});
    const failure = await runManagedAiCleanup({
      provider: "openai", method: "subscription",
      refresh: async () => { throw Object.assign(new Error("ENOENT: no such file or directory, open 'auth.json'"), { code: "ENOENT", syscall: "open" }); },
      remove,
    }).catch((error: unknown) => error);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(ManagedAiCleanupError);
    expect(managedAiCleanupLogFields(failure)).toEqual({
      provider: "openai",
      method: "subscription",
      step: "refresh",
      cause: { chain: "Error [ENOENT]", code: "ENOENT", syscall: "open", message: "ENOENT: no such file or directory, open 'auth.json'" },
    });
  });

  it("reports a failed home removal as the cleanup step", async () => {
    const failure = await runManagedAiCleanup({
      provider: "anthropic", method: "subscription",
      remove: async () => { throw fsError("ENOTEMPTY", "rmdir", "/tmp/paperclip-ai-c-g-x/provider"); },
    }).catch((error: unknown) => error);
    expect(managedAiCleanupLogFields(failure)).toEqual({
      provider: "anthropic",
      method: "subscription",
      step: "cleanup",
      cause: {
        chain: "Error [ENOTEMPTY]", code: "ENOTEMPTY", syscall: "rmdir",
        message: "ENOTEMPTY: directory not empty, rmdir '<ai-home>/provider'",
      },
    });
  });

  it("reports both steps when both fail", async () => {
    const failure = await runManagedAiCleanup({
      provider: "xai", method: "subscription",
      refresh: async () => { throw new Error("merge failed"); },
      remove: async () => { throw fsError("EBUSY", "rmdir", "/tmp/paperclip-ai-c-g-y"); },
    }).catch((error: unknown) => error);
    expect(managedAiCleanupLogFields(failure)).toMatchObject({
      provider: "xai",
      step: "refresh+cleanup",
      cause: { chain: "Error", message: "merge failed" },
      otherFailures: [{ step: "cleanup", cause: { code: "EBUSY", syscall: "rmdir" } }],
    });
  });

  it("describes an unexpected rejection without a step", () => {
    expect(managedAiCleanupLogFields(new TypeError("boom"))).toEqual({
      step: "unknown",
      cause: { chain: "TypeError", message: "boom" },
    });
  });
});
