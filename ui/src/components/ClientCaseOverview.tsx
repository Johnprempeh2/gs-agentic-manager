import { useEffect, useRef, type ReactNode } from "react";
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
  readDevtoolsDeal,
  type DevtoolsDeal,
} from "../lib/client-case";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { cn, formatDate, formatNumber } from "../lib/utils";
import { PipelineCaseContacts } from "./PipelineCaseContacts";
import { PipelineCaseCrmSync } from "./PipelineCaseCrmSync";
import { PipelineCaseCrmHistory } from "./PipelineCaseCrmHistory";
import { ClientJourneyOverview } from "./ClientJourneyOverview";
import { ClientJourneyStages, ClientPortalPreview } from "./ClientJourneyStages";
import { PipelineCaseEvidence } from "./PipelineCaseFiles";
import { StatusBadge } from "./StatusBadge";
import { DevtoolsDealOutcome } from "./DevtoolsDealOutcome";

const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);

function OverviewSection({ title, tour, children }: { title: string; tour?: string; children: ReactNode }) {
  return (
    <section data-tour={tour}>
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
  return formatDate(date);
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
  const currentIndex = steps.findIndex((step) => step.state === "current");
  const stripRef = useRef<HTMLOListElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);

  // On a phone the strip scrolls sideways; bring the current stage into view
  // without moving the page.
  useEffect(() => {
    const strip = stripRef.current;
    const current = currentRef.current;
    if (!strip || !current || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = Math.max(0, current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2);
  }, [currentIndex, steps.length]);

  return (
    <div className="space-y-2" data-tour="client-journey">
      <ol
        ref={stripRef}
        aria-label="Client journey"
        className="relative flex gap-1 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible"
      >
        {steps.map((step, index) => (
          <li
            key={step.id}
            ref={step.state === "current" ? currentRef : undefined}
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
        {currentIndex >= 0 ? (
          <span className="mr-2 font-medium text-foreground">
            Stage {currentIndex + 1} of {steps.length}
          </span>
        ) : null}
        {sideStage ? (
          <span className="mr-2 rounded-sm border border-status-warning/40 bg-status-warning-soft px-1.5 py-0.5 font-medium text-status-warning-foreground">
            {sideStage.name}
          </span>
        ) : null}
        {daysLabel}
      </p>
    </div>
  );
}

function RecordRow({ label, tour, children }: { label: string; tour?: string; children: ReactNode }) {
  return (
    <div data-tour={tour} className="grid grid-cols-(--gtc-47) gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function NotSet() {
  return <span className="text-muted-foreground">Not set</span>;
}

/** The deal behind a DevTools client, as Pipedrive held it. */
function DealRecord({ deal }: { deal: DevtoolsDeal }) {
  const value = deal.value != null ? `${formatNumber(deal.value, { maximumFractionDigits: 2 })}${deal.currency ? ` ${deal.currency}` : ""}` : null;
  return (
    <dl className="divide-y divide-border" aria-label="Deal">
      <RecordRow label="Status">
        {deal.status ?? <NotSet />}
        {deal.closedOn ? <span className="block text-xs text-muted-foreground">on {formatDay(deal.closedOn)}</span> : null}
      </RecordRow>
      <RecordRow label="Value">{value ?? <NotSet />}</RecordRow>
      <RecordRow label="Owner">{deal.owner ?? <NotSet />}</RecordRow>
      <RecordRow label="Expected close">
        {deal.expectedClose ? formatDay(deal.expectedClose) : <NotSet />}
        {deal.probability != null ? <span className="block text-xs text-muted-foreground">{deal.probability}% likely</span> : null}
      </RecordRow>
      <RecordRow label="Next activity">{deal.nextActivity ? formatDay(deal.nextActivity) : <NotSet />}</RecordRow>
      <RecordRow label="Last activity">{deal.lastActivity ? formatDay(deal.lastActivity) : <NotSet />}</RecordRow>
      {deal.lostReason ? <RecordRow label="Lost reason">{deal.lostReason}</RecordRow> : null}
    </dl>
  );
}

/**
 * One page for a client (GRE-1048): where the client is in the journey, who
 * owns it, what happens next, who to call, the client's files (GRE-1311), our
 * deliverables by journey stage and what the client sees on its portal
 * (GRE-1473), and the open work.
 */
export function ClientCaseOverview({
  detail,
  stages,
  events,
  issueLinks,
  projects,
  journey = "dx",
}: {
  detail: PipelineCaseDetail;
  stages: PipelineStage[];
  events: PipelineCaseEvent[];
  issueLinks: PipelineCaseIssueLinkWithIssue[];
  /** Linked projects, shown here below `lg` so they sit with the CRM overview on a phone. */
  projects?: ReactNode;
  /**
   * "dx" is the DX client journey this platform runs. "devtools" is a client
   * imported from a Pipedrive pipeline: the deal, its people and its history,
   * without the NDA, engagement pack, deliverables or portal.
   */
  journey?: "dx" | "devtools";
}) {
  const devtools = journey === "devtools";
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

      {devtools ? (
        <OverviewSection title="Deal">
          <DealRecord deal={readDevtoolsDeal(detail.case.fields)} />
          <DevtoolsDealOutcome detail={detail} stages={stages} />
        </OverviewSection>
      ) : (
      <OverviewSection title="Where things stand" tour="client-status">
        <ClientJourneyOverview
          caseId={detail.case.id}
          ownerName={record.owner}
          companyId={detail.case.companyId ?? null}
          clientName={detail.case.title}
          stageEnteredAt={detail.stageEnteredAt}
          nextAction={record.nextAction}
        />
      </OverviewSection>
      )}

      {devtools ? null : (
      <OverviewSection title="Client record">
        <dl className="divide-y divide-border">
          <RecordRow label="Country">{record.country ?? <span className="text-muted-foreground">Not set</span>}</RecordRow>
          <RecordRow label="Owner">
            {record.owner ?? <span className="text-muted-foreground">Not set</span>}
            {record.leadAgent ? <span className="block text-xs text-muted-foreground">Lead agent: {record.leadAgent}</span> : null}
          </RecordRow>
          <RecordRow label="Next action" tour="client-next-action">
            {record.nextAction ?? <span className="text-muted-foreground">Not set</span>}
            {nextActionMeta ? <span className="block text-xs text-muted-foreground">{nextActionMeta}</span> : null}
          </RecordRow>
          <RecordRow label="Last contact" tour="client-last-contact">
            {record.lastContact ? formatDay(record.lastContact) : <span className="text-muted-foreground">Not set</span>}
            {record.lastContactNote ? <span className="block text-xs text-muted-foreground">{record.lastContactNote}</span> : null}
          </RecordRow>
        </dl>
      </OverviewSection>
      )}

      <PipelineCaseCrmSync
        caseId={detail.case.id}
        companyId={detail.case.companyId}
        wrap={(children) => <OverviewSection title="Sync with your CRM">{children}</OverviewSection>}
      />

      <OverviewSection title="Contacts" tour="client-contacts">
        <PipelineCaseContacts caseId={detail.case.id} recordFields={detail.case.fields} />
      </OverviewSection>

      <PipelineCaseCrmHistory
        caseId={detail.case.id}
        wrap={(title, children) => <OverviewSection title={title}>{children}</OverviewSection>}
      />

      {devtools ? null : (
        <>
      <OverviewSection title="Evidence" tour="client-evidence">
        <PipelineCaseEvidence caseId={detail.case.id} organisationId={detail.case.organisationId} />
      </OverviewSection>

      <OverviewSection title="Journey by stage" tour="client-deliverables">
        <ClientJourneyStages caseId={detail.case.id} organisationId={detail.case.organisationId} />
      </OverviewSection>

      <OverviewSection title="What the client sees on the portal" tour="client-portal">
        <ClientPortalPreview caseId={detail.case.id} />
      </OverviewSection>
        </>
      )}

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

      {projects ? (
        <div className="lg:hidden" data-tour="client-projects">
          <OverviewSection title="Projects">{projects}</OverviewSection>
        </div>
      ) : null}

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
