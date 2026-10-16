import { describe, expect, it, vi } from "vitest";
import {
  describeMissingRunCapabilities,
  probeRunCapabilities,
  type CapabilityCommandResult,
  type CapabilityCommandRunner,
} from "./run-capability-probe.js";

function runner(results: Record<string, CapabilityCommandResult>): CapabilityCommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const fn: CapabilityCommandRunner = async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    return results[key] ?? { exitCode: null, failure: "not_found" };
  };
  return Object.assign(fn, { calls });
}

const ok: CapabilityCommandResult = { exitCode: 0, failure: null };

describe("probeRunCapabilities", () => {
  it("does nothing and passes when no tools are declared", async () => {
    const runCommand = vi.fn();
    const report = await probeRunCapabilities({ required: [], env: {}, runCommand });
    expect(report).toEqual({ ok: true, checks: [], missing: [], durationMs: 0 });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("passes git when git answers", async () => {
    const report = await probeRunCapabilities({ required: ["git"], env: {}, runCommand: runner({ "git --version": ok }) });
    expect(report.ok).toBe(true);
    expect(report.checks[0]).toMatchObject({ capability: "git", ok: true, reason: null });
  });

  it("explains a missing git in plain words", async () => {
    const report = await probeRunCapabilities({ required: ["git"], env: {}, runCommand: runner({}) });
    expect(report.missing).toEqual(["git"]);
    expect(report.checks[0].reason).toContain("Git is not installed on this machine");
  });

  it("tells apart Docker not installed and Docker not running", async () => {
    const notInstalled = await probeRunCapabilities({ required: ["docker"], env: {}, runCommand: runner({}) });
    expect(notInstalled.checks[0].reason).toContain("Docker is not installed on this machine");

    const notRunning = await probeRunCapabilities({
      required: ["docker"],
      env: {},
      runCommand: runner({ "docker info --format {{.ServerVersion}}": { exitCode: 1, failure: null } }),
    });
    expect(notRunning.checks[0].reason).toBe(
      "Docker is not running on this machine, so this agent cannot start its tests. Ask whoever runs the machine to start Docker.",
    );
    expect(notRunning.checks[0].detail).toBe("docker is installed but the daemon is not reachable");

    const running = await probeRunCapabilities({
      required: ["docker"],
      env: {},
      runCommand: runner({ "docker info --format {{.ServerVersion}}": ok }),
    });
    expect(running.ok).toBe(true);
  });

  it("treats a Docker check that times out as not running", async () => {
    const report = await probeRunCapabilities({
      required: ["docker"],
      env: {},
      runCommand: runner({ "docker info --format {{.ServerVersion}}": { exitCode: null, failure: "timeout" } }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks[0].detail).toBe("docker info timed out");
  });

  it("checks gh is installed and signed in", async () => {
    const signedIn = runner({ "gh --version": ok, "gh auth status": ok });
    expect((await probeRunCapabilities({ required: ["github_cli"], env: {}, runCommand: signedIn })).ok).toBe(true);
    expect(signedIn.calls).toEqual(["gh --version", "gh auth status"]);

    const signedOut = await probeRunCapabilities({
      required: ["github_cli"],
      env: {},
      runCommand: runner({ "gh --version": ok, "gh auth status": { exitCode: 1, failure: null } }),
    });
    expect(signedOut.checks[0].reason).toContain("is not signed in on this machine");

    const missing = await probeRunCapabilities({ required: ["github_cli"], env: {}, runCommand: runner({}) });
    expect(missing.checks[0].reason).toContain("is not installed on this machine");
  });

  it("skips the gh sign-in check when GS Agentic Manager provides GitHub access", async () => {
    const commands = runner({ "gh --version": ok });
    const report = await probeRunCapabilities({
      required: ["github_cli"],
      env: {},
      runCommand: commands,
      githubAccessProvidedByPlatform: true,
    });
    expect(report.ok).toBe(true);
    expect(commands.calls).toEqual(["gh --version"]);
  });

  it("finds Chromium through an executable path setting", async () => {
    const report = await probeRunCapabilities({
      required: ["chromium"],
      env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/opt/chrome/chrome" },
      checkPath: async (candidate) => (candidate === "/opt/chrome/chrome" ? "executable" : "missing"),
      listDirectory: async () => [],
    });
    expect(report.ok).toBe(true);
  });

  it("fails when the Chromium path setting is wrong", async () => {
    const report = await probeRunCapabilities({
      required: ["chromium"],
      env: { CHROME_PATH: "/nowhere/chrome" },
      checkPath: async () => "missing",
      listDirectory: async () => ["chromium-1200"],
    });
    expect(report.ok).toBe(false);
    expect(report.checks[0].reason).toContain("CHROME_PATH");
  });

  it("looks under PLAYWRIGHT_BROWSERS_PATH, then the default folder", async () => {
    const seen: string[] = [];
    const found = await probeRunCapabilities({
      required: ["chromium"],
      env: { PLAYWRIGHT_BROWSERS_PATH: "/browsers" },
      listDirectory: async (dir) => {
        seen.push(dir);
        return ["chromium_headless_shell-1200", "ffmpeg-1011"];
      },
    });
    expect(found.ok).toBe(true);
    expect(seen).toEqual(["/browsers"]);

    const defaultFolder: string[] = [];
    const missing = await probeRunCapabilities({
      required: ["chromium"],
      env: {},
      homeDir: "/home/agent",
      platform: "linux",
      listDirectory: async (dir) => {
        defaultFolder.push(dir);
        return ["firefox-1400"];
      },
    });
    expect(defaultFolder).toEqual(["/home/agent/.cache/ms-playwright"]);
    expect(missing.checks[0].reason).toContain("No Chromium browser was found on this machine");
  });

  it("runs the checks at the same time and joins the reasons", async () => {
    let active = 0;
    let peak = 0;
    const runCommand: CapabilityCommandRunner = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { exitCode: null, failure: "not_found" };
    };
    const report = await probeRunCapabilities({ required: ["git", "docker", "github_cli"], env: {}, runCommand });
    expect(peak).toBe(3);
    expect(report.missing).toEqual(["git", "docker", "github_cli"]);
    const message = describeMissingRunCapabilities(report);
    expect(message).toMatch(/^This run stopped before the agent started/);
    expect(message).toContain("Docker is not installed");
    expect(message).not.toMatch(new RegExp("[\\u2013\\u2014]"));
  });

  it("returns no message when nothing is missing", async () => {
    const report = await probeRunCapabilities({ required: ["git"], env: {}, runCommand: runner({ "git --version": ok }) });
    expect(describeMissingRunCapabilities(report)).toBeNull();
  });

  it("passes the timeout and environment to the runner", async () => {
    const runCommand = vi.fn<CapabilityCommandRunner>(async () => ok);
    await probeRunCapabilities({ required: ["git"], env: { PATH: "/custom/bin" }, runCommand, timeoutMs: 1234 });
    expect(runCommand).toHaveBeenCalledWith("git", ["--version"], { env: { PATH: "/custom/bin" }, timeoutMs: 1234 });
  });

  it("uses the real runner without crashing for a command that does not exist", async () => {
    const report = await probeRunCapabilities({
      required: ["docker"],
      env: { PATH: "/definitely/not/a/real/path" },
      timeoutMs: 2000,
    });
    expect(report.ok).toBe(false);
    expect(report.checks[0].detail).toBe("docker was not found");
  });
});
