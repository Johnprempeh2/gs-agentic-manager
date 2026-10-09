import { useState, type CSSProperties, type FormEvent } from "react";
import {
  KPI_READING_SOURCE_LABELS,
  type GoalKpiReading,
  type GoalRagRollup,
  type KpiRagStatus,
  type KpiReadingSource,
  type KpiStatus,
} from "@greatstone/shared";
import { Database, ShieldCheck, UserRound, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatDateTime, formatShortDate } from "@/lib/utils";

/** Each colour reuses a status token, so light and dark both follow the theme. */
const RAG_COLOR: Record<KpiRagStatus, string> = {
  green: "var(--status-success)",
  amber: "var(--status-warning)",
  red: "var(--status-danger)",
};

export const RAG_LABEL: Record<KpiRagStatus, string> = {
  green: "Green · on track",
  amber: "Amber · slipping",
  red: "Red · off track",
};

const NO_STATUS_COLOR = "var(--status-task-icon-backlog)";

function chipStyle(color: string): CSSProperties {
  return { "--sc": color } as CSSProperties;
}

const CHIP = "status-chip inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium";

export function KpiStatusPill({ status, className }: { status: KpiRagStatus | null; className?: string }) {
  return (
    <span
      className={cn(CHIP, className)}
      style={chipStyle(status ? RAG_COLOR[status] : NO_STATUS_COLOR)}
      data-rag={status ?? "none"}
    >
      {status ? RAG_LABEL[status] : "No status"}
    </span>
  );
}

/** "1 red, 1 amber, 1 green of 4 KPIs" for a goal above the KPIs. */
export function rollupSummary(rollup: GoalRagRollup): string | null {
  const total = rollup.red + rollup.amber + rollup.green + rollup.noStatus;
  if (total === 0) return null;
  const parts = [
    rollup.red ? `${rollup.red} red` : null,
    rollup.amber ? `${rollup.amber} amber` : null,
    rollup.green ? `${rollup.green} green` : null,
    rollup.noStatus ? `${rollup.noStatus} no status` : null,
  ].filter(Boolean);
  return `${parts.join(", ")} of ${total} KPI${total === 1 ? "" : "s"}`;
}

export function formatKpiValue(value: number, unit: string | null): string {
  const n = Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return unit ? `${n} ${unit}` : n;
}

/** One line that says why the KPI has its colour. */
export function kpiStatusSentence(status: KpiStatus, unit: string | null): string {
  const value = status.latestValue != null ? formatKpiValue(status.latestValue, unit) : null;
  const planned = status.plannedValue != null ? formatKpiValue(Math.round(status.plannedValue * 100) / 100, unit) : null;
  switch (status.reason) {
    case "no_plan":
      return "Set a target and a deadline to get a status.";
    case "no_reading":
      return "No reading yet.";
    case "target_met":
      return `Target met: ${value}.`;
    case "deadline_missed":
      return `Deadline passed and the target is not met: ${value} against ${planned}.`;
    case "on_track":
      return `On plan: ${value} against a plan of ${planned} on that date.`;
    case "behind_plan":
      return `${status.gapPercent}% behind plan: ${value} against a plan of ${planned} on that date.`;
  }
}

const SOURCE_STYLE: Record<KpiReadingSource, { icon: LucideIcon; color: string }> = {
  owner_reported: { icon: UserRound, color: "var(--status-task-icon-backlog)" },
  agent_verified: { icon: ShieldCheck, color: "var(--status-success)" },
  system: { icon: Database, color: "var(--status-task-icon-in_progress)" },
};

export function KpiSourceBadge({ source }: { source: KpiReadingSource }) {
  const { icon: Icon, color } = SOURCE_STYLE[source];
  return (
    <span className={CHIP} style={chipStyle(color)} data-source={source}>
      <Icon className="size-3" aria-hidden />
      {KPI_READING_SOURCE_LABELS[source]}
    </span>
  );
}

export type RecorderNames = {
  agents: ReadonlyMap<string, { name: string }>;
  users: ReadonlyMap<string, { label: string }>;
};

function recorderName(reading: GoalKpiReading, names: RecorderNames): string {
  if (reading.recordedByAgentId) return names.agents.get(reading.recordedByAgentId)?.name ?? "An agent";
  if (reading.recordedByUserId) return names.users.get(reading.recordedByUserId)?.label ?? "A person";
  return "Unknown";
}

export function KpiReadingsList({
  readings,
  unit,
  names,
}: {
  /** Newest first. */
  readings: readonly GoalKpiReading[];
  unit: string | null;
  names: RecorderNames;
}) {
  if (readings.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        No readings yet. The owner reports the first number; an agent can then check it.
      </p>
    );
  }
  return (
    <ol className="divide-y divide-border rounded-lg border border-border" data-testid="kpi-readings">
      {readings.map((reading) => (
        <li key={reading.id} className="grid gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[8rem_1fr_auto]">
          <div>
            <p className="font-bold tabular-nums">{formatKpiValue(reading.value, unit)}</p>
            <p className="text-xs text-muted-foreground">{formatShortDate(`${reading.readingDate}T00:00:00`)}</p>
          </div>
          <div className="min-w-0 text-sm">
            {reading.note ? <p className="line-clamp-3 whitespace-pre-line">{reading.note}</p> : null}
            <p className="text-xs text-muted-foreground" title={formatDateTime(reading.createdAt)}>
              Recorded by {recorderName(reading, names)}
            </p>
          </div>
          <div className="sm:text-right">
            <KpiSourceBadge source={reading.source} />
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface NewKpiReading {
  value: number;
  readingDate: string;
  note: string | null;
}

/** Board users record owner-reported readings here; agents post verified ones through the API. */
export function RecordKpiReadingForm({
  onSubmit,
  pending,
  today = new Date().toISOString().slice(0, 10),
}: {
  onSubmit: (reading: NewKpiReading) => void;
  pending: boolean;
  today?: string;
}) {
  const [value, setValue] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const parsed = value.trim() === "" ? NaN : Number(value);
  const valid = Number.isFinite(parsed) && /^\d{4}-\d{2}-\d{2}$/.test(date);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    onSubmit({ value: parsed, readingDate: date, note: note.trim() || null });
    setValue("");
    setNote("");
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="Record a reading">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="kpi-reading-value">Value</Label>
          <Input
            id="kpi-reading-value"
            type="number"
            inputMode="decimal"
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="kpi-reading-date">Date</Label>
          <Input id="kpi-reading-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="kpi-reading-note">Note</Label>
        <Textarea id="kpi-reading-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={!valid || pending}>
          Record reading
        </Button>
        <p className="text-xs text-muted-foreground">Saved as owner reported. Agents add verified readings.</p>
      </div>
    </form>
  );
}
