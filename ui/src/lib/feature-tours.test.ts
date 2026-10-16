import { describe, expect, it } from "vitest";
import { ALL_TOURS, CORE_TOURS, coreTourForPath } from "./feature-tours";

describe("everyday page tours", () => {
  it("finds the tour for each everyday page", () => {
    expect(coreTourForPath("/dashboard")?.id).toBe("dashboard");
    expect(coreTourForPath("/decisions")?.id).toBe("decisions");
    expect(coreTourForPath("/agents/paused")?.id).toBe("agents");
    expect(coreTourForPath("/approvals/all")?.id).toBe("approvals");
    expect(coreTourForPath("/memory/review")?.id).toBe("memory");
    expect(coreTourForPath("/company/settings/integrations")?.id).toBe("integrations");
  });

  it("finds the item tours for a task and an agent", () => {
    expect(coreTourForPath("/issues/GRE-12")?.id).toBe("task-detail");
    expect(coreTourForPath("/agents/everest")?.id).toBe("agent-detail");
    expect(coreTourForPath("/agents/everest/instructions")?.id).toBe("agent-detail");
    expect(coreTourForPath("/agents/all")?.id).toBe("agents");
  });

  it("has no tour for a page without one or a page with its own tour", () => {
    expect(coreTourForPath("/agents/new")).toBeNull();
    expect(coreTourForPath("/agents/everest/runs/r1")).toBeNull();
    expect(coreTourForPath("/decisions/queues/sales")).toBeNull();
    expect(coreTourForPath("/pipelines")).toBeNull();
  });

  it("opens every everyday tour on the page it matches", () => {
    for (const tour of CORE_TOURS.filter((t) => !t.id.endsWith("-detail"))) {
      expect(coreTourForPath(tour.route!.path)?.id).toBe(tour.id);
    }
  });

  it("keeps tour ids unique and the copy free of dashes", () => {
    expect(new Set(ALL_TOURS.map((tour) => tour.id)).size).toBe(ALL_TOURS.length);
    for (const tour of CORE_TOURS) {
      for (const text of [tour.title, tour.description, ...tour.steps.flatMap((step) => [step.title, step.body])]) {
        expect(text).not.toMatch(/[–—]/);
      }
    }
  });
});
