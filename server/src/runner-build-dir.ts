import os from "node:os";
import path from "node:path";

// One shared cargo build folder for the Rust runner in every checkout on this
// machine: task worktrees, the preview and the live checkout (GRE-210). Each
// worktree used to compile packages/paperclip-runner/runner from scratch into
// its own ~1 GB `target`.
//
// This sets cargo's build-dir, not CARGO_TARGET_DIR. The build-dir holds the
// intermediate files (dependencies, fingerprints); the final binaries still go
// to each checkout's own runner/target/{debug,release}, which is where the
// server, the tests and stage-runner-binary.mjs look. A shared target-dir would
// also share those final binaries, so one worktree could run another
// worktree's runnerd. runner/.cargo/config.toml keeps the workspace crates
// apart per checkout; see the note there.
export const SHARED_RUNNER_BUILD_DIR_ENV = "CARGO_BUILD_BUILD_DIR";
export const SHARED_RUNNER_BUILD_DIR_NAME = "gsam-cargo-build";

export function defaultSharedRunnerBuildDir(input: {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const platform = input.platform ?? process.platform;
  // Agent runs get their own HOME, so read the account's home folder instead.
  const homeDir = input.homeDir ?? os.userInfo().homedir;
  const env = input.env ?? process.env;
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Caches", SHARED_RUNNER_BUILD_DIR_NAME);
  }
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), SHARED_RUNNER_BUILD_DIR_NAME);
  }
  const cacheHome = env.XDG_CACHE_HOME?.trim() || path.join(homeDir, ".cache");
  return path.join(cacheHome, SHARED_RUNNER_BUILD_DIR_NAME);
}

/**
 * Sets CARGO_BUILD_BUILD_DIR to the shared folder unless the caller chose a
 * build or target folder already. CI keeps its per-checkout `target`, which
 * Swatinem/rust-cache saves and restores.
 */
export function applySharedRunnerBuildDir(
  env: NodeJS.ProcessEnv,
  input: { platform?: NodeJS.Platform; homeDir?: string } = {},
): NodeJS.ProcessEnv {
  if (env.CI) return env;
  if (env[SHARED_RUNNER_BUILD_DIR_ENV] !== undefined) return env;
  if (env.CARGO_TARGET_DIR) return env;
  env[SHARED_RUNNER_BUILD_DIR_ENV] = defaultSharedRunnerBuildDir({ ...input, env });
  return env;
}
