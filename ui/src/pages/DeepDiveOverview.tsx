import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import {
  DEEP_DIVE_GIF,
  DEEP_DIVE_LABELS,
  DEEP_DIVE_SESSION_LABELS,
  DEEP_DIVE_STREAMS,
  type DeepDiveNextStep,
  type DeepDiveOverview as Overview,
  type DeepDiveStreamStatus,
} from "@greatstone/shared";
import { deepDiveOverviewApi, deepDiveOverviewQueryKeys } from "@/api/deepDiveOverview";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { StatusBadge } from "@/components/StatusBadge";

// Deep Dive overview (GRE-2372): Screen 1 of the GRE-2327 plan, from the
// Indago control centre and the website overview. Read only: everything here
// comes from the other Deep Dive screens, and each line links to the screen
// where the work is done.

/** Stream status rides the existing status palette. */
const STREAM_TONE: Record<DeepDiveStreamStatus, string> = {
  not_started: "backlog",
  under_way: "in_progress",
  examined: "done",
  blocked: "blocked",
};

const STREAM_LABEL = new Map<string, string>(DEEP_DIVE_STREAMS.map((s) => [s.key, s.label]));
const GIF_LABEL = new Map<string, string>(DEEP_DIVE_GIF.map((g) => [g.key, g.label]));

function formatWhen(iso: string | null): string {
  if (!iso) return "No date set";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function StepRow({ step, lead = false }: { step: DeepDiveNextStep; lead?: boolean }) {
  return (
    <li className={cn("rounded-md border px-3 py-2", lead ? "border-primary/50 bg-accent/40" : "border-border")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link to={step.href} className={cn("break-words font-medium underline-offset-4 hover:underline", lead ? "text-base" : "text-sm")}>
          {step.title}
        </Link>
        {step.needsPerson ? <span className="text-xs font-medium text-muted-foreground">Needs a person</span> : null}
      </div>
      {step.detail ? <p className="break-words text-xs text-muted-foreground">{step.detail}</p> : null}
    </li>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2 id={id} className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function NextSession({ overview }: { overview: Overview }) {
  const session = overview.nextSession;
  if (!session) {
    return (
      <p className="text-sm text-muted-foreground">
        No session is planned. <Link to="/deep-dive/sessions" className="underline">Plan a session</Link>.
      </p>
    );
  }
  return (
    <Card className="gap-1 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link to={`/deep-dive/sessions/${session.id}`} className="break-words text-sm font-medium underline-offset-4 hover:underline">
          {session.title}
        </Link>
        <StatusBadge status={session.status === "live" ? "running" : "planned"} label={DEEP_DIVE_SESSION_LABELS[session.status]} />
      </div>
      <p className="text-xs text-muted-foreground">
        {session.status === "live" ? `Started ${formatWhen(session.startedAt)}` : formatWhen(session.plannedFor)}
        {" · "}
        {session.answeredCount} of {session.questionCount} questions answered
      </p>
    </Card>
  );
}

export function DeepDiveOverview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: "Deep Dive", href: "/deep-dive" }, { label: "Overview" }]);
  }, [setBreadcrumbs]);

  const query = useQuery({
    queryKey: deepDiveOverviewQueryKeys.overview(companyId),
    queryFn: () => deepDiveOverviewApi.get(companyId),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) return <EmptyState icon={Compass} message="Select a company to see its Deep Dive overview." />;
  if (query.isLoading) return <PageSkeleton variant="list" />;
  if (query.error || !query.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "The overview did not load."} Reload the page to try again.
      </p>
    );
  }

  const overview = query.data;
  const [lead, ...rest] = overview.next;
  const total = overview.cells.known + overview.cells.indicated + overview.cells.unknown;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold">Deep Dive overview</h1>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <Link to="/deep-dive" className="text-xs font-medium underline-offset-4 hover:underline">Investigation Streams</Link>
            <Link to="/deep-dive/sessions" className="text-xs font-medium underline-offset-4 hover:underline">Sessions</Link>
            <Link to="/deep-dive/findings" className="text-xs font-medium underline-offset-4 hover:underline">Findings</Link>
          </div>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Place the known, validate the indicated, investigate only the unknown. This page only reads the other Deep
          Dive screens; open a line to do the work there.
        </p>
      </header>

      <Section id="deep-dive-next" title="What is next">
        {lead ? (
          <ol aria-label="What is next" className="space-y-1.5">
            <StepRow step={lead} lead />
            {rest.map((step) => <StepRow key={step.key} step={step} />)}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing waits. Every stream is Known, every finding is decided and the chain is whole.
          </p>
        )}
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section id="deep-dive-needs-person" title={`Needs a person (${overview.needsPerson.length})`}>
          {overview.needsPerson.length > 0 ? (
            <ul aria-label="Needs a person" className="space-y-1.5">
              {overview.needsPerson.map((step) => <StepRow key={step.key} step={step} />)}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing waits for a person.</p>
          )}
        </Section>

        <Section id="deep-dive-next-session" title="Next session">
          <NextSession overview={overview} />
        </Section>
      </div>

      <Section id="deep-dive-progress" title="Progress by stream">
        <p className="text-xs text-muted-foreground">
          {overview.cells.known} of {total} GIF cells Known · {overview.cells.indicated} Indicated · {overview.cells.unknown} Unknown
        </p>
        <ul aria-label="Progress by stream" className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {overview.streams.map((stream) => (
            <li key={stream.key} data-stream={stream.key}>
              <Card className="gap-1.5 px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 break-words text-sm font-medium">{stream.label}</span>
                  <StatusBadge status={STREAM_TONE[stream.status]} label={DEEP_DIVE_LABELS[stream.status]} />
                </div>
                <div
                  role="img"
                  aria-label={`${stream.label}: ${stream.cells.known} Known, ${stream.cells.indicated} Indicated, ${stream.cells.unknown} Unknown`}
                  className="flex h-1.5 overflow-hidden rounded-full bg-muted"
                >
                  <span className="bg-status-success" style={{ width: `${(stream.cells.known / 5) * 100}%` }} />
                  <span className="bg-status-warning" style={{ width: `${(stream.cells.indicated / 5) * 100}%` }} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {stream.cells.known}/5 Known
                  {stream.findings.validated ? ` · ${stream.findings.validated} validated` : ""}
                  {stream.findings.proposed ? ` · ${stream.findings.proposed} proposed` : ""}
                  {stream.depth === "reduced" ? ` · Reduced: ${stream.depthReason}` : ""}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="deep-dive-open-findings" title={`Open findings (${overview.openFindings.length})`}>
        {overview.openFindings.length > 0 ? (
          <ul aria-label="Open findings" className="space-y-1.5">
            {overview.openFindings.slice(0, 10).map((finding) => (
              <li key={finding.id} className="rounded-md border border-border px-3 py-2">
                <p className="break-words text-sm">{finding.statement}</p>
                <p className="text-xs text-muted-foreground">
                  {(finding.streamKey && STREAM_LABEL.get(finding.streamKey)) ?? "Unknown stream"} · {GIF_LABEL.get(finding.gifKey)} · Proposed, waiting for a decision
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No finding waits for a decision.</p>
        )}
        <p className="text-xs text-muted-foreground">
          {overview.findingCounts.validated} validated · {overview.findingCounts.rejected} rejected ·{" "}
          {overview.findingCounts.superseded} superseded.{" "}
          <Link to="/deep-dive/findings" className="underline">All findings</Link>
        </p>
      </Section>
    </div>
  );
}
