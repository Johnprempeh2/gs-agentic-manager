import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_TOURS, CORE_TOURS, INBOX_TOUR, coreTourForPath } from "./feature-tours";
import { WEBSITE_MODULE_TOURS, WEBSITE_TAB_TOURS } from "./website-tours";

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
    expect(coreTourForPath("/inbox/mine")?.id).toBe("inbox");
    expect(coreTourForPath("/inbox/unread")?.id).toBe("inbox");
    expect(coreTourForPath("/inbox/requests")).toBeNull();
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

  it("keeps tour ids unique and the copy free of dashes and filler words", () => {
    expect(new Set(ALL_TOURS.map((tour) => tour.id)).size).toBe(ALL_TOURS.length);
    for (const tour of ALL_TOURS) {
      for (const text of [tour.title, tour.description, ...tour.steps.flatMap((step) => [step.title, step.body])]) {
        expect(text).not.toMatch(/[–—]/);
      }
    }
    // The newer tours also keep to the house words; older tours predate the rule.
    for (const tour of [...WEBSITE_MODULE_TOURS, INBOX_TOUR]) {
      expect(tour.steps.length).toBeGreaterThanOrEqual(3);
      for (const text of [tour.title, tour.description, ...tour.steps.flatMap((step) => [step.title, step.body])]) {
        expect(text).not.toMatch(/\b(leverage|robust|seamless|unlock|empower|journey|landscape)/i);
      }
    }
  });
});

describe("website and commerce tours", () => {
  it("opens the catalogue tour from the page bar, and keeps the editor tour off it", () => {
    expect(coreTourForPath("/commerce/offerings")?.id).toBe("commerce-catalogue");
    expect(coreTourForPath("/commerce/quotes")?.id).toBe("commerce-sales");
    expect(coreTourForPath("/commerce/invoices")?.id).toBe("commerce-sales");
    expect(coreTourForPath("/commerce/quotes/q1")).toBeNull();
    expect(coreTourForPath("/commerce/vendors")).toBeNull();
    expect(coreTourForPath("/website/sites/s1/pages/p1/design")).toBeNull();
  });

  it("points every stop at an anchor the pages really carry", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const source = (readdirSync(src, { recursive: true }) as string[])
      .filter((file) => file.endsWith(".tsx") && !/\.(test|stories)\.tsx$/.test(file))
      .map((file) => readFileSync(`${src}/${file}`, "utf8"))
      .join("\n");
    // The catalogue writes its search label with a template, so the name is not in the source as text.
    const notLiteral = ["Search offerings"];
    const targets = [...WEBSITE_MODULE_TOURS, INBOX_TOUR].flatMap((tour) => tour.steps.flatMap((step) => step.target ?? []));
    expect(targets.length).toBeGreaterThan(30);
    const missing = targets.filter((target) =>
      !notLiteral.includes(target)
      && !["data-testid", "data-tour", "aria-label", "ariaLabel"].some((attribute) => source.includes(`${attribute}="${target}"`)));
    expect(missing).toEqual([]);
  });

  it("lists every Website tab tour on the Tutorials page", () => {
    const listed = new Set(ALL_TOURS.map((tour) => tour.id));
    for (const tour of Object.values(WEBSITE_TAB_TOURS)) expect(listed.has(tour!.id)).toBe(true);
  });
});
