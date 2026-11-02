import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AGENT_ROLE_LABELS, type AgentRole, type UsageBreakdown, type UsageBreakdownRow, type UsageWorkKind } from "@greatstone/shared";
import { Download } from "lucide-react";
import { costsApi } from "../api/costs";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { downloadBytes, localToday, sheetsToXlsx, type Sheet } from "../lib/spreadsheet-export";
import { formatTokens } from "../lib/utils";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const WORK_LABELS: Record<UsageWorkKind, string> = {
  doing: "Doing the task",
  reviewing: "Reviewing others' work",
  coordinating: "Helping on others' tasks",
  routine: "Scheduled routines",
  housekeeping: "Check-ins with no task",
};

const WORK_HINTS: Record<UsageWorkKind, string> = {
  doing: "Runs by the agent the task is assigned to.",
  reviewing: "Runs by an agent named in the task's review stages.",
  coordinating: "Comments, hand-offs and unblocking on tasks assigned to someone else.",
  routine: "Recurring jobs such as digests and goal check-ins.",
  housekeeping: "Wake-ups that never touched a task.",
};

// Four roles get their own colour in the trend; the rest share "Other".
const TREND_COLOURS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];
const OTHER_COLOUR = "var(--muted-foreground)";

export const roleLabel = (role: string) => AGENT_ROLE_LABELS[role as AgentRole] ?? role;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const turnaroundText = (value: number | null) =>
  value == null ? "No tasks" : value < 1 ? `${Math.round(value * 60)} min` : `${value.toFixed(1)} h`;

export function usageBreakdownSheets(data: UsageBreakdown): Sheet[] {
  const table = (name: string, label: (key: string) => string, rows: UsageBreakdownRow[]): Sheet => ({
    name,
    headers: ["Group", "Share of usage (%)", "Usage value at API prices ($)", "Output tokens", "Runs", "Agent hours"],
    rows: rows.map((row) => [
      label(row.key),
      pct(row.apiEquivalentCents, data.total.apiEquivalentCents),
      Math.round(row.apiEquivalentCents) / 100,
      row.outputTokens,
      row.runCount,
      Math.round(row.runtimeMs / 360_000) / 10,
    ]),
  });
  return [
    table("By role", roleLabel, data.byRole),
    table("By kind of work", (key) => WORK_LABELS[key as UsageWorkKind] ?? key, data.byWork),
  ];
}

function ShareRows({ rows, total, label, hint }: {
  rows: UsageBreakdownRow[];
  total: number;
  label: (key: string) => string;
  hint?: (key: string) => string | undefined;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No usage in this range.</p>;
  return (
    <ul className="space-y-3">
      {rows.map((row) => {
        const share = pct(row.apiEquivalentCents, total);
        return (
          <li key={row.key} title={hint?.(row.key)}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium">{label(row.key)}</span>
              <span className="font-semibold tabular-nums">{share}%</span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted" role="presentation">
              <div className="h-full rounded-full bg-chart-2" style={{ width: `${share}%` }} />
            </div>
            <div className="mt-1 text-xs text-muted-foreground tabular-nums">
              {count(row.runCount, "run")} · {hours(row.runtimeMs)} · {formatTokens(row.outputTokens)} output tokens
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RoleTrend({ data }: { data: UsageBreakdown }) {
  const { days, colourOf, legend } = useMemo(() => {
    const top = data.byRole.slice(0, TREND_COLOURS.length).map((row) => row.key);
    const colourOf = (role: string) => {
      const i = top.indexOf(role);
      return i >= 0 ? TREND_COLOURS[i] : OTHER_COLOUR;
    };
    const byDay = new Map<string, Map<string, number>>();
    for (const row of data.daily) {
      const key = top.includes(row.key) ? row.key : "other";
      const day = byDay.get(row.day) ?? new Map<string, number>();
      day.set(key, (day.get(key) ?? 0) + row.apiEquivalentCents);
      byDay.set(row.day, day);
    }
    const days = [...byDay.entries()].map(([day, parts]) => {
      const sum = [...parts.values()].reduce((a, b) => a + b, 0);
      return { day, sum, parts: [...top, "other"].map((key) => ({ key, share: pct(parts.get(key) ?? 0, sum) })) };
    });
    const legend = [...top, ...(data.byRole.length > top.length ? ["other"] : [])];
    return { days, colourOf, legend };
  }, [data]);

  if (days.length === 0) return null;
  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Share by role, day by day</CardTitle>
        <CardDescription>Each bar is one day of usage. Watch the checking share after workflow changes.</CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-2">
        <div className="flex h-40 items-stretch gap-1" aria-label="Daily share of usage by role">
          {days.map((day) => (
            <div key={day.day} className="flex min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-sm" title={day.day}>
              {day.parts.map((part) =>
                part.share > 0 ? (
                  <div
                    key={part.key}
                    style={{ height: `${part.share}%`, background: part.key === "other" ? OTHER_COLOUR : colourOf(part.key) }}
                    title={`${day.day}: ${part.key === "other" ? "Other" : roleLabel(part.key)} ${part.share}%`}
                  />
                ) : null,
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{days[0].day}</span>
          <span>{days[days.length - 1].day}</span>
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {legend.map((key) => (
            <li key={key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: key === "other" ? OTHER_COLOUR : colourOf(key) }} />
              {key === "other" ? "Other roles" : roleLabel(key)}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function UsageBreakdownCard({ companyId, companyPrefix, from, to }: {
  companyId: string;
  companyPrefix?: string | null;
  from?: string;
  to?: string;
}) {
  const [projectId, setProjectId] = useState<string>("");
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: queryKeys.usageBreakdown(companyId, from, to, projectId || null),
    queryFn: () => costsApi.usageBreakdown(companyId, from, to, projectId || null),
    // Live: agents keep spending while the page is open.
    refetchInterval: 60_000,
  });

  if (error) return <ErrorState error={error} title="We could not load where usage went" onRetry={() => void refetch()} />;

  const total = data?.total.apiEquivalentCents ?? 0;
  const reviewing = data?.byWork.find((row) => row.key === "reviewing");
  const projectName = projects?.find((p) => p.id === projectId)?.name;
  const { withAgentReview, withoutAgentReview } = data?.turnaround ?? {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Show usage for
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">The whole company</option>
            {projects?.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={!data}
          title="Download the role and work split for this range, ready to share with a client"
          onClick={() => {
            if (!data) return;
            const slug = [companyPrefix, projectName, "usage"].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-");
            downloadBytes(`${slug}-${(from ?? "all-time").slice(0, 10)}-to-${(to ?? localToday()).slice(0, 10)}.xlsx`, sheetsToXlsx(usageBreakdownSheets(data)));
          }}
        >
          <Download className="size-3.5" />
          Download report
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-4">
          <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">Spent reviewing others' work</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{isLoading ? "…" : `${pct(reviewing?.apiEquivalentCents ?? 0, total)}%`}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{count(reviewing?.runCount ?? 0, "review run")} in this range</div>
        </Card>
        <Card className="p-4">
          <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">Task turnaround, with agent review</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{isLoading ? "…" : turnaroundText(withAgentReview?.medianHours ?? null)}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">Median start to done, {count(withAgentReview?.count ?? 0, "task")}</div>
        </Card>
        <Card className="p-4">
          <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">Task turnaround, without</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{isLoading ? "…" : turnaroundText(withoutAgentReview?.medianHours ?? null)}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">Median start to done, {count(withoutAgentReview?.count ?? 0, "task")}</div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle className="text-base">By role</CardTitle>
            <CardDescription>Share of usage, valued at API prices so Claude and ChatGPT compare fairly.</CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-2">
            {data ? <ShareRows rows={data.byRole} total={total} label={roleLabel} /> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle className="text-base">By kind of work</CardTitle>
            <CardDescription>What the runs were for, judged from the task each one worked on.</CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-2">
            {data ? (
              <ShareRows
                rows={data.byWork}
                total={total}
                label={(key) => WORK_LABELS[key as UsageWorkKind] ?? key}
                hint={(key) => WORK_HINTS[key as UsageWorkKind]}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>

      {data ? <RoleTrend data={data} /> : null}
    </div>
  );
}
