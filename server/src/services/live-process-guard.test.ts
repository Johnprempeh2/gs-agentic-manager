import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePaperclipHomeDir, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { liveProcessGuard } from "./live-process-guard.js";

describe("live process guard", () => {
  it("protects this server's install, its data directories and its own process", () => {
    const guard = liveProcessGuard();
    const [installRoot, ...dataDirs] = guard.protectedPaths;
    expect(existsSync(path.join(installRoot!, "server", "src", "services", "live-process-guard.ts"))).toBe(true);
    expect(dataDirs).toEqual([resolvePaperclipHomeDir(), resolvePaperclipInstanceRoot()]);
    expect(guard.serverPid).toBe(process.pid);
  });
});
