import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { TeamScorecardAgent } from "@greatstone/shared";
import { AlertTriangle, Check, CircleCheck, Clock, ClipboardCopy, Download, Eye, Loader, MessageCircleQuestion, Trophy } from "lucide-react";
import { teamScorecardApi } from "../api/teamScorecard";
import { costsApi } from "../api/costs";
import { issuesApi } from "../api/issues";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { deriveInitials } from "../components/Identity";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";
import {
  STUCK_TASK_UPDATE_REQUEST,
  scorecardCsvFileName,
  scorecardSentence,
  scorecardToCsv,
  scorecardUpdateText,
  workValueLabel,
  finishedTrend,
} from "../lib/team-scorecard";
import { downloadTextFile } from "../lib/issues-csv";
import { localToday } from "../lib/calendar";
import { copyTextToClipboard } from "../lib/clipboard";
import { Button } from "@/components/ui/button";
import { Link, useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";

const PERIODS = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
] as const;

function Stat({
  icon: Icon,
  value,
  label,
  tone,
  note,
}: {
  icon: typeof CircleCheck;
  value: number;
  label: string;
  tone?: "danger" | "success";
  note?: string | null;
}) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={cn("size-3.5", tone === "danger" && value > 0 && "text-status-danger", tone === "success" && "text-status-success")} aria-hidden />
        {label}
      </div>
      <div className={cn("text-2xl font-semibold tabular-nums", tone === "danger" && value > 0 && "text-status-danger")}>{value}</div>
      {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}
    </div>
  );
}

interface AskedTasks {
  asked: ReadonlySet<string>;
  markAsked: (taskId: string) => void;
}

function TaskLinks({
  title,
  tasks,
  askForUpdate,
}: {
  title: string;
  tasks: TeamScorecardAgent["recentlyFinished"];
  askForUpdate?: AskedTasks;
}) {
  if (tasks.length === 0) return null;
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <ul className="space-y-0.5">
        {tasks.map((task) => (
          <li key={task.id} className="flex min-w-0 items-center gap-2 text-sm">
            <Link to={`/issues/${task.identifier ?? task.id}`} className="min-w-0 truncate hover:underline">
              {task.identifier ? <span className="mr-1.5 text-muted-foreground">{task.identifier}</span> : null}
              {task.title}
            </Link>
            {askForUpdate ? (
              <AskForUpdateButton
                taskId={task.id}
                asked={askForUpdate.asked.has(task.id)}
                onAsked={() => askForUpdate.markAsked(task.id)}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One click to ask the agent on a stuck task what is blocking it. The comment
 * wakes the agent, and its answer lands on the task.
 */
function askForUpdate(taskId: string) {
  return issuesApi.addComment(taskId, STUCK_TASK_UPDATE_REQUEST, undefined, undefined, undefined, crypto.randomUUID());
}

function AskForUpdateButton({ taskId, asked, onAsked }: { taskId: string; asked: boolean; onAsked: () => void }) {
  const ask = useMutation({ mutationFn: () => askForUpdate(taskId), onSuccess: onAsked });
  if (asked) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Check className="size-3" aria-hidden />
        Asked
      </span>
    );
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 shrink-0 px-2 text-xs"
      disabled={ask.isPending}
      title="Ask the agent what is blocking this task and what it needs from you"
      onClick={() => ask.mutate()}
    >
      <MessageCircleQuestion className="size-3" aria-hidden />
      {ask.isError ? "Try again" : "Ask for an update"}
    </Button>
  );
}

function AgentCard({
  agent,
  days,
  workCents,
  askedTasks,
  trend,
}: {
  agent: TeamScorecardAgent;
  days: number;
  workCents: number | null;
  askedTasks: AskedTasks;
  /** Finished tasks compared with the period before, such as "Up from 2 the week before". */
  trend?: string | null;
}) {
  return (
    <li className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <Avatar size="lg" aria-hidden="true">
          <AvatarFallback>{deriveInitials(agent.name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <Link to={`/agents/${agent.agentId}`} className="font-semibold hover:underline">
              {agent.name}
            </Link>
            {workCents != null && workCents > 0 ? (
              <span className="text-xs tabular-nums text-muted-foreground" title="What this agent's work would cost on the API">
                {workValueLabel(workCents)} of work
              </span>
            ) : null}
          </div>
          {agent.title ? <div className="text-xs text-muted-foreground">{agent.title}</div> : null}
          <p className="mt-1 text-sm">{scorecardSentence(agent, days)}</p>
          {trend ? (
            <p className="text-xs text-muted-foreground">{`Finished tasks: ${trend.charAt(0).toLowerCase()}${trend.slice(1)}.`}</p>
          ) : null}
        </div>
      </div>
      {agent.recentlyFinished.length > 0 || agent.stuckTasks.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <TaskLinks title="Recently finished" tasks={agent.recentlyFinished} />
          <TaskLinks title="Stuck, needs a look" tasks={agent.stuckTasks} askForUpdate={askedTasks} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Team scorecard: each agent's recent work in plain words, the stuck ones
 * first, so an owner can see who is delivering and who needs help.
 */
export function TeamScorecard() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [asked, setAsked] = useState<ReadonlySet<string>>(() => new Set());
  const askedTasks = useMemo<AskedTasks>(
    () => ({ asked, markAsked: (taskId) => setAsked((current) => new Set(current).add(taskId)) }),
    [asked],
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const days = searchParams.get("days") === "30" ? 30 : 7;

  useEffect(() => {
    setBreadcrumbs([{ label: "Scorecard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.teamScorecard(selectedCompanyId ?? "", days),
    queryFn: () => teamScorecardApi.get(selectedCompanyId!, days as 7 | 30),
    enabled: !!selectedCompanyId,
  });

  // Twice the period, to say how this period compares with the one before.
  const { data: twice } = useQuery({
    queryKey: queryKeys.teamScorecard(selectedCompanyId ?? "", days * 2),
    queryFn: () => teamScorecardApi.get(selectedCompanyId!, (days * 2) as 14 | 60),
    enabled: !!selectedCompanyId,
    retry: false,
  });

  // Work value is a nice-to-have: people without cost access simply do not see it.
  const from = data?.since;
  const { data: value } = useQuery({
    queryKey: queryKeys.apiEquivalent(selectedCompanyId ?? "", from),
    queryFn: () => costsApi.apiEquivalent(selectedCompanyId!, from),
    enabled: !!selectedCompanyId && !!from,
    retry: false,
  });
  const valueByAgent = useMemo(
    () => new Map((value?.byAgent ?? []).map((row) => [row.agentId, row.apiEquivalentCents])),
    [value],
  );

  const stuckToAsk = (data?.agents ?? []).flatMap((agent) => agent.stuckTasks).filter((task) => !asked.has(task.id));
  const askAll = useMutation({
    mutationFn: async (taskIds: string[]) => {
      const results = await Promise.allSettled(taskIds.map((taskId) => askForUpdate(taskId)));
      const done = taskIds.filter((_, index) => results[index]!.status === "fulfilled");
      setAsked((current) => new Set([...current, ...done]));
      if (done.length < taskIds.length) throw new Error("Some requests did not send");
    },
  });

  function downloadSpreadsheet() {
    if (!data) return;
    const csv = scorecardToCsv(data, (agentId) => valueByAgent.get(agentId));
    downloadTextFile(scorecardCsvFileName(selectedCompany?.issuePrefix, data.days, localToday()), csv);
  }

  async function copyUpdate() {
    if (!data) return;
    try {
      await copyTextToClipboard(scorecardUpdateText(data, selectedCompany?.name));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 2500);
  }

  if (!selectedCompanyId) return <EmptyState icon={Trophy} message="Select an organisation to see its scorecard." />;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Scorecard</h1>
          <p className="text-sm text-muted-foreground">
            What each agent finished, and what they are working on now. Agents with stuck work come first.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {stuckToAsk.length > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={askAll.isPending}
              title="Ask the agent on each stuck task what is blocking it and what it needs from you"
              onClick={() => askAll.mutate(stuckToAsk.map((task) => task.id))}
            >
              <MessageCircleQuestion className="size-4" aria-hidden />
              {askAll.isError ? "Try again" : `Ask about all ${stuckToAsk.length} stuck tasks`}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={!data || data.agents.length === 0}
            title="Download each agent's numbers as a spreadsheet"
            onClick={downloadSpreadsheet}
          >
            <Download className="size-4" />
            <span className="hidden sm:inline">Download as spreadsheet</span>
            <span className="sr-only sm:hidden">Download as spreadsheet</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!data || data.agents.length === 0}
            title="Copy a short written update to paste into an email or chat"
            onClick={() => void copyUpdate()}
          >
            {copyState === "copied" ? <Check className="size-4" /> : <ClipboardCopy className="size-4" />}
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Could not copy" : "Copy as an update"}
          </Button>
          <div className="inline-flex rounded-md border border-border bg-card p-0.5" role="group" aria-label="Period">
            {PERIODS.map((period) => (
              <button
                key={period.days}
                type="button"
                aria-pressed={days === period.days}
                onClick={() => setSearchParams(period.days === 7 ? {} : { days: String(period.days) }, { replace: true })}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                  days === period.days ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {period.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat
              icon={CircleCheck}
              value={data.totals.finished}
              label="Finished"
              tone="success"
              note={finishedTrend(data.totals.finished, twice?.totals.finished, data.days)}
            />
            <Stat icon={Loader} value={data.totals.underWay} label="Under way" />
            <Stat icon={Eye} value={data.totals.inReview} label="Waiting for review" />
            <Stat icon={AlertTriangle} value={data.totals.stuck} label="Stuck" tone="danger" />
            <Stat icon={Clock} value={data.totals.overdue} label="Past due date" tone="danger" />
          </div>
          {data.agents.length === 0 ? (
            <EmptyState icon={Trophy} message="No agents yet. Hire one from the Agents page and their work shows here." />
          ) : (
            <ul className="space-y-3">
              {data.agents.map((agent) => (
                <AgentCard
                  key={agent.agentId}
                  agent={agent}
                  days={data.days}
                  workCents={valueByAgent.get(agent.agentId) ?? null}
                  askedTasks={askedTasks}
                  trend={
                    twice
                      ? finishedTrend(
                          agent.finished,
                          twice.agents.find((row) => row.agentId === agent.agentId)?.finished ?? agent.finished,
                          data.days,
                        )
                      : null
                  }
                />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
