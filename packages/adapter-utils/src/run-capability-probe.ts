// Checks, at the start of a local run, that the tools an agent declared it
// needs are present on this machine. It only reads: it runs short version and
// status commands and looks for files. It never pushes, writes or installs.
//
// Each check has its own timeout and all checks run at the same time, so the
// whole probe takes at most about one timeout. Commands run through an
// injectable runner so tests never need real Docker, gh or a browser.

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RUN_CAPABILITY_LABELS, type RunCapabilityKey } from "@greatstone/shared";

export const RUN_CAPABILITY_PROBE_TIMEOUT_MS = 5_000;

export interface CapabilityCommandResult {
  /** Process exit code, or null when it did not exit normally. */
  exitCode: number | null;
  /** Set when the command is not installed or did not finish in time. */
  failure: "not_found" | "timeout" | null;
}

export type CapabilityCommandRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<CapabilityCommandResult>;

export type CapabilityPathChecker = (candidate: string) => Promise<"executable" | "directory" | "missing">;

export type CapabilityDirectoryLister = (dir: string) => Promise<string[]>;

export interface RunCapabilityCheck {
  capability: RunCapabilityKey;
  label: string;
  ok: boolean;
  /** Plain reason for a person who does not know the tool. Only set when not ok. */
  reason: string | null;
  /** Short, non-secret note on what was found, for the run log. */
  detail: string;
  durationMs: number;
}

export interface RunCapabilityProbeReport {
  ok: boolean;
  checks: RunCapabilityCheck[];
  missing: RunCapabilityKey[];
  durationMs: number;
}

export interface ProbeRunCapabilitiesInput {
  required: readonly RunCapabilityKey[];
  /** The environment the agent will run with. Used for PATH and browser settings. */
  env: NodeJS.ProcessEnv;
  /** True when GS Agentic Manager itself hands the run its GitHub access. */
  githubAccessProvidedByPlatform?: boolean;
  timeoutMs?: number;
  runCommand?: CapabilityCommandRunner;
  checkPath?: CapabilityPathChecker;
  listDirectory?: CapabilityDirectoryLister;
  homeDir?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
}

const ASK_OPERATOR = "Ask whoever runs the machine";

export const defaultCapabilityCommandRunner: CapabilityCommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { env: options.env, timeout: options.timeoutMs, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 256 * 1024 },
      (error) => {
        if (!error) {
          resolve({ exitCode: 0, failure: null });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        if (err.code === "ENOENT") {
          resolve({ exitCode: null, failure: "not_found" });
          return;
        }
        if (err.killed) {
          resolve({ exitCode: null, failure: "timeout" });
          return;
        }
        resolve({ exitCode: typeof err.code === "number" ? err.code : null, failure: null });
      },
    );
  });

const defaultPathChecker: CapabilityPathChecker = async (candidate) => {
  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) return "directory";
    await fs.access(candidate, fsConstants.X_OK);
    return "executable";
  } catch {
    return "missing";
  }
};

const defaultDirectoryLister: CapabilityDirectoryLister = async (dir) => {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
};

function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

type CheckOutcome = { ok: true; detail: string } | { ok: false; reason: string; detail: string };

interface ProbeTools {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  runCommand: CapabilityCommandRunner;
  checkPath: CapabilityPathChecker;
  listDirectory: CapabilityDirectoryLister;
  homeDir: string;
  platform: NodeJS.Platform;
  githubAccessProvidedByPlatform: boolean;
}

function run(tools: ProbeTools, command: string, args: string[]) {
  return tools.runCommand(command, args, { env: tools.env, timeoutMs: tools.timeoutMs }).catch(
    (): CapabilityCommandResult => ({ exitCode: null, failure: "not_found" }),
  );
}

function seconds(ms: number) {
  const value = Math.max(1, Math.round(ms / 1000));
  return value === 1 ? "1 second" : `${value} seconds`;
}

async function checkGit(tools: ProbeTools): Promise<CheckOutcome> {
  const result = await run(tools, "git", ["--version"]);
  if (result.exitCode === 0) return { ok: true, detail: "git is installed" };
  if (result.failure === "timeout") {
    return {
      ok: false,
      detail: "git --version timed out",
      reason: `Git did not answer within ${seconds(tools.timeoutMs)} on this machine, so this agent cannot work with code. ${ASK_OPERATOR} to check Git.`,
    };
  }
  return {
    ok: false,
    detail: "git was not found",
    reason: `Git is not installed on this machine, so this agent cannot work with code. ${ASK_OPERATOR} to install Git.`,
  };
}

async function checkGithubCli(tools: ProbeTools): Promise<CheckOutcome> {
  const version = await run(tools, "gh", ["--version"]);
  if (version.exitCode !== 0) {
    return {
      ok: false,
      detail: version.failure === "timeout" ? "gh --version timed out" : "gh was not found",
      reason: `The GitHub command line tool (gh) is not installed on this machine, so this agent cannot push code or open pull requests. ${ASK_OPERATOR} to install it.`,
    };
  }
  if (tools.githubAccessProvidedByPlatform) {
    return { ok: true, detail: "gh is installed; GitHub access is provided by GS Agentic Manager for this run" };
  }
  // `gh auth status` only reads: it reports whether a sign-in or token is present.
  const status = await run(tools, "gh", ["auth", "status"]);
  if (status.exitCode === 0) return { ok: true, detail: "gh is installed and signed in" };
  if (status.failure === "timeout") {
    return {
      ok: false,
      detail: "gh auth status timed out",
      reason: `The GitHub command line tool (gh) did not confirm its sign-in within ${seconds(tools.timeoutMs)}, so this agent cannot be sure it can push code or open pull requests. ${ASK_OPERATOR} to check the network and run "gh auth status".`,
    };
  }
  return {
    ok: false,
    detail: "gh is installed but not signed in",
    reason: `The GitHub command line tool (gh) is not signed in on this machine, so this agent cannot push code or open pull requests. ${ASK_OPERATOR} to sign in with "gh auth login", or connect GitHub in Apps.`,
  };
}

async function checkDocker(tools: ProbeTools): Promise<CheckOutcome> {
  const result = await run(tools, "docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (result.exitCode === 0) return { ok: true, detail: "docker is installed and running" };
  if (result.failure === "not_found") {
    return {
      ok: false,
      detail: "docker was not found",
      reason: `Docker is not installed on this machine, so this agent cannot start its tests. ${ASK_OPERATOR} to install Docker.`,
    };
  }
  return {
    ok: false,
    detail: result.failure === "timeout" ? "docker info timed out" : "docker is installed but the daemon is not reachable",
    reason: `Docker is not running on this machine, so this agent cannot start its tests. ${ASK_OPERATOR} to start Docker.`,
  };
}

const CHROMIUM_EXECUTABLE_ENV_KEYS = [
  "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
  "PUPPETEER_EXECUTABLE_PATH",
  "CHROME_PATH",
] as const;

function defaultPlaywrightBrowsersPath(homeDir: string, platform: NodeJS.Platform) {
  if (platform === "darwin") return path.join(homeDir, "Library", "Caches", "ms-playwright");
  if (platform === "win32") return path.join(homeDir, "AppData", "Local", "ms-playwright");
  return path.join(homeDir, ".cache", "ms-playwright");
}

async function checkChromium(tools: ProbeTools): Promise<CheckOutcome> {
  for (const key of CHROMIUM_EXECUTABLE_ENV_KEYS) {
    const configured = readEnv(tools.env, key);
    if (!configured) continue;
    if ((await tools.checkPath(configured)) === "executable") {
      return { ok: true, detail: `browser found through ${key}` };
    }
    return {
      ok: false,
      detail: `${key} does not point to a browser that can run`,
      reason: `The browser setting ${key} points to a place where no Chromium browser can run, so this agent cannot run browser checks. ${ASK_OPERATOR} to fix ${key} or remove it.`,
    };
  }
  const configuredRoot = readEnv(tools.env, "PLAYWRIGHT_BROWSERS_PATH");
  // "0" asks Playwright to keep browsers inside its own package folder; that
  // cannot be found without loading Playwright, so trust the setting.
  if (configuredRoot === "0") {
    return { ok: true, detail: "PLAYWRIGHT_BROWSERS_PATH=0 keeps browsers with the Playwright package" };
  }
  const root = configuredRoot ?? defaultPlaywrightBrowsersPath(tools.homeDir, tools.platform);
  const entries = await tools.listDirectory(root);
  if (entries.some((entry) => /^chromium(_headless_shell)?-\d+/.test(entry))) {
    return {
      ok: true,
      detail: configuredRoot ? "Chromium found under PLAYWRIGHT_BROWSERS_PATH" : "Chromium found in the default Playwright folder",
    };
  }
  return {
    ok: false,
    detail: configuredRoot ? "no Chromium under PLAYWRIGHT_BROWSERS_PATH" : "no Chromium in the default Playwright folder",
    reason: configuredRoot
      ? `No Chromium browser was found where PLAYWRIGHT_BROWSERS_PATH points, so this agent cannot run browser checks. ${ASK_OPERATOR} to run "npx playwright install chromium" with that setting, or fix the setting.`
      : `No Chromium browser was found on this machine, so this agent cannot run browser checks. ${ASK_OPERATOR} to run "npx playwright install chromium", or set PLAYWRIGHT_BROWSERS_PATH to where it is installed.`,
  };
}

const CHECKS: Record<RunCapabilityKey, (tools: ProbeTools) => Promise<CheckOutcome>> = {
  git: checkGit,
  github_cli: checkGithubCli,
  docker: checkDocker,
  chromium: checkChromium,
};

/**
 * Checks each declared tool once, all at the same time. Returns at once with
 * an empty, passing report when nothing is declared.
 */
export async function probeRunCapabilities(input: ProbeRunCapabilitiesInput): Promise<RunCapabilityProbeReport> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const required = [...new Set(input.required)];
  if (required.length === 0) return { ok: true, checks: [], missing: [], durationMs: 0 };
  const tools: ProbeTools = {
    env: input.env,
    timeoutMs: input.timeoutMs ?? RUN_CAPABILITY_PROBE_TIMEOUT_MS,
    runCommand: input.runCommand ?? defaultCapabilityCommandRunner,
    checkPath: input.checkPath ?? defaultPathChecker,
    listDirectory: input.listDirectory ?? defaultDirectoryLister,
    homeDir: input.homeDir ?? readEnv(input.env, "HOME") ?? os.homedir(),
    platform: input.platform ?? process.platform,
    githubAccessProvidedByPlatform: input.githubAccessProvidedByPlatform === true,
  };
  const checks = await Promise.all(
    required.map(async (capability): Promise<RunCapabilityCheck> => {
      const checkStartedAt = now();
      const outcome = await CHECKS[capability](tools).catch(
        (): CheckOutcome => ({
          ok: false,
          detail: "the check could not run",
          reason: `This machine could not be checked for ${RUN_CAPABILITY_LABELS[capability]}. ${ASK_OPERATOR} to check it.`,
        }),
      );
      return {
        capability,
        label: RUN_CAPABILITY_LABELS[capability],
        ok: outcome.ok,
        reason: outcome.ok ? null : outcome.reason,
        detail: outcome.detail,
        durationMs: Math.max(0, now() - checkStartedAt),
      };
    }),
  );
  const missing = checks.filter((check) => !check.ok).map((check) => check.capability);
  return { ok: missing.length === 0, checks, missing, durationMs: Math.max(0, now() - startedAt) };
}

/** One plain message for a run that stops because tools are missing. */
export function describeMissingRunCapabilities(report: RunCapabilityProbeReport): string | null {
  const reasons = report.checks.filter((check) => !check.ok && check.reason).map((check) => check.reason as string);
  if (reasons.length === 0) return null;
  return `This run stopped before the agent started because this machine is missing something the agent needs. ${reasons.join(" ")}`;
}
