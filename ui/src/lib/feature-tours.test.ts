import { describe, expect, it } from "vitest";
import { ALL_TOURS, CORE_TOURS, coreTourForPath } from "./feature-tours";

describe("everyday page tours", () => {
  it("finds the tour for each everyday page", () => {
    expect(coreTourForPath("/dashboard")?.id).toBe("dashboard");
    expect(coreTourForPath("/decisions")?.id).toBe("decisions");
    expect(coreTourForPath("/agents/paused")?.id).toBe("agents");
    expect(coreTourForPath("/approvals/all")?.id).toBe("approvals");
    expect(coreTourForPath("/memory/review")?.id).toBe("memory");
  });

  it("has no tour for an item page or a page with its own tour", () => {
    expect(coreTourForPath("/issues/GRE-12")).toBeNull();
    expect(coreTourForPath("/agents/new")).toBeNull();
    expect(coreTourForPath("/decisions/queues/sales")).toBeNull();
    expect(coreTourForPath("/pipelines")).toBeNull();
  });

  it("opens every everyday tour on the page it matches", () => {
    for (const tour of CORE_TOURS) expect(coreTourForPath(tour.route!.path)?.id).toBe(tour.id);
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
