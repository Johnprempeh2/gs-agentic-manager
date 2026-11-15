import { describe, expect, it } from "vitest";
import { questChaptersFor, questProgress, type QuestFeatures } from "@greatstone/shared";
import type { QuestState } from "@/api/onboarding";
import { toCompanyRelativePath } from "./company-routes";
import { pendingVisit, questChanges, showMeHref } from "./onboarding-quest";

const off: QuestFeatures = { escalateToOwner: false, routedApprovals: false };

function stateFor(role: QuestState["role"], done: Record<string, string> = {}, features = off, started = "2026-11-16T09:00:00.000Z"): QuestState {
  const visible = questChaptersFor({ role, features, permissions: new Set(["website:view"]) });
  const progress = questProgress(visible, new Map(Object.entries(done).map(([k, v]) => [k, new Date(v)])), new Set(), new Date(started), null);
  return { ...progress, role, roleLabel: role, features, autoOpen: false, practiceIssueId: "p1", practiceArchived: false, control: { can: [], cannot: [], askFirst: [] } };
}
const keys = (state: QuestState) => state.chapters.flatMap((c) => c.steps.map((s) => s.key));

describe("Getting started in the app", () => {
  it("shapes the quest by role and keeps PR B steps hidden until their feature is on", () => {
    expect(keys(stateFor("operator"))).not.toContain("open-members");
    expect(keys(stateFor("owner"))).toContain("open-members");
    expect(keys(stateFor("viewer"))).not.toContain("message-everest");
    expect(keys(stateFor("operator"))).not.toContain("approve-routed");
    expect(keys(stateFor("operator", {}, { escalateToOwner: true, routedApprovals: true }))).toEqual(
      expect.arrayContaining(["escalate-practice", "approve-routed", "self-approval-blocked"]),
    );
    // Owners may approve their own requests, so they never get the "you cannot" step.
    expect(keys(stateFor("owner", {}, { escalateToOwner: true, routedApprovals: true }))).not.toContain("self-approval-blocked");
  });

  it("ticks a visit step only on its page, only once, and only while the quest runs", () => {
    const state = stateFor("operator");
    expect(pendingVisit("/desk", state)).toBe("open-desk");
    expect(pendingVisit("/desk?tour=questhint-open-desk", state)).toBe("open-desk");
    expect(pendingVisit("/projects/abc?tab=deliverables", state)).toBe("open-deliverables");
    expect(pendingVisit("/projects/abc/deliverables", state)).toBe("open-deliverables");
    expect(pendingVisit("/projects", state)).toBeNull();
    expect(pendingVisit("/messages", state)).toBe("open-messages");
    // The host reads the company relative path: the quest page must lose its company prefix too.
    expect(pendingVisit(toCompanyRelativePath("/NOR/getting-started") + "?section=control", state)).toBe("read-control");
    expect(pendingVisit("/company/settings/members", state)).toBeNull(); // not an operator's step
    expect(pendingVisit("/desk", stateFor("operator", { "open-desk": "2026-11-16T09:01:00.000Z" }))).toBeNull();
    expect(pendingVisit("/desk", { ...state, startedAt: null })).toBeNull();
  });

  it("sends Show me to the place with its spotlight, and waits for the practice task", () => {
    expect(showMeHref({ key: "open-desk", path: "/dashboard" }, null)).toBe("/dashboard?tour=questhint-open-desk");
    expect(showMeHref({ key: "reply-practice", path: "/issues/{practice}" }, "p1")).toBe("/issues/p1?tour=questhint-reply-practice");
    expect(showMeHref({ key: "reply-practice", path: "/issues/{practice}" }, null)).toBeNull();
    expect(showMeHref({ key: "welcome-tour", path: "/dashboard?tour=welcome" }, "p1")).toBe("/dashboard?tour=welcome");
  });

  it("notices new steps, new badges and the finish", () => {
    const before = stateFor("operator", { "welcome-tour": "2026-11-16T09:01:00.000Z", "open-messages": "2026-11-16T09:01:00.000Z", "message-everest": "2026-11-16T09:02:00.000Z" });
    const after = stateFor("operator", { "welcome-tour": "2026-11-16T09:01:00.000Z", "open-messages": "2026-11-16T09:01:00.000Z", "message-everest": "2026-11-16T09:02:00.000Z", "open-desk": "2026-11-16T09:03:00.000Z" });
    expect(questChanges(before, after)).toEqual({ steps: ["Open your Desk"], chapters: ["Find your way"], finished: false });
    expect(questChanges(undefined, after).steps).toEqual([]);
  });
});
