import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProjectWorkspacePreviewUpdate } from "@greatstone/shared";
import {
  createPreviewUpdateService,
  findPreviewUpdateJob,
  inspectPreviewCheckout,
  summarizeUpdateFailure,
  type PreviewUpdateDeps,
  type PreviewUpdateTarget,
} from "../services/preview-update.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], {
    encoding: "utf8",
  }).trim();
}

function commitFile(cwd: string, name: string, body: string) {
  fs.writeFileSync(path.join(cwd, name), body);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", `change ${name}`);
}

const UPDATE_JOB = { id: "update", kind: "job", name: "update to latest main", command: "git pull --ff-only origin main" };
const PREVIEW_SERVICE = { id: "preview", kind: "service", name: "preview", command: "npx vite", port: 4100, lifecycle: "shared" };

let root: string;
let origin: string;
let upstream: string;
let checkout: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-update-"));
  origin = path.join(root, "origin.git");
  upstream = path.join(root, "upstream");
  checkout = path.join(root, "checkout");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", "-q", origin, upstream], { stdio: "pipe" });
  git(upstream, "checkout", "-q", "-b", "main");
  commitFile(upstream, "index.html", "v1");
  git(upstream, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, checkout], { stdio: "pipe" });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function harness(options: {
  metadata?: Record<string, unknown> | null;
  running?: boolean;
  jobs?: Record<string, unknown>[];
  failJob?: string;
} = {}) {
  let metadata: Record<string, unknown> | null = options.metadata ?? null;
  const target = (): PreviewUpdateTarget => ({
    project: { id: "project-1", companyId: "company-1", codebase: null as never },
    workspace: {
      id: "workspace-1",
      cwd: checkout,
      repoUrl: origin,
      repoRef: null,
      defaultRef: null,
      metadata,
      runtimeConfig: {
        workspaceRuntime: { commands: [PREVIEW_SERVICE, ...(options.jobs ?? [UPDATE_JOB])] },
        desiredState: "running",
        serviceStates: null,
      },
      runtimeServices: options.running === false ? [] : [{ status: "running", url: "http://127.0.0.1:4100" } as never],
    },
  });
  const restart = vi.fn(async () => undefined);
  const runJob = vi.fn<PreviewUpdateDeps["runJob"]>(async (_target, cwd, job) => {
    if (options.failJob) throw new Error(options.failJob);
    execFileSync("sh", ["-c", job.command!], { cwd, stdio: "pipe" });
  });
  const recordActivity = vi.fn(async () => undefined);
  const saveState = vi.fn<PreviewUpdateDeps["saveState"]>(async (_id, patch) => {
    const current = (metadata?.previewUpdate as Record<string, unknown> | undefined) ?? {};
    metadata = { ...(metadata ?? {}), previewUpdate: { ...current, ...patch } };
  });
  const svc = createPreviewUpdateService({
    loadTarget: async () => target(),
    listRunningPreviewWorkspaces: async () => (options.running === false ? [] : [{ projectId: "project-1", workspaceId: "workspace-1" }]),
    saveState,
    resolveCwd: async (t) => t.workspace.cwd,
    inspect: inspectPreviewCheckout,
    runJob,
    restart,
    shortHead: async (cwd) => git(cwd, "rev-parse", "--short", "HEAD"),
    recordActivity,
    now: () => new Date("2026-10-07T12:00:00.000Z"),
  });
  return { svc, restart, runJob, saveState, recordActivity, state: () => readProjectWorkspacePreviewUpdate(metadata) };
}

describe("findPreviewUpdateJob", () => {
  it("prefers the job with id update, then a job named update", () => {
    expect(findPreviewUpdateJob({ commands: [PREVIEW_SERVICE, UPDATE_JOB] })?.id).toBe("update");
    expect(findPreviewUpdateJob({ jobs: [{ name: "Update site", command: "git pull" }] })?.name).toBe("Update site");
    expect(findPreviewUpdateJob({ commands: [PREVIEW_SERVICE, { kind: "job", name: "lint", command: "x" }] })).toBeNull();
    expect(findPreviewUpdateJob(null)).toBeNull();
  });
});

describe("summarizeUpdateFailure", () => {
  it("keeps git's own error and drops hints and notices", () => {
    const raw = [
      'Workspace job "update to latest main" failed: GS Agentic Manager: GitHub capability_missing; continuing without managed credentials.',
      "Already on 'main'",
      "hint: Diverging branches can't be fast-forwarded, you need to either:",
      "fatal: Not possible to fast-forward, aborting.",
      "From /tmp/origin",
    ].join("\n");
    expect(summarizeUpdateFailure(raw)).toBe("fatal: Not possible to fast-forward, aborting.");
    expect(summarizeUpdateFailure('Workspace job "update" failed with exit code 1')).toBe('Workspace job "update" failed with exit code 1');
    expect(summarizeUpdateFailure("npm ERR! code ERESOLVE\nnpm ERR! more")).toBe("npm ERR! code ERESOLVE");
  });
});

describe("preview update", () => {
  it("Update now pulls the new commit on main and restarts the running preview", async () => {
    commitFile(upstream, "index.html", "v2");
    git(upstream, "push", "-q", "origin", "main");
    const { svc, restart, state, recordActivity } = harness();

    const outcome = await svc.update({ projectId: "project-1", workspaceId: "workspace-1", trigger: "manual" });

    expect(outcome).toEqual({ kind: "finished", state: "updated" });
    expect(fs.readFileSync(path.join(checkout, "index.html"), "utf8")).toBe("v2");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({
      status: "updated",
      trigger: "manual",
      commit: git(upstream, "rev-parse", "--short", "HEAD"),
      updatedAt: "2026-10-07T12:00:00.000Z",
      message: null,
      autoUpdate: true,
    });
    expect(recordActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "updated" }), null);
  });

  it("does not restart a stopped preview, but still updates the checkout", async () => {
    commitFile(upstream, "index.html", "v2");
    git(upstream, "push", "-q", "origin", "main");
    const { svc, restart } = harness({ running: false });

    await svc.update({ projectId: "project-1", workspaceId: "workspace-1", trigger: "manual" });

    expect(fs.readFileSync(path.join(checkout, "index.html"), "utf8")).toBe("v2");
    expect(restart).not.toHaveBeenCalled();
  });

  it("reports up to date without running the job when origin has nothing new", async () => {
    const { svc, runJob, state } = harness();
    const outcome = await svc.update({ projectId: "project-1", workspaceId: "workspace-1", trigger: "manual" });
    expect(outcome).toEqual({ kind: "finished", state: "up_to_date" });
    expect(runJob).not.toHaveBeenCalled();
    expect(state().status).toBe("up_to_date");
  });

  it("skips a checkout with uncommitted changes and says why", async () => {
    commitFile(upstream, "index.html", "v2");
    git(upstream, "push", "-q", "origin", "main");
    fs.writeFileSync(path.join(checkout, "index.html"), "local edit");
    const { svc, runJob, state } = harness();

    const outcome = await svc.update({ projectId: "project-1", workspaceId: "workspace-1", trigger: "auto" });

    expect(outcome).toEqual({ kind: "finished", state: "skipped" });
    expect(runJob).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(checkout, "index.html"), "utf8")).toBe("local edit");
    expect(state().message).toMatch(/uncommitted changes in 1 file/);
  });

  it("skips a checkout that is not on main", async () => {
    commitFile(upstream, "index.html", "v2");
    git(upstream, "push", "-q", "origin", "main");
    git(checkout, "checkout", "-q", "-b", "draft");
    const { svc, runJob, state } = harness();

    await svc.update({ projectId: "project-1", workspaceId: "workspace-1", trigger: "auto" });

    expect(runJob).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ status: "skipped" });
    expect(state().message).toMatch(/on "draft", not "main"/);
  });

  it("records a failed update job with its error", async () => {
    commitFile(upstream, "index.html", "v2");
    git(upstream, "push", "-q", "origin", "main");
    const { svc, restart, state } = harness({ failJob: "npm install exited with code 1" });

    const outcome = await svc.update({ projectId: "project-1", workspaceId: "workspace-1", trigger: "manual" });

    expect(outcome).toEqual({ kind: "finished", state: "failed" });
    expect(restart).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ status: "failed", message: "Update failed: npm install exited with code 1" });
  });

  it("refuses a second update while one is running", async () => {
    commitFile(upstream, "index.html", "v2");
    git(upstream, "push", "-q", "origin", "main");
    const { svc } = harness();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const first = svc.update({ projectId: "project-1", workspaceId: "workspace-1", trigger: "manual", onStarted: started });
    await startedPromise;
    expect(svc.isUpdating("workspace-1")).toBe(true);
    await expect(svc.update({ projectId: "project-1", workspaceId: "workspace-1", trigger: "manual" })).resolves.toEqual({ kind: "busy" });
    await first;
  });

  it("returns no_update_job when the workspace has no update job", async () => {
    const { svc } = harness({ jobs: [] });
    await expect(svc.update({ projectId: "project-1", workspaceId: "workspace-1", trigger: "manual" })).resolves.toEqual({ kind: "no_update_job" });
  });
});

describe("preview auto-update tick", () => {
  it("picks up a new commit on main and restarts the preview", async () => {
    const { svc, restart, runJob, state } = harness();
    await svc.tick();
    expect(runJob).not.toHaveBeenCalled();

    commitFile(upstream, "about.html", "new page");
    git(upstream, "push", "-q", "origin", "main");
    await svc.tick();

    expect(fs.existsSync(path.join(checkout, "about.html"))).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ status: "updated", trigger: "auto", commit: git(upstream, "rev-parse", "--short", "HEAD") });
  });

  it("does nothing when the switch is off", async () => {
    commitFile(upstream, "about.html", "new page");
    git(upstream, "push", "-q", "origin", "main");
    const { svc, runJob } = harness({ metadata: { previewUpdate: { autoUpdate: false } } });
    await svc.tick();
    expect(runJob).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(checkout, "about.html"))).toBe(false);
  });

  it("stays quiet on repeat checks that change nothing", async () => {
    commitFile(upstream, "about.html", "new page");
    git(upstream, "push", "-q", "origin", "main");
    const { svc, saveState } = harness();
    await svc.tick();
    const writesAfterUpdate = saveState.mock.calls.length;
    await svc.tick();
    await svc.tick();
    // First quiet check records "up to date" once; later ones write nothing.
    expect(saveState.mock.calls.length).toBe(writesAfterUpdate + 1);
  });
});
