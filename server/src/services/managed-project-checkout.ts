import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Project, ProjectWorkspace } from "@greatstone/shared";

const execFile = promisify(execFileCallback);

async function readOriginUrl(cwd: string): Promise<string | null> {
  return execFile("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 10_000 })
    .then((result) => result.stdout.trim() || null)
    .catch(() => null);
}

async function hasGitDir(cwd: string): Promise<boolean> {
  return Boolean(await fs.stat(path.join(cwd, ".git")).catch(() => null));
}

/**
 * Finds the managed checkout that `ensureManagedProjectWorkspace` already cloned for a
 * repo-only project workspace, without cloning anything. Mirrors its path rule: the plain
 * managed folder, or the hash-suffixed sibling when the plain folder holds another repo.
 * Returns null when no checkout of this workspace's repo exists yet.
 */
export async function findExistingManagedProjectCheckout(
  project: Pick<Project, "codebase">,
  workspace: Pick<ProjectWorkspace, "id" | "cwd" | "repoUrl">,
): Promise<string | null> {
  if (workspace.cwd) return null;
  const codebase = project.codebase;
  if (!codebase || codebase.workspaceId !== workspace.id || codebase.origin !== "managed_checkout") return null;
  const repoUrl = workspace.repoUrl;
  if (!repoUrl) return null;

  const base = codebase.managedFolder;
  if (await hasGitDir(base)) {
    const origin = await readOriginUrl(base);
    if (!origin || origin === repoUrl) return base;
  }
  const suffixed = `${base}-${createHash("sha256").update(repoUrl).digest("hex").slice(0, 12)}`;
  if (await hasGitDir(suffixed) && (await readOriginUrl(suffixed)) === repoUrl) return suffixed;
  return null;
}
