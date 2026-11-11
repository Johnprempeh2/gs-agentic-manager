import { describe, expect, it } from "vitest";
import { rollbackTarget, toProductionRun } from "./production-deploy.js";

describe("production deploy helpers", () => {
  it("rolls back to the newest other production deploy that was published, never a draft, a failure or the live one", () => {
    const sha = "a".repeat(40);
    const deploys = [
      { id: "live", state: "ready", context: "production", published_at: "2026-11-09T06:04:22Z", title: `gsam-source:prod:${sha}` },
      { id: "draft", state: "ready", context: "branch-deploy", published_at: null },
      { id: "broken", state: "error", context: "production", published_at: "2026-11-08T12:00:00Z" },
      { id: "older", state: "ready", context: "production", published_at: "2026-11-07T09:00:00Z" },
      { id: "before", state: "ready", context: "production", published_at: "2026-11-08T10:00:00Z", title: `gsam-source:prod:${sha}` },
    ];
    expect(rollbackTarget(deploys, "live")).toEqual({ deployId: "before", commit: sha, publishedAt: "2026-11-08T10:00:00Z" });
    expect(rollbackTarget([deploys[0]!], "live")).toBeNull();
  });

  it("reads only runs this workflow named", () => {
    const id = "3f0c2b9e-1d2a-4b8c-9e7f-0a1b2c3d4e5f";
    expect(toProductionRun({ id: 7, display_title: `Website rollback ${id}`, status: "in_progress", conclusion: null, created_at: "t", html_url: "u" }))
      .toEqual({ id: 7, action: "rollback", request: id, status: "in_progress", conclusion: null, createdAt: "t", url: "u" });
    expect(toProductionRun({ id: 8, display_title: "Deploy production", status: "completed", created_at: "t", html_url: "u" })).toBeNull();
  });
});
