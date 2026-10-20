// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GoalPropertiesToggleButton, KpiHeadline, daysHint, kpiTrendPoints } from "./GoalDetail";

describe("GoalPropertiesToggleButton", () => {
  it("shows the reopen control when the properties panel is hidden", () => {
    const html = renderToStaticMarkup(
      <GoalPropertiesToggleButton panelVisible={false} onShowProperties={() => {}} />,
    );

    expect(html).toContain('title="Show properties"');
    expect(html).toContain("opacity-100");
  });

  it("collapses the reopen control while the properties panel is already visible", () => {
    const html = renderToStaticMarkup(
      <GoalPropertiesToggleButton panelVisible onShowProperties={() => {}} />,
    );

    expect(html).toContain("opacity-0");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("w-0");
  });
});

describe("daysHint", () => {
  it("says how far the target date is", () => {
    expect(daysHint(null)).toBeNull();
    expect(daysHint(1)).toBe("1 day to go");
    expect(daysHint(12)).toBe("12 days to go");
    expect(daysHint(-3)).toBe("3 days late");
  });
});

describe("KpiHeadline", () => {
  const readings = [
    { readingDate: "2026-10-01", value: 140 },
    { readingDate: "2026-09-01", value: 130 },
    { readingDate: "2026-08-01", value: 120 },
  ];

  it("turns newest-first readings into an oldest-first trend", () => {
    expect(kpiTrendPoints(readings).map((point) => point.value)).toEqual([120, 130, 140]);
    expect(kpiTrendPoints(undefined)).toEqual([]);
  });

  it("leads with value against target, the status word, the trend and the owner", () => {
    const html = renderToStaticMarkup(
      <KpiHeadline
        goal={{
          kpiStatus: { status: "amber", reason: "behind_plan", gapPercent: 8, latestValue: 140, plannedValue: 152, latestDate: "2026-10-01" } as never,
          latestReading: { value: 140, readingDate: "2026-10-01" } as never,
          targetValue: 200,
          targetDate: "2026-12-31",
          unit: "k",
        }}
        ownerName="Ama Mensah"
        readings={readings as never}
      />,
    );
    expect(html).toContain("140 k");
    expect(html).toContain("of 200 k by 31 Dec");
    expect(html).toContain("Watch");
    expect(html).toContain('data-testid="kpi-sparkline"');
    expect(html).toContain("Owner: Ama Mensah");
  });
});
