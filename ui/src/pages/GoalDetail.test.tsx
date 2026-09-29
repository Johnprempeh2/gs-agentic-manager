// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GoalPropertiesToggleButton, daysHint } from "./GoalDetail";

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
