import type { KpiDraftRow, KpiDraftSuggestion } from "@greatstone/shared";

/** One slide-5 row in the pre-fill dialog, as the person edits it. */
export interface EditableKpiDraftRow {
  bulletId: string;
  text: string;
  unsourced: boolean;
  selected: boolean;
  title: string;
  baselineValue: string;
  baselineDate: string;
  unit: string;
  kpiDirection: "up" | "down";
  benchmarkNote: string;
}

export function toEditableRow(suggestion: KpiDraftSuggestion): EditableKpiDraftRow {
  return {
    bulletId: suggestion.bulletId,
    text: suggestion.text,
    unsourced: suggestion.unsourced,
    selected: false,
    title: suggestion.title,
    baselineValue: suggestion.baselineValue == null ? "" : String(suggestion.baselineValue),
    baselineDate: suggestion.baselineDate ?? "",
    unit: suggestion.unit ?? "",
    kpiDirection: "up",
    benchmarkNote: suggestion.benchmarkNote,
  };
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why a selected row cannot be sent yet, or null when it is ready. */
export function kpiDraftRowProblem(row: EditableKpiDraftRow): string | null {
  if (!row.title.trim()) return "Give the KPI a name";
  const value = row.baselineValue.trim();
  if (value === "" || !Number.isFinite(Number(value))) return "Enter the client's baseline as a number";
  if (!CALENDAR_DATE.test(row.baselineDate)) return "Enter the baseline date";
  return null;
}

/** The selected rows as the API wants them, or the first problem to fix. */
export function buildKpiDraftRequestRows(
  rows: readonly EditableKpiDraftRow[],
): { rows: KpiDraftRow[]; problem: string | null } {
  const selected = rows.filter((row) => row.selected);
  if (selected.length === 0) return { rows: [], problem: "Pick at least one row" };
  for (const row of selected) {
    const problem = kpiDraftRowProblem(row);
    if (problem) return { rows: [], problem: `${row.bulletId}: ${problem}` };
  }
  return {
    rows: selected.map((row) => ({
      bulletId: row.bulletId,
      title: row.title.trim(),
      baselineValue: Number(row.baselineValue.trim()),
      baselineDate: row.baselineDate,
      unit: row.unit.trim() || null,
      kpiDirection: row.kpiDirection,
      benchmarkNote: row.benchmarkNote.trim() || null,
    })),
    problem: null,
  };
}
