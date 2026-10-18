import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { PipelineStage } from "../api/pipelines";
import { daysInStage, readDevtoolsDeal } from "../lib/client-case";
import { Link } from "@/lib/router";
import { cn, formatCalendarDay, formatNumber } from "@/lib/utils";

// Pipedrive's list view for a DevTools pipeline: every deal on one sortable
// table, for people who would rather scan values and dates than columns.

export interface DealsListCase {
  id: string;
  pipelineId: string;
  title: string;
  stageId?: string | null;
  fields?: Record<string, unknown> | null;
  stageEnteredAt?: Date | string | null;
}

export type DealsSortKey = "title" | "stage" | "value" | "weighted" | "owner" | "expectedClose" | "nextStep" | "days";

export interface DealsListRow {
  item: DealsListCase;
  stageName: string;
  stagePosition: number;
  value: number | null;
  currency: string;
  weighted: number | null;
  owner: string;
  expectedClose: string;
  nextStep: string;
  nextStepSubject: string;
  days: number | null;
}

export function buildDealRows(cases: readonly DealsListCase[], stages: readonly PipelineStage[], now: Date = new Date()): DealsListRow[] {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  return cases.map((item) => {
    const deal = readDevtoolsDeal(item.fields);
    const stage = item.stageId ? stageById.get(item.stageId) : undefined;
    const probability = deal.probability == null ? null : Math.min(100, Math.max(0, deal.probability));
    const subject = typeof item.fields?.nextActivitySubject === "string" ? item.fields.nextActivitySubject.trim() : "";
    return {
      item,
      stageName: stage?.name ?? "",
      stagePosition: stage?.position ?? Number.MAX_SAFE_INTEGER,
      value: deal.value,
      currency: deal.currency ?? "",
      weighted: deal.value != null && probability != null ? (deal.value * probability) / 100 : null,
      owner: deal.owner ?? "",
      expectedClose: deal.expectedClose?.slice(0, 10) ?? "",
      nextStep: deal.nextActivity?.slice(0, 10) ?? "",
      nextStepSubject: subject,
      days: stage?.kind === "done" || stage?.kind === "cancelled" ? null : daysInStage(item.stageEnteredAt, now),
    };
  });
}

/** Sorted rows; empty values always go last, whichever way the sort runs. */
export function sortDealRows(rows: readonly DealsListRow[], key: DealsSortKey, direction: "asc" | "desc"): DealsListRow[] {
  const read = (row: DealsListRow): string | number | null => {
    switch (key) {
      case "title": return row.item.title.toLowerCase();
      case "stage": return row.stagePosition;
      case "value": return row.value;
      case "weighted": return row.weighted;
      case "owner": return row.owner.toLowerCase() || null;
      case "expectedClose": return row.expectedClose || null;
      case "nextStep": return row.nextStep || null;
      case "days": return row.days;
    }
  };
  return [...rows].sort((left, right) => {
    const a = read(left);
    const b = read(right);
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    const order = a < b ? -1 : a > b ? 1 : 0;
    return direction === "asc" ? order : -order;
  });
}

const COLUMNS: Array<{ key: DealsSortKey; label: string; numeric?: boolean }> = [
  { key: "title", label: "Deal" },
  { key: "stage", label: "Stage" },
  { key: "value", label: "Value", numeric: true },
  { key: "weighted", label: "Weighted", numeric: true },
  { key: "owner", label: "Owner" },
  { key: "expectedClose", label: "Expected close" },
  { key: "nextStep", label: "Next step" },
  { key: "days", label: "Days in stage", numeric: true },
];

function money(value: number | null, currency: string) {
  return value == null ? "" : `${formatNumber(value, { maximumFractionDigits: 0 })}${currency ? ` ${currency}` : ""}`;
}

export function DealsList({ cases, stages }: { cases: readonly DealsListCase[]; stages: readonly PipelineStage[] }) {
  const [sort, setSort] = useState<{ key: DealsSortKey; direction: "asc" | "desc" }>({ key: "nextStep", direction: "asc" });
  const rows = useMemo(() => sortDealRows(buildDealRows(cases, stages), sort.key, sort.direction), [cases, stages, sort]);
  const today = new Date().toISOString().slice(0, 10);

  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No deals to show.</p>;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm" aria-label="Deals">
        <thead>
          <tr className="bg-muted/30 text-xs text-muted-foreground">
            {COLUMNS.map((column) => {
              const active = sort.key === column.key;
              return (
                <th
                  key={column.key}
                  className={cn("px-3 py-2 font-medium", column.numeric ? "text-right" : "text-left")}
                  aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    className="inline-flex min-h-9 items-center gap-1 hover:text-foreground"
                    onClick={() =>
                      setSort((current) => ({
                        key: column.key,
                        direction: current.key === column.key && current.direction === "asc" ? "desc" : "asc",
                      }))
                    }
                  >
                    {column.label}
                    {active ? (sort.direction === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : null}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.item.id} className="border-t border-border/60" data-testid="deal-row">
              <td className="px-3 py-2">
                <Link to={`/pipelines/${row.item.pipelineId}/items/${row.item.id}`} className="font-medium text-foreground hover:underline">
                  {row.item.title}
                </Link>
              </td>
              <td className="px-3 py-2 text-muted-foreground">{row.stageName}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(row.value, row.currency)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{money(row.weighted, row.currency)}</td>
              <td className="px-3 py-2">{row.owner}</td>
              <td className="px-3 py-2">{row.expectedClose ? formatCalendarDay(row.expectedClose) : ""}</td>
              <td className={cn("px-3 py-2", row.nextStep && row.nextStep < today && row.days != null && "text-status-danger-foreground")}>
                {row.nextStep ? formatCalendarDay(row.nextStep) : ""}
                {row.nextStepSubject && row.nextStep ? <span className="block text-xs text-muted-foreground">{row.nextStepSubject}</span> : null}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{row.days ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
