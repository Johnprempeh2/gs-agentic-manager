import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applySharedRunnerBuildDir,
  defaultSharedRunnerBuildDir,
} from "../runner-build-dir.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runnerRoot = path.join(repoRoot, "packages", "paperclip-runner", "runner");

describe("shared runner cargo build-dir (GRE-210)", () => {
  it("uses the account cache folder, not the agent's HOME", () => {
    expect(defaultSharedRunnerBuildDir({ platform: "darwin", homeDir: "/Users/dev", env: {} }))
      .toBe("/Users/dev/Library/Caches/gsam-cargo-build");
    expect(defaultSharedRunnerBuildDir({ platform: "linux", homeDir: "/home/dev", env: {} }))
      .toBe("/home/dev/.cache/gsam-cargo-build");
    expect(defaultSharedRunnerBuildDir({ platform: "linux", homeDir: "/home/dev", env: { XDG_CACHE_HOME: "/cache" } }))
      .toBe("/cache/gsam-cargo-build");
  });

  it("sets CARGO_BUILD_BUILD_DIR for runner builds", () => {
    const env = applySharedRunnerBuildDir({ HOME: "/tmp/agent-home" }, { platform: "darwin", homeDir: "/Users/dev" });
    expect(env.CARGO_BUILD_BUILD_DIR).toBe("/Users/dev/Library/Caches/gsam-cargo-build");
    expect(env.CARGO_TARGET_DIR).toBeUndefined();
  });

  it("keeps a folder the caller chose and leaves CI alone", () => {
    expect(applySharedRunnerBuildDir({ CARGO_BUILD_BUILD_DIR: "/own" }).CARGO_BUILD_BUILD_DIR).toBe("/own");
    expect(applySharedRunnerBuildDir({ CARGO_TARGET_DIR: "/t" }).CARGO_BUILD_BUILD_DIR).toBeUndefined();
    expect(applySharedRunnerBuildDir({ CI: "true" }).CARGO_BUILD_BUILD_DIR).toBeUndefined();
  });

  it("dev-runner sets it before the runner build and the server start", () => {
    const source = fs.readFileSync(path.join(repoRoot, "scripts", "dev-runner.ts"), "utf8");
    const applied = source.indexOf("applySharedRunnerBuildDir(process.env)");
    expect(applied).toBeGreaterThan(0);
    expect(applied).toBeLessThan(source.indexOf("const env: NodeJS.ProcessEnv = {"));
    expect(applied).toBeLessThan(source.indexOf("async function buildPaperclipRunner"));
  });

  it("keeps each checkout's own crates apart in the shared folder", () => {
    const config = fs.readFileSync(path.join(runnerRoot, ".cargo", "config.toml"), "utf8");
    expect(config).toMatch(/^rustc-workspace-wrapper = "\.cargo\/checkout-rustc"$/m);
    const wrapper = path.join(runnerRoot, ".cargo", "checkout-rustc");
    expect(fs.readFileSync(wrapper, "utf8")).toContain('exec "$@"');
    if (process.platform !== "win32") {
      expect(fs.statSync(wrapper).mode & 0o111).not.toBe(0);
    }
  });
});
