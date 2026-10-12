import { describe, expect, it } from "vitest";
import { buildKpiDraftRequestRows, toEditableRow, type EditableKpiDraftRow } from "./kpi-drafts";

const SUGGESTION = {
  bulletId: "B1",
  section: "Slide 5. Benchmarks",
  text: "Gross margin: client baseline 18.5%; peer median 24%.",
  title: "Gross margin",
  baselineValue: 18.5,
  unit: "%",
  baselineDate: "2025-12-31",
  benchmarkNote: "B1: peer median 24%",
  unsourced: false,
};

function row(extra: Partial<EditableKpiDraftRow> = {}): EditableKpiDraftRow {
  return { ...toEditableRow(SUGGESTION), selected: true, ...extra };
}

describe("buildKpiDraftRequestRows", () => {
  it("sends only the selected rows, with numbers and trimmed text", () => {
    const result = buildKpiDraftRequestRows([row({ title: " Gross margin " }), row({ bulletId: "B2", selected: false })]);
    expect(result.problem).toBeNull();
    expect(result.rows).toEqual([
      {
        bulletId: "B1",
        title: "Gross margin",
        baselineValue: 18.5,
        baselineDate: "2025-12-31",
        unit: "%",
        kpiDirection: "up",
        benchmarkNote: "B1: peer median 24%",
      },
    ]);
  });

  it("asks for a pick, a baseline number and a date before sending", () => {
    expect(buildKpiDraftRequestRows([row({ selected: false })]).problem).toBe("Pick at least one row");
    expect(buildKpiDraftRequestRows([row({ baselineValue: "" })]).problem).toBe("B1: Enter the client's baseline as a number");
    expect(buildKpiDraftRequestRows([row({ baselineValue: "abc" })]).problem).toContain("baseline");
    expect(buildKpiDraftRequestRows([row({ baselineDate: "" })]).problem).toBe("B1: Enter the baseline date");
  });

  it("starts every row unselected so nothing is created by accident", () => {
    const empty = toEditableRow({ ...SUGGESTION, baselineValue: null, unit: null, baselineDate: null });
    expect(empty).toMatchObject({ selected: false, baselineValue: "", unit: "", baselineDate: "" });
  });
});
