import { describe, expect, it } from "vitest";
import { killProcessIfPresent } from "../../packages/adapter-utils/src/test-support/process-cleanup.js";

describe("LCA-11 process cleanup races", () => {
  it("treats ESRCH after PID discovery as an already-complete cleanup", () => {
    const exitedProcess = Object.assign(new Error("kill ESRCH"), {
      code: "ESRCH",
      errno: -3,
      syscall: "kill",
    });

    expect(
      killProcessIfPresent(12345, "SIGKILL", () => {
        throw exitedProcess;
      }),
    ).toBe(false);
  });

  it("does not hide a signal failure for a process that still exists", () => {
    const denied = Object.assign(new Error("kill EPERM"), {
      code: "EPERM",
      errno: -1,
      syscall: "kill",
    });

    expect(() =>
      killProcessIfPresent(12345, "SIGKILL", () => {
        throw denied;
      }),
    ).toThrow(denied);
  });
});
