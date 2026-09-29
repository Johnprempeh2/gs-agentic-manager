import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

// The terminal-workspace reaper reads GSAM_WORKSPACE_REAPER_COOLDOWN_DAYS.
// These tests lock the parser contract: the default is 0 (archive on the next
// sweep after close, GRE-208), a positive number sets a cooldown, and empty,
// whitespace-only, negative, or non-numeric values fall back to the default.
// Immediate reaping is safe because the reaper only archives a worktree whose
// work is committed and merged or pushed.

describe("workspace reaper cooldown config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the default of 0 when the variable is not set", () => {
    vi.stubEnv("GSAM_WORKSPACE_REAPER_COOLDOWN_DAYS", undefined);
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });

  it("uses the default of 0 for an empty value", () => {
    vi.stubEnv("GSAM_WORKSPACE_REAPER_COOLDOWN_DAYS", "");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });

  it("uses the default of 0 for a whitespace-only value", () => {
    vi.stubEnv("GSAM_WORKSPACE_REAPER_COOLDOWN_DAYS", "   ");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });

  it("keeps an explicit 0 as immediate reaping", () => {
    vi.stubEnv("GSAM_WORKSPACE_REAPER_COOLDOWN_DAYS", "0");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });

  it("reads a positive whole number", () => {
    vi.stubEnv("GSAM_WORKSPACE_REAPER_COOLDOWN_DAYS", "14");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(14);
  });

  it("trims surrounding whitespace before it reads the number", () => {
    vi.stubEnv("GSAM_WORKSPACE_REAPER_COOLDOWN_DAYS", "  3  ");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(3);
  });

  it("uses the default of 0 for a negative value", () => {
    vi.stubEnv("GSAM_WORKSPACE_REAPER_COOLDOWN_DAYS", "-1");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });

  it("uses the default of 0 for a non-numeric value", () => {
    vi.stubEnv("GSAM_WORKSPACE_REAPER_COOLDOWN_DAYS", "soon");
    expect(loadConfig().workspaceReaperCooldownDays).toBe(0);
  });
});
