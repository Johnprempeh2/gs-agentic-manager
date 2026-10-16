import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WeeklyReport as WeeklyReportData, WeeklyReportTask } from "@greatstone/shared";
import { AlertTriangle, CalendarDays, Check, CircleCheck, ClipboardCopy, Coins, Download, GitBranch, Hand, Newspaper, Sparkles } from "lucide-react";
import { agentDailyDigestsApi } from "../api/agentDailyDigests";
import { weeklyReportApi } from "../api/weeklyReport";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { EmptyState } from "../components/EmptyState";
import { WeeklyMemorySection } from "../components/memory/WeeklyMemorySection";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  dailyDigestAgentLine,
  dailyDigestLine,
  moveLabel,
  pipelineSummary,
  stuckForLabel,
  weekRangeLabel,
  weeklyHeadline,
  weeklyReportFileName,
  weeklyReportPdf,
  weeklyReportSections,
} from "../lib/weekly-report";
import { downloadTextFile } from "../lib/issues-csv";
import { setFirstWeekMark } from "../lib/first-week";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { formatCents } from "../lib/utils";
import { openAskEverest } from "../lib/ask-everest-events";
import type { AskContext } from "../lib/ask-everest";

/** The report as plain text, to paste into an email or chat. */
export function weeklyReportText(report: WeeklyReportData): string {
  const title = `This week at ${report.companyName || "the company"} (${weekRangeLabel(report)})`;
  const body = weeklyReportSections(report).map((section) =>
    [section.title, ...section.lines.map((line) => (line.startsWith("  ") ? line : `- ${line}`))].join("\n"),
  );
  return [title, weeklyHeadline(report), ...body].join("\n\n");
}

/** What Everest is told when asked about this report. */
export function weeklyReportAskContext(report: WeeklyReportData): AskContext {
  return {
    label: `This week at ${report.companyName || "the company"}`,
    summary: weeklyReportText(report),
    suggestions: [
      "What should I focus on this week?",
      "Why are these tasks stuck?",
      "Which of the stuck tasks can I unblock?",
    ],
  };
}

function Section({
  icon: Icon,
  title,
  children,
  testId,
}: {
  icon: typeof CircleCheck;
  title: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4 print:break-inside-avoid" data-testid={testId} data-tour={testId}>
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Icon className="size-4 text-primary" aria-hidden />
        {title}
      </h2>
      {children}
    </section>
  );
}

function TaskLink({ task }: { task: WeeklyReportTask }) {
  return (
    <Link to={`/issues/${task.identifier ?? task.id}`} className="min-w-0 truncate hover:underline">
      {task.identifier ? <span className="mr-1.5 text-muted-foreground">{task.identifier}</span> : null}
      {task.title}
    </Link>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function More({ shown, total, to }: { shown: number; total: number; to: string }) {
  if (total <= shown) return null;
  return (
    <Link to={to} className="text-sm text-muted-foreground hover:text-foreground hover:underline print:no-underline">
      and {total - shown} more
    </Link>
  );
}

/** The nightly digests for the week, one line a day; open a day to see each agent. */
function DayByDay({ report }: { report: WeeklyReportData }) {
  const { selectedCompanyId } = useCompany();
  const days = report.daily ?? [];
  const from = days[0]?.date ?? "";
  const to = days[days.length - 1]?.date ?? "";
  const { data, error } = useQuery({
    queryKey: queryKeys.agentDailyDigests(selectedCompanyId ?? "", from, to),
    queryFn: () => agentDailyDigestsApi.list(selectedCompanyId!, { from, to }),
    enabled: !!selectedCompanyId && days.length > 0,
  });
  const byDate = new Map((data?.digests ?? []).map((digest) => [digest.date, digest]));
  const task = data?.digests.find((digest) => digest.deliveredIssueIdentifier)?.deliveredIssueIdentifier ?? null;

  return (
    <Section icon={CalendarDays} title="Day by day" testId="weekly-report-daily">
      {days.length === 0 ? (
        <Quiet>The first nightly digest is written just after midnight (UTC). Each day then shows here.</Quiet>
      ) : (
        <ul className="space-y-1 text-sm">
          {days.map((day) => {
            const agents = byDate.get(day.date)?.payload.agents ?? [];
            return (
              <li key={day.date}>
                {agents.length === 0 ? (
                  <span>{dailyDigestLine(day)}</span>
                ) : (
                  <details>
                    <summary className="cursor-pointer">{dailyDigestLine(day)}</summary>
                    <ul className="space-y-0.5 pl-4 pt-1 text-muted-foreground">
                      {agents.map((agent) => (
                        <li key={agent.agentId}>{dailyDigestAgentLine(agent)}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <p className="text-sm text-destructive">
          Some agents' parts of this report did not load. Refresh the page to try again.
        </p>
      ) : null}
      {task ? (
        <Quiet>
          Each digest also goes to the lead agent on{" "}
          <Link to={`/issues/${task}`} className="underline underline-offset-2 hover:text-foreground">
            {task}
          </Link>
          .
        </Quiet>
      ) : null}
    </Section>
  );
}

export function WeeklyReportView({ report }: { report: WeeklyReportData }) {
  return (
    <div className="space-y-4">
      <p className="text-base" data-testid="weekly-report-headline" data-tour="weekly-report-headline">
        {weeklyHeadline(report)}
      </p>

      <Section icon={Hand} title="Needs you" testId="weekly-report-needs-you">
        {report.needsYou.count === 0 ? (
          <Quiet>Nothing needs you right now.</Quiet>
        ) : (
          <ul className="space-y-1 text-sm">
            {report.needsYou.items.map((task) => (
              <li key={task.id} className="flex min-w-0">
                <TaskLink task={task} />
              </li>
            ))}
          </ul>
        )}
        <More shown={report.needsYou.items.length} total={report.needsYou.count} to="/decisions" />
      </Section>

      <Section icon={CircleCheck} title="What the agents finished" testId="weekly-report-finished">
        {report.finished.agents.length === 0 ? (
          <Quiet>No tasks were finished this week.</Quiet>
        ) : (
          <ul className="space-y-3">
            {report.finished.agents.map((agent) => (
              <li key={agent.agentId} className="space-y-1">
                <div className="text-sm">
                  <Link to={`/agents/${agent.agentId}`} className="font-medium hover:underline">
                    {agent.name}
                  </Link>
                  <span className="text-muted-foreground">
                    {" "}
                    finished {agent.finished} {agent.finished === 1 ? "task" : "tasks"}
                  </span>
                </div>
                <ul className="space-y-0.5 pl-4 text-sm">
                  {agent.items.map((task) => (
                    <li key={task.id} className="flex min-w-0">
                      <TaskLink task={task} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={AlertTriangle} title="What is stuck" testId="weekly-report-stuck">
        {report.stuck.count === 0 ? (
          <Quiet>Nothing is stuck.</Quiet>
        ) : (
          <ul className="space-y-1 text-sm">
            {report.stuck.items.map((task) => (
              <li key={task.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <TaskLink task={task} />
                <span className="shrink-0 text-xs text-muted-foreground">
                  {stuckForLabel(task.stuckSince, report.generatedAt)}
                  {task.agentName ? `, with ${task.agentName}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        <More shown={report.stuck.items.length} total={report.stuck.count} to="/inbox/blocked" />
      </Section>

      <Section icon={GitBranch} title="Client pipeline" testId="weekly-report-pipeline">
        <p className="text-sm">{pipelineSummary(report.pipeline)}</p>
        {report.pipeline.moves.length > 0 ? (
          <ul className="space-y-0.5 text-sm text-muted-foreground">
            {report.pipeline.moves.map((move) => (
              <li key={`${move.caseId}-${move.at}`}>{moveLabel(move)}</li>
            ))}
          </ul>
        ) : null}
      </Section>

      <WeeklyMemorySection companyId={report.companyId} since={report.since} />

      <Section icon={Coins} title="Cost by agent" testId="weekly-report-costs">
        {report.costs.agents.length === 0 ? (
          <Quiet>No spend was recorded this week.</Quiet>
        ) : (
          <ul className="space-y-0.5 text-sm">
            {report.costs.agents.map((agent) => (
              <li key={agent.agentId} className="flex justify-between gap-3">
                <span>{agent.name}</span>
                <span className="tabular-nums">{formatCents(agent.cents)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-3 border-t border-border pt-1 font-medium">
              <span>Total</span>
              <span className="tabular-nums">{formatCents(report.costs.totalCents)}</span>
            </li>
          </ul>
        )}
        <Quiet>
          Spend billed for the agents this week. Work on a subscription plan is not billed per task, so it adds little or nothing here.{" "}
          <Link to="/activity/costs" className="underline underline-offset-2 hover:text-foreground">
            See all costs
          </Link>
        </Quiet>
      </Section>

      <DayByDay report={report} />
    </div>
  );
}

/** "This week at Greatstone": a one-page weekly report for the executives. */
export function WeeklyReport() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    setBreadcrumbs([{ label: "This week" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.weeklyReport(selectedCompanyId ?? ""),
    queryFn: () => weeklyReportApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Opening the report ticks "Read This week" on the Home checklist.
  const reportLoaded = !!data;
  useEffect(() => {
    if (reportLoaded && selectedCompanyId) setFirstWeekMark(selectedCompanyId, "weekly-report");
  }, [reportLoaded, selectedCompanyId]);

  async function copyReport() {
    if (!data) return;
    try {
      await copyTextToClipboard(weeklyReportText(data));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 2500);
  }

  if (!selectedCompanyId) return <EmptyState icon={Newspaper} message="Select an organisation to see its weekly report." />;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">This week at {data?.companyName || "your company"}</h1>
          <p className="text-sm text-muted-foreground">
            {data ? `${weekRangeLabel(data)}. ` : ""}What the agents finished, what is stuck, how the pipeline moved, what GSAM learned and what needs you.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden" data-tour="weekly-report-share">
          <Button
            size="sm"
            variant="outline"
            disabled={!data}
            title="Ask Everest a question about this report"
            onClick={() => data && openAskEverest(undefined, weeklyReportAskContext(data))}
            data-testid="weekly-report-ask"
          >
            <Sparkles className="size-4" />
            Ask Everest about this
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!data}
            title="Save the report as a PDF to share or print"
            onClick={() => data && downloadTextFile(weeklyReportFileName(data), weeklyReportPdf(data), "application/pdf")}
            data-testid="weekly-report-pdf"
          >
            <Download className="size-4" />
            Download PDF
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!data}
            title="Copy the report to paste into an email or chat"
            onClick={() => void copyReport()}
            data-testid="weekly-report-copy"
          >
            {copyState === "copied" ? <Check className="size-4" /> : <ClipboardCopy className="size-4" />}
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Could not copy" : "Copy as text"}
          </Button>
        </div>
      </header>

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data ? (
        <WeeklyReportView report={data} />
      ) : null}
    </div>
  );
}
