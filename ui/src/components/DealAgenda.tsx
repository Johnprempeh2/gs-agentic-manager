import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { pipelinesApi, type PipelineCaseChildRow, type PipelineListItem } from "../api/pipelines";
import { queryKeys } from "../lib/queryKeys";
import { formatDealTotals, isDevtoolsCaseType, readDevtoolsDeal, sumDealValues } from "../lib/client-case";
import { useToastActions } from "../context/ToastContext";
import { completeNextStep } from "./DevtoolsDealEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Link } from "@/lib/router";
import { cn, formatCalendarDay } from "@/lib/utils";

// Pipedrive's Activities list for the DevTools deals: every open deal's next
// step across the deal pipelines, grouped by when it is due, so the day's
// follow-ups are on one page instead of one board at a time.

export type AgendaBucketKey = "overdue" | "today" | "tomorrow" | "week" | "later" | "none";

export interface AgendaItem {
  caseId: string;
  pipelineId: string;
  pipelineName: string;
  title: string;
  stageName: string;
  owner: string;
  value: string;
  date: string | null;
  subject: string;
  fields: Record<string, unknown>;
}

export interface AgendaBucket {
  key: AgendaBucketKey;
  label: string;
  items: AgendaItem[];
}

const BUCKET_LABELS: Record<AgendaBucketKey, string> = {
  overdue: "Late",
  today: "Today",
  tomorrow: "Tomorrow",
  week: "Next 7 days",
  later: "Later",
  none: "No next step booked",
};

function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Open deals grouped by when their next step is due; won, lost and closed-stage deals are left out. */
export function buildDealAgenda(
  pipelines: ReadonlyArray<{ id: string; name: string; rows: readonly PipelineCaseChildRow[] }>,
  now: Date = new Date(),
): AgendaBucket[] {
  const today = localDay(now);
  const tomorrow = localDay(addDays(now, 1));
  const weekEnd = localDay(addDays(now, 7));
  const groups = new Map<AgendaBucketKey, AgendaItem[]>();
  for (const pipeline of pipelines) {
    for (const row of pipeline.rows) {
      const fields = row.case.fields;
      if (!fields || !("dealStatus" in fields) || row.case.terminalKind) continue;
      if (row.stage.kind === "done" || row.stage.kind === "cancelled") continue;
      const deal = readDevtoolsDeal(fields);
      const status = deal.status?.toLowerCase();
      if (status && status !== "open") continue;
      const date = deal.nextActivity && /^\d{4}-\d{2}-\d{2}/.test(deal.nextActivity) ? deal.nextActivity.slice(0, 10) : null;
      const key: AgendaBucketKey = !date
        ? "none"
        : date < today ? "overdue"
          : date === today ? "today"
            : date === tomorrow ? "tomorrow"
              : date <= weekEnd ? "week"
                : "later";
      const subject = typeof fields.nextActivitySubject === "string" ? fields.nextActivitySubject.trim() : "";
      const item: AgendaItem = {
        caseId: row.case.id,
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        title: row.case.title,
        stageName: row.stage.name,
        owner: deal.owner ?? "",
        value: formatDealTotals(sumDealValues([row.case])),
        date,
        subject: date ? subject : "",
        fields,
      };
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
  }
  return (Object.keys(BUCKET_LABELS) as AgendaBucketKey[])
    .filter((key) => groups.has(key))
    .map((key) => ({
      key,
      label: BUCKET_LABELS[key],
      items: [...groups.get(key)!].sort((left, right) =>
        (left.date ?? "").localeCompare(right.date ?? "") || left.title.localeCompare(right.title)),
    }));
}

const ALL = "__all";

function AgendaDoneForm({ item, onClose }: { item: AgendaItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [note, setNote] = useState("");
  const [nextActivityDate, setNextActivityDate] = useState("");
  const [nextActivitySubject, setNextActivitySubject] = useState("");
  const save = useMutation({
    mutationFn: () =>
      pipelinesApi.updateCase(item.caseId, { fields: completeNextStep(item.fields, { note, nextActivityDate, nextActivitySubject }) }),
    onSuccess: async () => {
      onClose();
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(item.pipelineId) });
      pushToast({ title: nextActivityDate ? `Done on ${item.title}, and the follow-up is booked` : `Next step done on ${item.title}`, tone: "success" });
    },
    onError: (error) => pushToast({ title: error instanceof Error ? error.message : "Could not save", tone: "error" }),
  });
  return (
    <form
      className="mt-1 flex w-full flex-wrap items-center gap-2"
      aria-label={`Mark ${item.title} done`}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="What happened?" aria-label="What happened?" className="h-9 min-w-0 flex-1" />
      <Input type="date" value={nextActivityDate} onChange={(event) => setNextActivityDate(event.target.value)} aria-label="Follow-up on" className="h-9 w-auto" />
      <Input value={nextActivitySubject} onChange={(event) => setNextActivitySubject(event.target.value)} placeholder="Follow-up" aria-label="Follow-up" className="h-9 w-(--sz-180px)" />
      <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
    </form>
  );
}

function AgendaRow({ item }: { item: AgendaItem }) {
  const [marking, setMarking] = useState(false);
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5" data-testid="agenda-item">
      <span className="min-w-0 flex-1">
        <Link to={`/pipelines/${item.pipelineId}/items/${item.caseId}`} className="font-medium text-foreground hover:underline">
          {item.title}
        </Link>
        {item.subject ? <span className="text-muted-foreground"> · {item.subject}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
        {[item.date ? formatCalendarDay(item.date) : "", item.owner, item.value, `${item.pipelineName} / ${item.stageName}`]
          .filter(Boolean)
          .join(" · ")}
        {item.date && !marking ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setMarking(true)} aria-label={`Mark ${item.title} done`}>
            Done
          </Button>
        ) : null}
      </span>
      {marking ? <AgendaDoneForm item={item} onClose={() => setMarking(false)} /> : null}
    </li>
  );
}

/** The agenda on the Pipelines page; shows nothing when the company has no DevTools deal pipeline. */
export function DealAgenda({ pipelines }: { pipelines: readonly PipelineListItem[] }) {
  const dealPipelines = useMemo(
    () => pipelines.filter((pipeline) => !pipeline.archivedAt && isDevtoolsCaseType(pipeline.key) && pipeline.key !== "pipedrive-leads"),
    [pipelines],
  );
  const caseQueries = useQueries({
    queries: dealPipelines.map((pipeline) => ({
      queryKey: queryKeys.pipelines.cases(pipeline.id),
      queryFn: () => pipelinesApi.listCases(pipeline.id),
    })),
  });
  const [owner, setOwner] = useState(ALL);
  const loaded = caseQueries.length > 0 && caseQueries.every((query) => query.data);
  const failed = caseQueries.some((query) => query.error);
  const buckets = loaded
    ? buildDealAgenda(dealPipelines.map((pipeline, index) => ({ id: pipeline.id, name: pipeline.name, rows: caseQueries[index]!.data ?? [] })))
    : [];

  if (dealPipelines.length === 0) return null;
  if (failed) return <p className="mb-4 text-sm text-destructive">Could not load the deal next steps.</p>;
  if (!loaded || buckets.length === 0) return null;

  const owners = [...new Set(buckets.flatMap((bucket) => bucket.items.map((item) => item.owner)).filter(Boolean))].sort();
  const shown = buckets
    .map((bucket) => ({ ...bucket, items: owner === ALL ? bucket.items : bucket.items.filter((item) => item.owner === owner) }))
    .filter((bucket) => bucket.items.length > 0);
  const dueNow = shown.filter((bucket) => bucket.key === "overdue" || bucket.key === "today").reduce((sum, bucket) => sum + bucket.items.length, 0);

  return (
    <section aria-label="Deal next steps" className="mb-6 space-y-2 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-foreground">Deal next steps</h2>
          <p className="text-xs text-muted-foreground" data-testid="agenda-summary">
            {dueNow > 0 ? `${dueNow} due today or late` : "Nothing due today"} across the Pipedrive deals
          </p>
        </div>
        {owners.length > 1 ? (
          <NativeSelect
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            aria-label="Show next steps for"
            className="w-(--sz-180px)"
          >
            <option value={ALL}>Every owner</option>
            {owners.map((name) => <option key={name} value={name}>{name}</option>)}
          </NativeSelect>
        ) : null}
      </div>
      {shown.map((bucket) => (
        <details
          key={bucket.key}
          open={bucket.key === "overdue" || bucket.key === "today" || bucket.key === "tomorrow"}
          className="border-t border-border/60 pt-2 text-sm"
          data-testid={`agenda-${bucket.key}`}
        >
          <summary className={cn("cursor-pointer font-medium", bucket.key === "overdue" ? "text-status-danger" : "text-muted-foreground hover:text-foreground")}>
            {bucket.label} ({bucket.items.length})
          </summary>
          <ul className="divide-y divide-border/60">
            {bucket.items.map((item) => <AgendaRow key={item.caseId} item={item} />)}
          </ul>
        </details>
      ))}
    </section>
  );
}
