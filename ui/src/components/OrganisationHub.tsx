import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, CalendarClock, FileText, Mail, Pencil, Phone, StickyNote } from "lucide-react";
import type { CrmFile, CrmTimelineEntry, OrganisationHistory } from "@greatstone/shared";
import { casesApi } from "@/api/cases";
import { deepDiveOverviewApi, deepDiveOverviewQueryKeys } from "@/api/deepDiveOverview";
import { deepDiveSessionsApi, deepDiveSessionsQueryKeys } from "@/api/deepDiveSessions";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { pipelinesApi, type PipelineCaseDetail, type PipelineStage } from "@/api/pipelines";
import { websiteModuleApi } from "@/api/website";
import { websiteDataBridgeApi } from "@/api/website-data-bridge";
import { StageStrip } from "@/components/ClientCaseOverview";
import { ClientJourneyOverview } from "@/components/ClientJourneyOverview";
import { ClientPortalPreview } from "@/components/ClientJourneyStages";
import { ClientPublications, EngagementTimelineView } from "@/components/ClientPublications";
import { ErrorState } from "@/components/ErrorState";
import { OrganisationCommerce } from "@/components/OrganisationCommerce";
import { PipelineCaseEvidence } from "@/components/PipelineCaseFiles";
import { ClientVisibilityBadge } from "@/components/SharedWithClientBadge";
import { Badge } from "@/components/ui/badge";
import { useCommerceSite } from "@/hooks/useCommerceSite";
import { CLIENT_CASE_TYPE, readClientRecord } from "@/lib/client-case";
import { formatMinor, statusLabel, statusTone, text } from "@/lib/commerce";
import { formatBytes } from "@/lib/issue-output";
import {
  WEBSITE_LINK_TASK,
  clientShared,
  hubDocumentRequests,
  websiteClientUsers,
  type ClientShared,
} from "@/lib/organisation-hub";
import { formatPipelineItemEvent } from "@/lib/pipeline-item-detail";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, formatDate, formatDateTime } from "@/lib/utils";

// The per-client hub's tabs (GRE-2614). Each one reads the record that owns
// the data and links to it; "Shared with client" marks what the client sees.

/** The tasks that will fill the placeholder tabs. */
const INTERVIEWS_TASK = "GRE-2611";
/** The task that pulls the website's client activity into GSAM (PR 985), and the site side. */
const WEBSITE_ACTIVITY_TASK = "GRE-2635";

export function HubSection({ title, action, children, label }: { title: string; action?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section aria-label={label ?? title} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function SourceLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="text-xs font-medium hover:underline">{children}</Link>;
}

function Placeholder({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{children}</div>;
}

function TaskLink({ task }: { task: string }) {
  return <Link to={`/issues/${task}`} className="font-medium text-foreground hover:underline">{task}</Link>;
}

/**
 * The hub's banner when the client has no website organisation id (GRE-2609).
 * The website sections then stay empty: GSAM never matches a client by name or email.
 */
export function WebsiteLinkNotice() {
  return (
    <div role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="organisation-not-linked">
      <p className="font-medium">Not linked to a website organisation</p>
      <p className="mt-0.5 text-muted-foreground">
        Client users, Commerce and website activity are read from the website by its organisation id, never by name or email.
        Linking is added in <TaskLink task={WEBSITE_LINK_TASK} />.
      </p>
    </div>
  );
}

function NotLinked({ what }: { what: string }) {
  return <Placeholder>{what} show here once this client is linked to its website organisation.</Placeholder>;
}

export function NoEngagement() {
  return (
    <Placeholder>
      This organisation has no client engagement yet. Add it to the Client journey pipeline to collect documents, publish deliverables and open its portal.
    </Placeholder>
  );
}

/** The engagement item and its pipeline's stages (the item's own read carries no stages). */
export function useEngagementCase(caseId: string | null) {
  const query = useQuery({
    queryKey: queryKeys.pipelines.caseDetail(caseId ?? ""),
    queryFn: () => pipelinesApi.getCase(caseId!),
    enabled: Boolean(caseId),
  });
  const pipelineId = query.data?.case.pipelineId ?? "";
  const pipeline = useQuery({
    queryKey: queryKeys.pipelines.detail(pipelineId),
    queryFn: () => pipelinesApi.get(pipelineId),
    enabled: Boolean(pipelineId),
  });
  const detail = query.data ?? null;
  return { query, detail, stages: pipeline.data?.stages ?? [], isClient: detail?.caseType === CLIENT_CASE_TYPE };
}

function casePath(detail: PipelineCaseDetail) {
  return `/pipelines/${detail.case.pipelineId}/items/${detail.case.id}`;
}

/** The website the client hub runs on: the company's first site. */
function useClientSite(companyId: string) {
  const sites = useQuery({
    queryKey: queryKeys.website.sites(companyId),
    queryFn: () => websiteModuleApi.sites(companyId),
    enabled: Boolean(companyId),
    retry: false,
  });
  return sites.data?.[0] ?? null;
}

/** What the website client hub gets for this client: the Deep Dive sync preview (nothing is sent). */
export function useClientShared(companyId: string, caseId: string | null) {
  const site = useClientSite(companyId);
  const preview = useQuery({
    queryKey: queryKeys.website.deepDiveSyncPreview(companyId, site?.id ?? "", caseId ?? ""),
    queryFn: () => websiteDataBridgeApi.previewDeepDiveSync(companyId, site!.id, caseId!),
    enabled: Boolean(site && caseId),
    retry: false,
  });
  return { site, preview, shared: clientShared(preview.data) };
}

function useDeepDiveEnabled() {
  const settings = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  return settings.data?.enableDeepDive === true && settings.data?.enableCases === true;
}

/** The company's Deep Dive, when it is about one of this organisation's engagements. */
function useClientDeepDive(companyId: string, caseIds: string[]) {
  const enabled = useDeepDiveEnabled();
  const files = useQuery({
    queryKey: queryKeys.cases.deepDiveFiles(companyId),
    queryFn: () => casesApi.deepDiveFiles(companyId),
    enabled: enabled && Boolean(companyId),
  });
  const forThisClient = Boolean(files.data?.client && caseIds.includes(files.data.client.id));
  const overview = useQuery({
    queryKey: deepDiveOverviewQueryKeys.overview(companyId),
    queryFn: () => deepDiveOverviewApi.get(companyId),
    enabled: forThisClient,
  });
  return { enabled, files, forThisClient, overview };
}

// ---------------------------------------------------------------- Overview

export function EngagementSummary({
  companyId,
  caseIds,
  detail,
  stages,
  isClient,
}: {
  companyId: string;
  caseIds: string[];
  detail: PipelineCaseDetail;
  stages: PipelineStage[];
  isClient: boolean;
}) {
  const record = readClientRecord(detail.case.fields);
  const deepDive = useClientDeepDive(companyId, caseIds);
  const nextSession = deepDive.forThisClient ? deepDive.overview.data?.nextSession ?? null : null;
  const needsPerson = deepDive.forThisClient ? deepDive.overview.data?.needsPerson ?? [] : [];
  return (
    <HubSection title="Engagement" action={<SourceLink to={casePath(detail)}>Open the engagement</SourceLink>}>
      <div className="space-y-4 rounded-lg border border-border p-4" data-testid="organisation-engagement">
        <StageStrip stages={stages} currentStageId={detail.case.stageId} stageEnteredAt={detail.stageEnteredAt} />
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Owner</dt>
            <dd className="mt-0.5">{record.owner ?? "Not set"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Next action</dt>
            <dd className="mt-0.5 break-words">{record.nextAction ?? "Not set"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Next session</dt>
            <dd className="mt-0.5" data-testid="organisation-next-session">
              {nextSession ? (
                <Link to={`/deep-dive/sessions/${nextSession.id}`} className="hover:underline">
                  {nextSession.title}
                  {nextSession.plannedFor ? <span className="block text-xs text-muted-foreground">{formatDateTime(nextSession.plannedFor)}</span> : null}
                </Link>
              ) : "None planned"}
            </dd>
          </div>
        </dl>
        {isClient ? (
          <ClientJourneyOverview
            caseId={detail.case.id}
            ownerName={record.owner}
            companyId={detail.case.companyId ?? null}
            clientName={detail.case.title}
            stageEnteredAt={detail.stageEnteredAt}
            nextAction={record.nextAction}
          />
        ) : null}
        {needsPerson.length > 0 ? (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground">Deep Dive steps that need a person</h3>
            <ul className="mt-1 space-y-1 text-sm">
              {needsPerson.map((step) => (
                <li key={step.key}>
                  <Link to={step.href} className="hover:underline">{step.title}</Link>
                  <span className="ml-2 text-xs text-muted-foreground">{step.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {isClient ? (
        <div className="rounded-lg border border-border px-4">
          <h3 className="pt-3 text-xs font-medium text-muted-foreground">Timeline</h3>
          <EngagementTimelineView caseId={detail.case.id} />
        </div>
      ) : null}
    </HubSection>
  );
}

// -------------------------------------------------------------------- People

/**
 * The client's users, read from the website by the organisation id (GRE-2609).
 * Read only: names and emails stay on the website; GSAM keeps no copy.
 */
export function WebsitePeople({ companyId, websiteOrganisationId }: { companyId: string; websiteOrganisationId: string | null }) {
  const { commerce } = useCommerceSite(companyId);
  const siteId = commerce?.site.id ?? null;
  const customer = useQuery({
    queryKey: queryKeys.website.data(companyId, siteId ?? "", "customers", "get", websiteOrganisationId ?? ""),
    queryFn: () => websiteDataBridgeApi.get(companyId, siteId!, "customers", websiteOrganisationId!),
    enabled: Boolean(siteId && websiteOrganisationId),
  });
  const users = websiteClientUsers(customer.data?.item);
  return (
    <HubSection title="Client users" label="Client users">
      <p className="text-xs text-muted-foreground">From the client's website account. Read only; change them on the website.</p>
      {!websiteOrganisationId ? <NotLinked what="The client's website users" /> : null}
      {websiteOrganisationId && !siteId ? (
        <Placeholder>Client users are read through Greatstone's website bridge, which is not available for this company.</Placeholder>
      ) : null}
      {websiteOrganisationId && siteId && customer.isLoading ? <p className="text-sm text-muted-foreground">Loading the client's users…</p> : null}
      {customer.error ? <ErrorState error={customer.error} compact /> : null}
      {customer.data && users.length === 0 ? <p className="text-sm text-muted-foreground">No users on the client's website account yet.</p> : null}
      {users.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border" data-testid="organisation-website-users">
          {users.map((user) => (
            <li key={user.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:items-baseline sm:gap-3">
              <span className="min-w-0 font-medium sm:w-1/3 sm:truncate">
                {user.name ?? user.email ?? "Unnamed user"}
                {user.role ? <span className="ml-1 font-normal text-muted-foreground">({user.role})</span> : null}
              </span>
              <span className="min-w-0 flex-1 break-all text-muted-foreground">{user.email}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground" title="Website user id">{user.id}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </HubSection>
  );
}

// ------------------------------------------------------ Executive Discovery

const DISCOVERY_KINDS = new Set<CrmTimelineEntry["kind"]>(["note", "call", "activity", "email"]);

export function DiscoveryPanel({
  detail,
  stages,
  history,
}: {
  detail: PipelineCaseDetail | null;
  stages: PipelineStage[];
  history: OrganisationHistory | undefined;
}) {
  const stage = stages.find((item) => /executive discovery/i.test(item.name)) ?? null;
  const notes = (history?.timeline ?? []).filter((entry) => DISCOVERY_KINDS.has(entry.kind));
  return (
    <div className="space-y-6">
      <HubSection title="Executive Discovery" action={detail ? <SourceLink to={casePath(detail)}>Open the engagement</SourceLink> : null}>
        <p className="text-sm text-muted-foreground" data-testid="organisation-discovery-stage">
          {!detail
            ? "No engagement yet."
            : !stage
              ? `The ${detail.pipeline.name} pipeline has no Executive Discovery stage.`
              : detail.case.stageId === stage.id
                ? "The engagement is in Executive Discovery now."
                : `Stage: ${detail.stage.name}.`}
        </p>
      </HubSection>
      <HubSection title="Notes, calls and meetings" label="Discovery notes">
        {notes.length === 0 ? (
          <Placeholder>
            No notes yet. Executive Discovery notes are kept as notes, calls and meetings on this client; log them on the engagement or in your CRM and they show here.
          </Placeholder>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {notes.map((entry) => <TimelineRow key={entry.id} entry={entry} />)}
          </ul>
        )}
      </HubSection>
    </div>
  );
}

// ---------------------------------------------------------------- Interviews

export function InterviewsPanel() {
  return (
    <HubSection title="Interviews">
      <Placeholder>
        The Parallel Interview module is being built in{" "}
        <TaskLink task={INTERVIEWS_TASK} />.
        This client's interview rounds, who finished, and the released synthesis will show here when it ships.
      </Placeholder>
    </HubSection>
  );
}

// ----------------------------------------------------------------- Deep Dive

const DEEP_DIVE_SCREENS = [
  { to: "/deep-dive/overview", label: "Overview" },
  { to: "/deep-dive", label: "Record and streams" },
  { to: "/deep-dive/organisation", label: "Organisation board" },
  { to: "/deep-dive/processes", label: "Process board" },
  { to: "/deep-dive/sessions", label: "Sessions" },
  { to: "/deep-dive/findings", label: "Findings" },
  { to: "/deep-dive/opportunities", label: "Opportunities" },
  { to: "/deep-dive/traceability", label: "Traceability" },
  { to: "/deep-dive/files", label: "Evidence and files" },
] as const;

function SharedCount({ label, shared, total }: { label: string; shared: number; total: number }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 tabular-nums">{shared} shared · {total - shared} internal</dd>
    </div>
  );
}

export function DeepDivePanel({ companyId, caseIds, shared }: { companyId: string; caseIds: string[]; shared: ClientShared }) {
  const deepDive = useClientDeepDive(companyId, caseIds);
  const sessions = useQuery({
    queryKey: deepDiveSessionsQueryKeys.list(companyId),
    queryFn: () => deepDiveSessionsApi.list(companyId),
    enabled: deepDive.forThisClient,
  });
  if (!deepDive.enabled) return <Placeholder>Deep Dive is off on this instance.</Placeholder>;
  if (deepDive.files.isLoading) return <p className="text-sm text-muted-foreground">Loading the Deep Dive…</p>;
  if (deepDive.files.error) return <ErrorState error={deepDive.files.error} compact />;
  if (!deepDive.forThisClient) {
    const other = deepDive.files.data?.client?.title;
    return (
      <Placeholder>
        {other ? `The Deep Dive is about ${other}, not this client.` : "The Deep Dive has no client chosen yet."}{" "}
        <Link to="/deep-dive/files" className="font-medium text-foreground hover:underline">Choose the client</Link> to run it for this one.
      </Placeholder>
    );
  }
  const links = deepDive.files.data?.links ?? [];
  const sessionRows = sessions.data ?? [];
  return (
    <div className="space-y-6">
      <HubSection title="What the client can see" label="Deep Dive sharing">
        <dl className="grid gap-3 rounded-lg border border-border p-4 text-sm sm:grid-cols-3" data-testid="organisation-deep-dive-counts">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Items on the website</dt>
            <dd className="mt-0.5 tabular-nums">{shared.itemIds.size} shared</dd>
          </div>
          <SharedCount label="File links" shared={links.filter((link) => link.visibility === "shared").length} total={links.length} />
          <SharedCount label="Sessions" shared={sessionRows.filter((row) => row.visibility === "shared").length} total={sessionRows.length} />
        </dl>
        <p className="text-xs text-muted-foreground">Only Shared items, and Shared files on them, reach the client's website hub.</p>
      </HubSection>
      <HubSection title="Deep Dive screens">
        <ul className="grid gap-2 sm:grid-cols-3">
          {DEEP_DIVE_SCREENS.map((screen, index) => (
            <li key={screen.to}>
              <Link
                to={screen.to}
                className="flex items-baseline gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                <span className="font-medium">{screen.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </HubSection>
    </div>
  );
}

// ----------------------------------------------------------------- Documents

const REQUEST_STATE_LABEL = { received: "Received", answered: "Answered on the website", missing: "Missing" } as const;

export function DocumentsPanel({
  caseId,
  organisationId,
  history,
  shared,
}: {
  caseId: string | null;
  organisationId: string;
  history: OrganisationHistory | undefined;
  shared: ClientShared;
}) {
  const journey = useQuery({
    queryKey: queryKeys.pipelines.caseJourney(caseId ?? ""),
    queryFn: () => pipelinesApi.getCaseJourney(caseId!),
    enabled: Boolean(caseId),
  });
  const requests = hubDocumentRequests(journey.data?.stages ?? []);
  const missing = requests.filter((row) => row.state === "missing").length;
  const files = history?.files ?? [];
  return (
    <div className="space-y-6">
      {caseId ? (
        <HubSection title={missing ? `Requested (${missing} missing)` : "Requested"} label="Document requests">
          {journey.isLoading ? <p className="text-sm text-muted-foreground">Loading the requests…</p> : null}
          {journey.error ? <ErrorState error={journey.error} compact /> : null}
          {journey.data && requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing asked of this client yet. Ask for documents on a journey stage of the engagement.</p>
          ) : null}
          {requests.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {requests.map(({ request, stageName, state, at }) => (
                <li key={request.id} className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-center sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium">
                      {request.received?.contentPath ? (
                        <a href={request.received.contentPath} target="_blank" rel="noreferrer" className="hover:underline">{request.title}</a>
                      ) : request.title}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[stageName, `asked ${formatDate(request.createdAt)}`, at ? `${state === "answered" ? "answered" : "received"} ${formatDate(at)}` : null,
                        request.websiteAnswer?.answeredBy.name ? `by ${request.websiteAnswer.answeredBy.name}` : null].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ClientVisibilityBadge
                      shared={shared.documentRequestIds.has(request.id)}
                      sharedTitle="Asked on the client's website hub"
                      notSharedLabel="Not on website"
                      notSharedTitle="Not asked on the client's website hub"
                    />
                    <Badge variant={state === "missing" ? "secondary" : "outline"}>{REQUEST_STATE_LABEL[state]}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </HubSection>
      ) : null}
      {caseId ? (
        <HubSection title="Collected" label="Collected files">
          <PipelineCaseEvidence caseId={caseId} organisationId={organisationId} />
        </HubSection>
      ) : null}
      {files.length ? (
        <HubSection title="From the CRM" label="Files">
          <ul className="divide-y divide-border rounded-md border border-border">
            {files.map((file) => <FileRow key={file.id} file={file} />)}
          </ul>
        </HubSection>
      ) : null}
      {!caseId && !files.length ? <NoEngagement /> : null}
    </div>
  );
}

// -------------------------------------------------------------- Deliverables

export function DeliverablesPanel({ caseId, companyId }: { caseId: string | null; companyId: string }) {
  if (!caseId) return <NoEngagement />;
  return (
    <HubSection title="Deliverables" action={<SourceLink to="/deliverables">All deliverables</SourceLink>}>
      <p className="text-xs text-muted-foreground">Draft, sent for approval, approved, published and accepted, with each receipt. Published and accepted ones are shared with the client.</p>
      <div className="rounded-lg border border-border px-4">
        <ClientPublications caseId={caseId} companyId={companyId} showSetupNotices={false} />
      </div>
    </HubSection>
  );
}

// ------------------------------------------------------------------ Commerce

export function CommercePanel({ companyId, websiteOrganisationId }: { companyId: string; websiteOrganisationId: string | null }) {
  const { commerce } = useCommerceSite(companyId);
  if (!commerce) {
    return <Placeholder>Commerce reads Greatstone's website with the Shop feature on. It is not available for this company.</Placeholder>;
  }
  if (!websiteOrganisationId) return <NotLinked what="Quotes, orders, invoices and licences" />;
  return <OrganisationCommerce companyId={companyId} websiteOrganisationId={websiteOrganisationId} />;
}

// ------------------------------------------------------------------- Billing

const BILLING_PERIOD_LABEL: Record<string, string> = { monthly: "Monthly", quarterly: "Quarterly", annual: "Annual", multi_year: "Multi-year" };
const BILLING_COLUMNS = "sm:grid-cols-[minmax(0,1fr)_3rem_7rem_6rem_7rem_5rem]";

function BillingCell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <span className={cn("text-muted-foreground sm:text-foreground", className)}>
      <span className="sm:sr-only">{label}: </span>
      {children}
    </span>
  );
}

/**
 * The client's recurring billing lines (GRE-2725), read from the website by its organisation id through the
 * bridge. Read only: change them in the website's Commerce admin.
 */
export function BillingPanel({ companyId, websiteOrganisationId }: { companyId: string; websiteOrganisationId: string | null }) {
  const { commerce } = useCommerceSite(companyId);
  const siteId = commerce?.site.id ?? null;
  const lines = useQuery({
    queryKey: queryKeys.website.data(companyId, siteId ?? "", "billing-lines", "list", websiteOrganisationId ?? ""),
    queryFn: () => websiteDataBridgeApi.list(companyId, siteId!, "billing-lines", { customer: websiteOrganisationId!, limit: 100 }),
    enabled: Boolean(siteId && websiteOrganisationId),
  });
  const rows = lines.data?.items ?? [];
  return (
    <HubSection title="Recurring billing">
      <p className="text-xs text-muted-foreground">
        From the website's Commerce database. Read only; change them on the website. One-off quotes, orders, invoices and licences are on the Commerce tab.
      </p>
      {!commerce ? <Placeholder>Recurring billing reads Greatstone's website with the Shop feature on. It is not available for this company.</Placeholder> : null}
      {commerce && !websiteOrganisationId ? <NotLinked what="Recurring billing lines" /> : null}
      {lines.isLoading ? <p className="text-sm text-muted-foreground">Loading the billing lines…</p> : null}
      {lines.error ? <ErrorState error={lines.error} title="Could not reach the website" compact /> : null}
      {lines.data && rows.length === 0 ? <p className="text-sm text-muted-foreground">This client has no recurring billing lines on the website.</p> : null}
      {rows.length ? (
        <div className="rounded-lg border border-border" data-testid="organisation-billing-lines">
          <div className={cn("hidden gap-3 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground sm:grid", BILLING_COLUMNS)} aria-hidden="true">
            <span>Description</span>
            <span className="text-right">Qty</span>
            <span className="text-right">Unit price</span>
            <span>Period</span>
            <span>Next bill</span>
            <span>Status</span>
          </div>
          <ul className="divide-y divide-border">
            {rows.map((line) => {
              const id = text(line.id) ?? "";
              const period = text(line.billing_period);
              const nextBill = text(line.next_bill_on);
              const status = text(line.status);
              return (
                <li key={id} className={cn("grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 text-sm sm:items-baseline", BILLING_COLUMNS)}>
                  <span className="col-span-2 min-w-0 break-words font-medium sm:col-span-1">{text(line.description) ?? "No description"}</span>
                  <BillingCell label="Qty" className="tabular-nums sm:text-right">{text(line.qty) ?? "None"}</BillingCell>
                  <BillingCell label="Unit price" className="tabular-nums sm:text-right">{formatMinor(line.unit_price_minor, line.currency) ?? "None"}</BillingCell>
                  <BillingCell label="Period">{period ? BILLING_PERIOD_LABEL[period] ?? statusLabel(period) : "None"}</BillingCell>
                  <BillingCell label="Next bill">{nextBill ? formatDate(nextBill) : "None"}</BillingCell>
                  <span>
                    {status ? (
                      <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", statusTone(status))}>{statusLabel(status)}</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </HubSection>
  );
}

// ------------------------------------------------------------------ Activity

function actorName(event: { actorType: string; actorAgent?: { name: string } | null }) {
  if (event.actorType === "agent") return event.actorAgent?.name ?? "An agent";
  if (event.actorType === "user") return "A person";
  return "The system";
}

export function ActivityPanel({
  detail,
  stages,
  history,
  websiteOrganisationId,
}: {
  detail: PipelineCaseDetail | null;
  stages: PipelineStage[];
  history: OrganisationHistory | undefined;
  websiteOrganisationId: string | null;
}) {
  const caseId = detail?.case.id ?? "";
  const events = useQuery({
    queryKey: [...queryKeys.pipelines.caseEvents(caseId), "hub"],
    queryFn: () => pipelinesApi.getCaseEvents(caseId, { limit: 50, order: "desc" }),
    enabled: Boolean(caseId),
  });
  const timeline = history?.timeline ?? [];
  return (
    <div className="space-y-6">
      {detail ? (
        <HubSection title="On the engagement" label="Engagement activity" action={<SourceLink to={casePath(detail)}>Open the engagement</SourceLink>}>
          {events.isLoading ? <p className="text-sm text-muted-foreground">Loading activity…</p> : null}
          {events.error ? <ErrorState error={events.error} compact /> : null}
          {events.data && events.data.items.length === 0 ? <p className="text-sm text-muted-foreground">No activity yet.</p> : null}
          {events.data?.items.length ? (
            <ol className="divide-y divide-border rounded-md border border-border">
              {events.data.items.map((event) => (
                <li key={event.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:items-baseline sm:gap-3">
                  <span className="min-w-0 flex-1 break-words">{formatPipelineItemEvent(event, stages)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{actorName(event)} · {formatDateTime(event.createdAt)}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </HubSection>
      ) : null}
      <HubSection title="On the website" label="Website activity">
        {websiteOrganisationId ? (
          <Placeholder>
            What the client does on the website (sign-ins, uploads, acceptances) will show here, read by its website organisation id.
            It arrives with <TaskLink task={WEBSITE_ACTIVITY_TASK} />.
          </Placeholder>
        ) : <NotLinked what="The client's actions on the website" />}
      </HubSection>
      {timeline.length ? (
        <HubSection title="Activities and notes">
          <ul className="divide-y divide-border rounded-md border border-border">
            {timeline.map((entry) => <TimelineRow key={entry.id} entry={entry} />)}
          </ul>
        </HubSection>
      ) : null}
      {!detail && !timeline.length ? <p className="text-sm text-muted-foreground">No activity in GSAM for this organisation yet.</p> : null}
    </div>
  );
}

// --------------------------------------------------------------- Client view

export function ClientViewPanel({ companyId, caseId }: { companyId: string; caseId: string | null }) {
  const { site, preview } = useClientShared(companyId, caseId);
  if (!caseId) return <NoEngagement />;
  const data = preview.data;
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Check this before you share: it is exactly what the client can open and download. Nothing here is sent.
      </p>
      <HubSection title="On the client portal" label="Client portal">
        <div className="rounded-lg border border-border px-4">
          <ClientPortalPreview caseId={caseId} />
        </div>
      </HubSection>
      <HubSection title="On the website client hub" label="Website client hub">
        {!site ? <p className="text-sm text-muted-foreground">This company has no website, so there is no website client hub.</p> : null}
        {site && preview.isLoading ? <p className="text-sm text-muted-foreground">Loading what the website gets…</p> : null}
        {site && preview.error ? <ErrorState error={preview.error} compact /> : null}
        {data ? (
          data.items.length + data.files.length + data.documentRequests.length + data.deliverables.length === 0 ? (
            <p className="text-sm text-muted-foreground">The website hub shows this client nothing yet. Share Deep Dive items, or publish a deliverable.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2" data-testid="organisation-website-view">
              <ViewList title="Deep Dive items" rows={data.items.map((item) => ({ id: item.id, text: item.title }))} />
              {/* Only files that exist; a missing one is still a request, listed under Document requests. */}
              <ViewList title="Files" rows={data.files.filter((file) => file.status !== "missing").map((file) => ({ id: file.id, text: file.title }))} />
              <ViewList
                title="Document requests"
                rows={data.documentRequests.map((request) => ({ id: request.id, text: request.title, meta: request.status === "open" ? "Open" : "Received" }))}
              />
              <ViewList
                title="Deliverables"
                rows={data.deliverables.map((item) => ({ id: item.id, text: item.title, meta: item.status === "accepted" ? "Accepted" : "Published" }))}
              />
            </div>
          )
        ) : null}
      </HubSection>
    </div>
  );
}

function ViewList({ title, rows }: { title: string; rows: Array<{ id: string; text: string; meta?: string | null }> }) {
  return (
    <div className="min-w-0 rounded-lg border border-border">
      <h3 className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">{title} ({rows.length})</h3>
      {rows.length ? (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="flex min-w-0 items-baseline gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 break-words">{row.text}</span>
              {row.meta ? <span className="shrink-0 text-xs text-muted-foreground">{row.meta}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2 text-sm text-muted-foreground">None.</p>
      )}
    </div>
  );
}

// ------------------------------------------------- CRM timeline and files

const TIMELINE_ICONS = { activity: CalendarClock, note: StickyNote, call: Phone, email: Mail, stage_change: ArrowRightLeft, field_change: Pencil } as const;

function timelineTitle(entry: CrmTimelineEntry) {
  if (entry.subject) return entry.subject;
  if (entry.kind === "note") return "Note";
  if (entry.kind === "call") return "Call";
  if (entry.kind === "email") return "Email";
  if (entry.kind === "stage_change") return "Stage change";
  if (entry.kind === "field_change") return "Field change";
  return entry.activityType ? entry.activityType.charAt(0).toUpperCase() + entry.activityType.slice(1) : "Activity";
}

function timelineMeta(entry: CrmTimelineEntry) {
  const parts: string[] = [];
  if (entry.occurredAt) parts.push(formatDateTime(entry.occurredAt));
  if (entry.kind === "activity") {
    if (entry.activityType) parts.push(entry.activityType);
    parts.push(entry.done ? "Done" : "Planned");
  }
  if (entry.durationMinutes) parts.push(`${entry.durationMinutes} min`);
  if (entry.kind === "email") {
    const from = Array.isArray(entry.details.from) ? entry.details.from.join(", ") : "";
    const to = Array.isArray(entry.details.to) ? entry.details.to.join(", ") : "";
    if (from) parts.push(`from ${from}`);
    if (to) parts.push(`to ${to}`);
  }
  if (entry.ownerName) parts.push(entry.ownerName);
  if (entry.contactName) parts.push(`with ${entry.contactName}`);
  return parts.join(" · ");
}

/** One imported activity, note or call. */
function TimelineRow({ entry }: { entry: CrmTimelineEntry }) {
  const Icon = TIMELINE_ICONS[entry.kind] ?? CalendarClock;
  return (
    <li className="flex gap-2 px-3 py-2 text-sm">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{timelineTitle(entry)}</span>
          {entry.caseId && entry.caseTitle ? <span className="text-xs text-muted-foreground">{entry.caseTitle}</span> : null}
        </div>
        <p className="text-xs text-muted-foreground">{timelineMeta(entry)}</p>
        {entry.body ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{entry.body}</p> : null}
      </div>
    </li>
  );
}

/** One file imported from a CRM: opens the copy in GSAM, or the CRM's link when it was not copied. */
function FileRow({ file }: { file: CrmFile }) {
  const href = file.contentPath ?? file.remoteUrl;
  const meta = [
    file.addedAt ? formatDate(file.addedAt) : null,
    file.byteSize ? formatBytes(file.byteSize) : null,
    file.ownerName,
    file.contactName ? `on ${file.contactName}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="flex gap-2 px-3 py-2 text-sm">
      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">{file.name}</a>
          ) : (
            <span className="font-medium">{file.name}</span>
          )}
          {file.caseId && file.caseTitle ? <span className="text-xs text-muted-foreground">{file.caseTitle}</span> : null}
        </div>
        {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
        {file.notCopied ? <p className="text-xs text-muted-foreground">Not copied into GSAM: {file.notCopied}</p> : null}
        {file.description ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{file.description}</p> : null}
      </div>
    </li>
  );
}
