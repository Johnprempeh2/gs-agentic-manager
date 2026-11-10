import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_TOURS, CORE_TOURS, coreTourForPath } from "./feature-tours";
import { WEBSITE_MODULE_TOURS } from "./website-tours";

describe("everyday page tours", () => {
  it("finds the tour for each everyday page", () => {
    expect(coreTourForPath("/dashboard")?.id).toBe("dashboard");
    expect(coreTourForPath("/decisions")?.id).toBe("decisions");
    expect(coreTourForPath("/agents/paused")?.id).toBe("agents");
    expect(coreTourForPath("/approvals/all")?.id).toBe("approvals");
    expect(coreTourForPath("/memory/review")?.id).toBe("memory");
    expect(coreTourForPath("/company/settings/integrations")?.id).toBe("integrations");
    expect(coreTourForPath("/inbox/blocked")?.id).toBe("blocked");
    expect(coreTourForPath("/scorecard")?.id).toBe("scorecard");
    expect(coreTourForPath("/morning")?.id).toBe("morning");
    expect(coreTourForPath("/organisations")?.id).toBe("organisations");
    expect(coreTourForPath("/search")?.id).toBe("search");
    expect(coreTourForPath("/today")?.id).toBe("morning");
    expect(coreTourForPath("/deliverables")?.id).toBe("deliverables");
    expect(coreTourForPath("/since-last-visit")?.id).toBe("since-last-visit");
    expect(coreTourForPath("/inbox/mine")).toBeNull();
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
    for (const tour of ALL_TOURS) {
      for (const text of [tour.title, tour.description, ...tour.steps.flatMap((step) => [step.title, step.body])]) {
        expect(text).not.toMatch(/[–—]/);
      }
    }
  });
});

describe("website and commerce tours", () => {
  it("opens the catalogue tour from the page bar, and keeps the editor tour off it", () => {
    expect(coreTourForPath("/commerce/offerings")?.id).toBe("commerce-catalogue");
    expect(coreTourForPath("/commerce/quotes")).toBeNull();
    expect(coreTourForPath("/website/sites/s1/pages/p1/design")).toBeNull();
  });

  it("points every stop at an anchor the pages really carry", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const source = (readdirSync(src, { recursive: true }) as string[])
      .filter((file) => file.endsWith(".tsx") && !/\.(test|stories)\.tsx$/.test(file))
      .map((file) => readFileSync(`${src}/${file}`, "utf8"))
      .join("\n");
    // Written with a template (Search offerings), or arriving with the catalogue's search and filters.
    const notLiteral = ["Search offerings", "Category", "commerce-catalogue-count"];
    const targets = WEBSITE_MODULE_TOURS.flatMap((tour) => tour.steps.flatMap((step) => step.target ?? []));
    expect(targets.length).toBeGreaterThan(15);
    const missing = targets.filter((target) =>
      !notLiteral.includes(target)
      && !["data-testid", "data-tour", "aria-label", "ariaLabel"].some((attribute) => source.includes(`${attribute}="${target}"`)));
    expect(missing).toEqual([]);
  });
});
