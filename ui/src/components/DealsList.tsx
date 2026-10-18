import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { pipelinesApi, type PipelineStage } from "../api/pipelines";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
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
  version?: number;
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

/** A deal's fields with a new owner; a Pipedrive lead keeps its lead key. Blank removes the owner. */
export function withDealOwner(fields: Record<string, unknown> | null | undefined, owner: string) {
  const next: Record<string, unknown> = { ...(fields ?? {}) };
  const key = "leadOwner" in next && !("dealOwner" in next) ? "leadOwner" : "dealOwner";
  if (owner.trim()) next[key] = owner.trim();
  else delete next[key];
  return next;
}

/**
 * A deal's fields with a new expected close date and probability. A blank input leaves that field as it is;
 * throws when the probability is not a number from 0 to 100.
 */
export function withDealForecast(
  fields: Record<string, unknown> | null | undefined,
  { expectedClose, probability }: { expectedClose: string; probability: string },
) {
  const next: Record<string, unknown> = { ...(fields ?? {}) };
  if (expectedClose.trim()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedClose.trim())) throw new Error("Expected close must be a date");
    next.expectedCloseDate = expectedClose.trim();
  }
  if (probability.trim()) {
    const value = Number(probability);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Probability must be between 0 and 100");
    next.probability = value;
  }
  return next;
}

/** A deal's fields with a new next step; the subject is cleared when none is given. */
export function withDealNextStep(fields: Record<string, unknown> | null | undefined, { date, subject }: { date: string; subject: string }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) throw new Error("Choose a date for the next step");
  const next: Record<string, unknown> = { ...(fields ?? {}), nextActivityDate: date.trim() };
  if (subject.trim()) next.nextActivitySubject = subject.trim();
  else delete next.nextActivitySubject;
  return next;
}

/** Stages several deals can be moved to at once: open stages only, because won and lost need an outcome each. */
export function bulkMoveStages(stages: readonly PipelineStage[]) {
  return [...stages]
    .filter((stage) => stage.kind !== "done" && stage.kind !== "cancelled")
    .sort((left, right) => left.position - right.position);
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
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [owner, setOwner] = useState("");
  const selectedRows = rows.filter((row) => selected.has(row.item.id));
  const moveTargets = useMemo(() => bulkMoveStages(stages), [stages]);
  const [targetStageId, setTargetStageId] = useState("");
  const refreshBoards = (pipelineIds: string[]) =>
    Promise.all([...new Set(pipelineIds)].map((pipelineId) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) })));

  const moveDeals = useMutation({
    mutationFn: async () => {
      const target = moveTargets.find((stage) => stage.id === targetStageId);
      if (!target) throw new Error("Choose a stage");
      let moved = 0;
      let blocked = 0;
      let closed = 0;
      for (const row of selectedRows) {
        if (row.item.stageId === target.id) continue;
        // Reopening a won or lost deal should be a deliberate step on that deal.
        if (row.days == null && !moveTargets.some((stage) => stage.id === row.item.stageId)) {
          closed += 1;
          continue;
        }
        try {
          await pipelinesApi.transitionCase(row.item.id, { toStageKey: target.key, expectedVersion: row.item.version ?? 0 });
          moved += 1;
        } catch {
          blocked += 1;
        }
      }
      return { moved, blocked, closed, stageName: target.name, pipelineIds: selectedRows.map((row) => row.item.pipelineId) };
    },
    onSuccess: async ({ moved, blocked, closed, stageName, pipelineIds }) => {
      setSelected(new Set());
      setTargetStageId("");
      await refreshBoards(pipelineIds);
      const movedText = `Moved ${moved} ${moved === 1 ? "deal" : "deals"} to ${stageName}`;
      const notes = [
        blocked > 0 ? `${blocked} could not move: a stage rule stopped it or it changed meanwhile. Open it to move it by hand.` : "",
        closed > 0 ? `${closed} won or lost ${closed === 1 ? "deal was" : "deals were"} left as ${closed === 1 ? "it was" : "they were"}.` : "",
      ].filter(Boolean);
      pushToast(notes.length > 0
        ? { title: movedText, body: notes.join(" "), tone: blocked > 0 ? "warn" : "info" }
        : { title: movedText, tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Could not move the deals", tone: "error" });
    },
  });

  const [forecast, setForecast] = useState({ expectedClose: "", probability: "" });
  const updateForecast = useMutation({
    mutationFn: async () => {
      withDealForecast({}, forecast);
      let updated = 0;
      let closed = 0;
      for (const row of selectedRows) {
        // Won and lost deals keep the close date and probability they ended with.
        if (row.days == null && !moveTargets.some((stage) => stage.id === row.item.stageId)) {
          closed += 1;
          continue;
        }
        await pipelinesApi.updateCase(row.item.id, { fields: withDealForecast(row.item.fields, forecast) });
        updated += 1;
      }
      return { updated, closed };
    },
    onSuccess: async ({ updated, closed }) => {
      const pipelineIds = selectedRows.map((row) => row.item.pipelineId);
      setSelected(new Set());
      setForecast({ expectedClose: "", probability: "" });
      await refreshBoards(pipelineIds);
      const title = `Updated ${updated} ${updated === 1 ? "deal" : "deals"}`;
      pushToast(closed > 0
        ? { title, body: `${closed} won or lost ${closed === 1 ? "deal was" : "deals were"} left as ${closed === 1 ? "it was" : "they were"}.`, tone: "info" }
        : { title, tone: "success" });
    },
    onError: async (error) => {
      await refreshBoards(selectedRows.map((row) => row.item.pipelineId));
      pushToast({ title: error instanceof Error ? error.message : "Could not update every deal", tone: "error" });
    },
  });

  const [nextStep, setNextStep] = useState({ date: "", subject: "" });
  const bookNextStep = useMutation({
    mutationFn: async () => {
      withDealNextStep({}, nextStep);
      let booked = 0;
      let closed = 0;
      for (const row of selectedRows) {
        // Won and lost deals have no next step to book.
        if (row.days == null && !moveTargets.some((stage) => stage.id === row.item.stageId)) {
          closed += 1;
          continue;
        }
        await pipelinesApi.updateCase(row.item.id, { fields: withDealNextStep(row.item.fields, nextStep) });
        booked += 1;
      }
      return { booked, closed };
    },
    onSuccess: async ({ booked, closed }) => {
      const pipelineIds = selectedRows.map((row) => row.item.pipelineId);
      setSelected(new Set());
      setNextStep({ date: "", subject: "" });
      await refreshBoards(pipelineIds);
      const title = `Next step booked on ${booked} ${booked === 1 ? "deal" : "deals"}`;
      pushToast(closed > 0
        ? { title, body: `${closed} won or lost ${closed === 1 ? "deal was" : "deals were"} left as ${closed === 1 ? "it was" : "they were"}.`, tone: "info" }
        : { title, tone: "success" });
    },
    onError: async (error) => {
      await refreshBoards(selectedRows.map((row) => row.item.pipelineId));
      pushToast({ title: error instanceof Error ? error.message : "Could not book every next step", tone: "error" });
    },
  });

  const changeOwner = useMutation({
    mutationFn: async () => {
      for (const row of selectedRows) {
        await pipelinesApi.updateCase(row.item.id, { fields: withDealOwner(row.item.fields, owner) });
      }
    },
    onSuccess: async () => {
      const count = selectedRows.length;
      setSelected(new Set());
      setOwner("");
      await refreshBoards(selectedRows.map((row) => row.item.pipelineId));
      pushToast({ title: `Owner changed on ${count} ${count === 1 ? "deal" : "deals"}`, tone: "success" });
    },
    onError: async (error) => {
      await refreshBoards(selectedRows.map((row) => row.item.pipelineId));
      pushToast({ title: error instanceof Error ? `Could not change every owner: ${error.message}` : "Could not change every owner", tone: "error" });
    },
  });

  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No deals to show.</p>;

  const allSelected = rows.every((row) => selected.has(row.item.id));
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="space-y-2">
    {selectedRows.length > 0 ? (
      <form
        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2 text-sm"
        aria-label="Change owner"
        onSubmit={(event) => {
          event.preventDefault();
          changeOwner.mutate();
        }}
      >
        <span className="font-medium">{selectedRows.length} selected</span>
        <Input
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          placeholder="New owner"
          aria-label="New owner"
          className="h-9 w-(--sz-180px)"
        />
        <Button type="submit" size="sm" disabled={changeOwner.isPending || !owner.trim()}>
          {changeOwner.isPending ? "Changing…" : "Change owner"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
      </form>
    ) : null}
    {selectedRows.length > 0 && moveTargets.length > 0 ? (
      <form
        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2 text-sm"
        aria-label="Move to stage"
        onSubmit={(event) => {
          event.preventDefault();
          moveDeals.mutate();
        }}
      >
        <span className="font-medium">Move {selectedRows.length} to</span>
        <NativeSelect
          value={targetStageId}
          onChange={(event) => setTargetStageId(event.target.value)}
          aria-label="Stage to move to"
          className="w-(--sz-180px)"
        >
          <option value="">Choose a stage</option>
          {moveTargets.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
        </NativeSelect>
        <Button type="submit" size="sm" disabled={moveDeals.isPending || !targetStageId}>
          {moveDeals.isPending ? "Moving…" : "Move"}
        </Button>
        <span className="text-xs text-muted-foreground">Mark won or lost on each deal.</span>
      </form>
    ) : null}
    {selectedRows.length > 0 ? (
      <form
        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2 text-sm"
        aria-label="Set close date and probability"
        onSubmit={(event) => {
          event.preventDefault();
          updateForecast.mutate();
        }}
      >
        <span className="font-medium">Set on {selectedRows.length}</span>
        <Input
          type="date"
          value={forecast.expectedClose}
          onChange={(event) => setForecast((current) => ({ ...current, expectedClose: event.target.value }))}
          aria-label="Expected close"
          className="h-9 w-auto"
        />
        <Input
          type="number"
          min={0}
          max={100}
          value={forecast.probability}
          onChange={(event) => setForecast((current) => ({ ...current, probability: event.target.value }))}
          placeholder="Probability %"
          aria-label="Probability"
          className="h-9 w-(--sz-180px)"
        />
        <Button
          type="submit"
          size="sm"
          disabled={updateForecast.isPending || (!forecast.expectedClose && !forecast.probability.trim())}
        >
          {updateForecast.isPending ? "Saving…" : "Set"}
        </Button>
        <span className="text-xs text-muted-foreground">A blank box leaves that field as it is.</span>
      </form>
    ) : null}
    {selectedRows.length > 0 ? (
      <form
        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2 text-sm"
        aria-label="Book next step"
        onSubmit={(event) => {
          event.preventDefault();
          bookNextStep.mutate();
        }}
      >
        <span className="font-medium">Next step for {selectedRows.length}</span>
        <Input
          type="date"
          value={nextStep.date}
          onChange={(event) => setNextStep((current) => ({ ...current, date: event.target.value }))}
          aria-label="Next step on"
          className="h-9 w-auto"
        />
        <Input
          value={nextStep.subject}
          onChange={(event) => setNextStep((current) => ({ ...current, subject: event.target.value }))}
          placeholder="Such as Call"
          aria-label="Next step"
          className="h-9 w-(--sz-180px)"
        />
        <Button type="submit" size="sm" disabled={bookNextStep.isPending || !nextStep.date}>
          {bookNextStep.isPending ? "Booking…" : "Book"}
        </Button>
        <span className="text-xs text-muted-foreground">Replaces any next step already booked.</span>
      </form>
    ) : null}
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm" aria-label="Deals">
        <thead>
          <tr className="bg-muted/30 text-xs text-muted-foreground">
            <th className="w-10 px-3 py-2">
              <Checkbox
                aria-label="Select every deal"
                checked={allSelected}
                onCheckedChange={(value) => setSelected(value === true ? new Set(rows.map((row) => row.item.id)) : new Set())}
              />
            </th>
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
                <Checkbox
                  aria-label={`Select ${row.item.title}`}
                  checked={selected.has(row.item.id)}
                  onCheckedChange={(value) => toggle(row.item.id, value === true)}
                />
              </td>
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
    </div>
  );
}
