import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Link } from "@/lib/router";
import type {
  PipelineCaseDetail,
  PipelineCaseEvent,
  PipelineCaseIssueLinkWithIssue,
  PipelineStage,
} from "../api/pipelines";
import {
  buildStageHistory,
  buildStageStrip,
  daysInStage,
  formatDaysInStage,
  readClientRecord,
} from "../lib/client-case";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { cn } from "../lib/utils";
import { PipelineCaseContacts } from "./PipelineCaseContacts";
import { StatusBadge } from "./StatusBadge";

const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);

function OverviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
        {title}
      </h2>
      <div className="border-y border-border">{children}</div>
    </section>
  );
}

function formatDay(value: Date | string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function StageStrip({
  stages,
  currentStageId,
  stageEnteredAt,
}: {
  stages: PipelineStage[];
  currentStageId: string | null;
  stageEnteredAt?: Date | string | null;
}) {
  const { steps, sideStage } = buildStageStrip(stages, currentStageId);
  const daysLabel = formatDaysInStage(daysInStage(stageEnteredAt));
  return (
    <div className="space-y-2">
      <ol aria-label="Client journey" className="flex gap-1 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible">
        {steps.map((step, index) => (
          <li
            key={step.id}
            aria-current={step.state === "current" ? "step" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-sm border px-2 py-1 text-xs",
              step.state === "current" && "border-primary bg-primary font-semibold text-primary-foreground",
              step.state === "done" && "border-border bg-muted/40 text-foreground",
              step.state === "next" && "border-dashed border-border text-muted-foreground",
            )}
          >
            {step.state === "done" ? <Check className="h-3 w-3" aria-hidden="true" /> : (
              <span className="tabular-nums opacity-70">{index + 1}</span>
            )}
            {step.name}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        {sideStage ? (
          <span className="mr-2 rounded-sm border border-amber-400/50 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-900/25 dark:text-amber-200">
            {sideStage.name}
          </span>
        ) : null}
        {daysLabel}
      </p>
    </div>
  );
}

function RecordRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-(--gtc-47) gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/**
 * One page for a client (GRE-1048): where the client is in the journey, who
 * owns it, what happens next, who to call, and the open work.
 */
export function ClientCaseOverview({
  detail,
  stages,
  events,
  issueLinks,
}: {
  detail: PipelineCaseDetail;
  stages: PipelineStage[];
  events: PipelineCaseEvent[];
  issueLinks: PipelineCaseIssueLinkWithIssue[];
}) {
  const record = readClientRecord(detail.case.fields);
  const history = buildStageHistory(events, stages);
  const openTasks = issueLinks
    .filter((row) => !CLOSED_ISSUE_STATUSES.has(row.issue.status))
    .filter((row, index, all) => all.findIndex((other) => other.issue.id === row.issue.id) === index);
  const nextActionMeta = [record.nextActionOwner, record.nextActionDate ? formatDay(record.nextActionDate) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-8">
      <StageStrip stages={stages} currentStageId={detail.case.stageId} stageEnteredAt={detail.stageEnteredAt} />

      <OverviewSection title="Client record">
        <dl className="divide-y divide-border">
          <RecordRow label="Country">{record.country ?? <span className="text-muted-foreground">Not set</span>}</RecordRow>
          <RecordRow label="Owner">
            {record.owner ?? <span className="text-muted-foreground">Not set</span>}
            {record.leadAgent ? <span className="block text-xs text-muted-foreground">Lead agent: {record.leadAgent}</span> : null}
          </RecordRow>
          <RecordRow label="Next action">
            {record.nextAction ?? <span className="text-muted-foreground">Not set</span>}
            {nextActionMeta ? <span className="block text-xs text-muted-foreground">{nextActionMeta}</span> : null}
          </RecordRow>
          <RecordRow label="Last contact">
            {record.lastContact ? formatDay(record.lastContact) : <span className="text-muted-foreground">Not set</span>}
            {record.lastContactNote ? <span className="block text-xs text-muted-foreground">{record.lastContactNote}</span> : null}
          </RecordRow>
        </dl>
      </OverviewSection>

      <OverviewSection title="Contacts">
        <PipelineCaseContacts caseId={detail.case.id} recordFields={detail.case.fields} />
      </OverviewSection>

      <OverviewSection title="Open tasks">
        {openTasks.length > 0 ? (
          <ul className="divide-y divide-border">
            {openTasks.map((row) => (
              <li key={row.issue.id} className="flex items-center gap-2 py-2 text-sm">
                <Link
                  to={createIssueDetailPath(row.issue.identifier ?? row.issue.id)}
                  className="min-w-0 flex-1 truncate text-foreground hover:underline"
                >
                  {row.issue.identifier ? <span className="mr-1.5 text-muted-foreground">{row.issue.identifier}</span> : null}
                  {row.issue.title}
                </Link>
                <StatusBadge status={row.issue.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-3 text-sm text-muted-foreground">No open tasks linked to this client.</p>
        )}
      </OverviewSection>

      <OverviewSection title="Stage history">
        {history.length > 0 ? (
          <ol className="divide-y divide-border">
            {history.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="text-foreground">
                  {entry.stageName}
                  {entry.forced ? <span className="ml-1.5 text-xs text-muted-foreground">(forced move)</span> : null}
                </span>
                <time className="shrink-0 text-xs text-muted-foreground">{formatDay(entry.at)}</time>
              </li>
            ))}
          </ol>
        ) : (
          <p className="py-3 text-sm text-muted-foreground">No stage moves yet.</p>
        )}
      </OverviewSection>
    </div>
  );
}
