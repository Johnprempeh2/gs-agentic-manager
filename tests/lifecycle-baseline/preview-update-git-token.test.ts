import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubLauncherSource } from "../../packages/adapter-utils/src/github-launcher.js";
import type { PreviewUpdateTarget } from "../../server/src/services/preview-update.js";

const token = "personal-token-must-stay-out-of-workspace-jobs";
const captured = vi.hoisted(() => ({ runJob: vi.fn(), authorizedOrigin: "" }));
vi.mock("../../server/src/services/git-credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/src/services/git-credentials.js")>()),
  createGitRemoteAuthProvider: () => async (remoteUrl: string) => ({ env: {
    GSAM_GIT_TOKEN: token, GH_TOKEN: token, GITHUB_TOKEN: token,
    ...(captured.authorizedOrigin ? {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${captured.authorizedOrigin}.insteadOf`,
      GIT_CONFIG_VALUE_0: remoteUrl,
    } : {}),
  } }),
}));
vi.mock("../../server/src/services/workspace-runtime.js", () => ({
  runWorkspaceJobForControl: captured.runJob,
}));
vi.mock("../../server/src/services/workspace-operations.js", () => ({
  workspaceOperationService: () => ({ createRecorder: () => ({}) }),
}));

import { defaultDeps } from "../../server/src/services/preview-update.js";

describe("GRE-2971 preview update credential boundary", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    captured.runJob.mockReset();
    captured.authorizedOrigin = "";
    vi.unstubAllEnvs();
    for (const cwd of workspaces.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("does not give the configured shell job a personal Git token that it can print into operation logs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-token-boundary-"));
    workspaces.push(root);
    const origin = path.join(root, "origin.git");
    const cwd = path.join(root, "checkout");
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
    execFileSync("git", ["clone", "-q", origin, cwd]);
    fs.writeFileSync(path.join(cwd, "index.html"), "ready");
    execFileSync("git", ["-C", cwd, "add", "index.html"]);
    execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);
    execFileSync("git", ["-C", cwd, "push", "-q", "origin", "main"]);
    const remoteUrl = pathToFileURL(origin).href;
    execFileSync("git", ["-C", cwd, "remote", "set-url", "origin", remoteUrl]);
    const target = {
      project: { id: "project-1", companyId: "company-1", codebase: null },
      workspace: { id: "workspace-1", cwd, repoUrl: remoteUrl,
        repoRef: "main", defaultRef: "main", metadata: null, runtimeConfig: null, runtimeServices: [] },
    } as unknown as PreviewUpdateTarget;

    await defaultDeps({} as Parameters<typeof defaultDeps>[0]).runJob(target, cwd, {
      id: "update", kind: "job", name: "Update", command: "printenv GSAM_GIT_TOKEN",
      rawConfig: { command: "printenv GSAM_GIT_TOKEN" },
    } as unknown as Parameters<ReturnType<typeof defaultDeps>["runJob"]>[2], "manual");

    const env = captured.runJob.mock.calls[0]?.[0]?.requiredEnv as Record<string, string>;
    expect(env.GSAM_GIT_TOKEN).toBe("");
    expect(env.GH_TOKEN).toBe("");
    expect(env.GITHUB_TOKEN).toBe("");
    const localOriginIndex = Number(env.GIT_CONFIG_COUNT) - 1;
    expect(env[`GIT_CONFIG_KEY_${localOriginIndex}`]).toBe(`url.${cwd}.insteadOf`);
    expect(env[`GIT_CONFIG_VALUE_${localOriginIndex}`]).toBe(remoteUrl);
    // The agent runner's Git launcher filters GIT_CONFIG_*; the workspace job
    // runs the host Git binary, so check URL rewriting without that launcher.
    const hostPath = process.env.PATH?.split(path.delimiter)
      .filter((entry) => entry !== process.env.GSAM_GITHUB_LAUNCHER_DIR).join(path.delimiter);
    expect(execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      env: { ...process.env, ...env, PATH: hostPath }, encoding: "utf8",
    }).trim()).toBe(cwd);
    expect(JSON.stringify(captured.runJob.mock.calls)).not.toContain(token);
  });

  it.each(["absent", "present", "inherited PATH only"])("uses the selected grant and local checkout with GSAM Git launcher: %s", async (launcherMode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-launcher-boundary-"));
    workspaces.push(root);
    const origin = path.join(root, "origin.git");
    const upstream = path.join(root, "upstream");
    const cwd = path.join(root, "checkout");
    const remoteUrl = "https://github.com/greatstone-test/private-preview.git";
    const hostPath = (process.env.PATH ?? "").split(path.delimiter)
      .filter((entry) => entry !== process.env.GSAM_GITHUB_LAUNCHER_DIR
        && path.basename(path.dirname(entry)) !== "paperclip-github-runtime").join(path.delimiter);
    const hostEnv = { ...process.env, PATH: hostPath, BASH_ENV: os.devNull, ZDOTDIR: os.devNull };
    const hostGit = (args: string[]) => execFileSync("git", args, { env: hostEnv, encoding: "utf8" }).trim();
    hostGit(["init", "--bare", "-q", "-b", "main", origin]);
    hostGit(["clone", "-q", origin, upstream]);
    fs.writeFileSync(path.join(upstream, "index.html"), "first");
    hostGit(["-C", upstream, "add", "index.html"]);
    hostGit(["-C", upstream, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);
    hostGit(["-C", upstream, "push", "-q", "origin", "main"]);
    hostGit(["clone", "-q", origin, cwd]);
    fs.writeFileSync(path.join(upstream, "index.html"), "second");
    hostGit(["-C", upstream, "add", "index.html"]);
    hostGit(["-C", upstream, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "second"]);
    hostGit(["-C", upstream, "push", "-q", "origin", "main"]);
    hostGit(["-C", cwd, "remote", "set-url", "origin", remoteUrl]);
    captured.authorizedOrigin = pathToFileURL(origin).href;

    if (launcherMode !== "absent") {
      const launcher = path.join(root, "paperclip-github-runtime", "run-1");
      fs.mkdirSync(launcher, { recursive: true });
      fs.writeFileSync(path.join(launcher, "git"), githubLauncherSource(), { mode: 0o700 });
      fs.writeFileSync(path.join(launcher, ".bashrc"), `export PATH='${launcher}:${hostPath}'\n`);
      vi.stubEnv("PATH", `${launcher}${path.delimiter}${hostPath}`);
      vi.stubEnv("GSAM_GITHUB_LAUNCHER_DIR", launcherMode === "present" ? launcher : "");
      vi.stubEnv("BASH_ENV", path.join(launcher, ".bashrc"));
      vi.stubEnv("ZDOTDIR", launcher);
    } else {
      vi.stubEnv("PATH", hostPath);
      vi.stubEnv("GSAM_GITHUB_LAUNCHER_DIR", "");
      vi.stubEnv("BASH_ENV", os.devNull);
      vi.stubEnv("ZDOTDIR", os.devNull);
    }
    captured.runJob.mockImplementation(async ({ requiredEnv }) => {
      execFileSync("/bin/bash", ["-c", "git remote get-url origin > resolved-origin && git pull --ff-only origin main"], {
        cwd, env: { ...process.env, ...requiredEnv }, encoding: "utf8",
      });
    });
    const target = {
      project: { id: "project-1", companyId: "company-1", codebase: null },
      workspace: { id: "workspace-1", cwd, repoUrl: remoteUrl,
        repoRef: "main", defaultRef: "main", metadata: null, runtimeConfig: null, runtimeServices: [] },
    } as unknown as PreviewUpdateTarget;
    await defaultDeps({} as Parameters<typeof defaultDeps>[0]).runJob(target, cwd, {
      id: "update", kind: "job", name: "Update", command: "git pull --ff-only origin main",
      rawConfig: { command: "git pull --ff-only origin main" },
    } as unknown as Parameters<ReturnType<typeof defaultDeps>["runJob"]>[2], "manual");

    expect(fs.readFileSync(path.join(cwd, "index.html"), "utf8")).toBe("second");
    expect(fs.readFileSync(path.join(cwd, "resolved-origin"), "utf8").trim()).toBe(cwd);
    expect(JSON.stringify(captured.runJob.mock.calls)).not.toContain(token);
  });
});
