import { useState, type FormEvent, type ReactNode } from "react";
import {
  DEFAULT_KPI_AMBER_THRESHOLD_PCT,
  DEFAULT_KPI_RED_THRESHOLD_PCT,
  type Goal,
} from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

/** "" → null, otherwise the number (NaN when it is not one). */
function numberOrNull(text: string): number | null {
  return text.trim() === "" ? null : Number(text);
}

function text(value: number | string | null): string {
  return value == null ? "" : String(value);
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

/** Baseline, target, deadline, direction and the amber / red lines of a KPI. */
export function KpiPlanForm({
  goal,
  onSave,
  pending,
}: {
  goal: Goal;
  onSave: (patch: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [baselineValue, setBaselineValue] = useState(text(goal.baselineValue));
  const [baselineDate, setBaselineDate] = useState(text(goal.baselineDate));
  const [targetValue, setTargetValue] = useState(text(goal.targetValue));
  const [targetDate, setTargetDate] = useState(text(goal.targetDate));
  const [unit, setUnit] = useState(text(goal.unit));
  const [direction, setDirection] = useState(goal.kpiDirection ?? "up");
  const [amber, setAmber] = useState(text(goal.amberThresholdPct));
  const [red, setRed] = useState(text(goal.redThresholdPct));

  const numbers = [baselineValue, targetValue, amber, red].map(numberOrNull);
  const valid = numbers.every((n) => n == null || Number.isFinite(n));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    const [baseline, target, amberPct, redPct] = numbers;
    onSave({
      baselineValue: baseline,
      baselineDate: baselineDate || null,
      targetValue: target,
      targetDate: targetDate || null,
      unit: unit.trim() || null,
      kpiDirection: direction,
      amberThresholdPct: amberPct,
      redThresholdPct: redPct,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-card p-4" aria-label="KPI plan">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="kpi-baseline" label="Baseline">
          <Input id="kpi-baseline" type="number" step="any" value={baselineValue} onChange={(e) => setBaselineValue(e.target.value)} />
        </Field>
        <Field id="kpi-baseline-date" label="Baseline date">
          <Input id="kpi-baseline-date" type="date" value={baselineDate} onChange={(e) => setBaselineDate(e.target.value)} />
        </Field>
        <Field id="kpi-target" label="Target">
          <Input id="kpi-target" type="number" step="any" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} />
        </Field>
        <Field id="kpi-deadline" label="Deadline">
          <Input id="kpi-deadline" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </Field>
        <Field id="kpi-unit" label="Unit">
          <Input id="kpi-unit" value={unit} placeholder="e.g. %, USD, staff" onChange={(e) => setUnit(e.target.value)} />
        </Field>
        <Field id="kpi-direction" label="Good is">
          <NativeSelect id="kpi-direction" value={direction} onChange={(e) => setDirection(e.target.value as "up" | "down")}>
            <option value="up">Up (higher is better)</option>
            <option value="down">Down (lower is better)</option>
          </NativeSelect>
        </Field>
        <Field id="kpi-amber" label="Amber at % off plan">
          <Input
            id="kpi-amber"
            type="number"
            step="any"
            min={0}
            value={amber}
            placeholder={String(DEFAULT_KPI_AMBER_THRESHOLD_PCT)}
            onChange={(e) => setAmber(e.target.value)}
          />
        </Field>
        <Field id="kpi-red" label="Red at % off plan">
          <Input
            id="kpi-red"
            type="number"
            step="any"
            min={0}
            value={red}
            placeholder={String(DEFAULT_KPI_RED_THRESHOLD_PCT)}
            onChange={(e) => setRed(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={!valid || pending}>
          Save plan
        </Button>
        <p className="text-xs text-muted-foreground">
          The plan is a straight line from baseline to target. "% off plan" is a share of the whole planned change.
        </p>
      </div>
    </form>
  );
}

/** Major units → minor units (cents). Null for empty, NaN for bad input. */
function toCents(value: string): number | null {
  const n = numberOrNull(value);
  return n == null ? null : Math.round(n * 100);
}

export function formatMoney(cents: number, currency: string | null): string {
  const amount = cents / 100;
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
    } catch {
      // Unknown code: fall through to a plain number with the code after it.
    }
  }
  const n = amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return currency ? `${n} ${currency}` : n;
}

/** "Spent ₦1,250,000 of ₦5,000,000 (25%)". Null when no budget is set. */
export function budgetSummary(goal: Pick<Goal, "budgetPlannedCents" | "budgetSpentCents" | "budgetCurrency">): string | null {
  const { budgetPlannedCents: planned, budgetSpentCents: spent, budgetCurrency: currency } = goal;
  if (planned == null && spent == null) return null;
  const spentText = formatMoney(spent ?? 0, currency);
  if (planned == null) return `Spent ${spentText}, no planned budget`;
  const share = planned > 0 ? ` (${Math.round(((spent ?? 0) / planned) * 100)}%)` : "";
  return `Spent ${spentText} of ${formatMoney(planned, currency)}${share}`;
}

export function InitiativeBudgetForm({
  goal,
  onSave,
  pending,
}: {
  goal: Goal;
  onSave: (patch: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [planned, setPlanned] = useState(goal.budgetPlannedCents == null ? "" : String(goal.budgetPlannedCents / 100));
  const [spent, setSpent] = useState(goal.budgetSpentCents == null ? "" : String(goal.budgetSpentCents / 100));
  const [currency, setCurrency] = useState(goal.budgetCurrency ?? "");
  const cents = [toCents(planned), toCents(spent)];
  const valid = cents.every((n) => n == null || (Number.isFinite(n) && n >= 0))
    && (currency.trim() === "" || /^[A-Za-z]{3}$/.test(currency.trim()));
  const summary = budgetSummary(goal);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    onSave({
      budgetPlannedCents: cents[0],
      budgetSpentCents: cents[1],
      budgetCurrency: currency.trim() ? currency.trim().toUpperCase() : null,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-card p-4" aria-label="Budget">
      {summary ? <p className="text-base font-semibold" data-testid="budget-summary">{summary}</p> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field id="budget-planned" label="Planned">
          <Input id="budget-planned" type="number" min={0} step="any" value={planned} onChange={(e) => setPlanned(e.target.value)} />
        </Field>
        <Field id="budget-spent" label="Spent">
          <Input id="budget-spent" type="number" min={0} step="any" value={spent} onChange={(e) => setSpent(e.target.value)} />
        </Field>
        <Field id="budget-currency" label="Currency">
          <Input
            id="budget-currency"
            value={currency}
            maxLength={3}
            placeholder="USD"
            className="uppercase"
            onChange={(e) => setCurrency(e.target.value)}
          />
        </Field>
      </div>
      <Button type="submit" size="sm" disabled={!valid || pending}>
        Save budget
      </Button>
    </form>
  );
}
