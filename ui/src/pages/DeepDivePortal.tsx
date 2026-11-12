import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Microscope } from "lucide-react";
import {
  DEEP_DIVE_DRAFT_LABELS,
  DEEP_DIVE_PILLAR_LABELS,
  readDeepDiveRecordFields,
  type DeepDiveDraft,
  type DeepDiveInterviewLog,
  type DeepDiveRecordProposal,
} from "@greatstone/shared";
import { casesApi } from "@/api/cases";
import { deepDiveRecordsApi, deepDiveRecordsQueryKeys } from "@/api/deepDiveRecords";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { DeepDiveScopeProvider, DEEP_DIVE_TILES_PATH, deepDivePath, useDeepDiveScope, type DeepDivePortalScope } from "@/lib/deep-dive-scope";
import { Link, NavLink, Route, Routes, useCaseHref, useParams } from "@/lib/router";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { InterviewLogView, interviewLogCountsText } from "@/components/InterviewLogView";
import { DeliverablesPanel } from "@/components/OrganisationHub";
import { PageSkeleton } from "@/components/PageSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { DeepDiveFiles } from "./DeepDiveFiles";
import { DeepDiveFindings } from "./DeepDiveFindings";
import { DeepDiveInterviews } from "./DeepDiveInterviews";
import { DeepDiveOpportunities } from "./DeepDiveOpportunities";
import { DeepDiveOrganisation } from "./DeepDiveOrganisation";
import { DeepDiveOverview } from "./DeepDiveOverview";
import { DeepDiveProcessBoard } from "./DeepDiveProcessBoard";
import { DeepDiveSessionDetail, DeepDiveSessions } from "./DeepDiveSessions";
import { DeepDiveTraceability } from "./DeepDiveTraceability";

// One client's Deep Dive (GRE-4430): a tab for each part, all scoped to this
// Deep Dive. Opened from its tile on the Deep Dive page or from the client's
// profile. The tabs reuse the screens built under GRE-2365 to GRE-2373.

const TABS = [
  { path: "", label: "Overview" },
  { path: "/questions", label: "Questions and answers" },
  { path: "/registers", label: "Registers" },
  { path: "/sessions", label: "Sessions" },
  { path: "/findings", label: "Findings" },
  { path: "/organisation", label: "Organisation" },
  { path: "/processes", label: "Processes" },
  { path: "/opportunities", label: "Opportunities and KPIs" },
  { path: "/traceability", label: "Traceability" },
  { path: "/interviews", label: "Parallel Interview" },
  { path: "/documents", label: "Documents" },
  { path: "/deliverables", label: "Deliverables" },
] as const;

const DRAFT_TONE: Record<DeepDiveDraft["status"], string> = { draft: "pending_approval", approved: "approved", rejected: "rejected" };

function errorText(error: unknown) {
  return error instanceof Error ? error.message : error ? "Something went wrong." : null;
}

/** Breadcrumbs for the tabs that are new in the portal; the older screens set their own. */
function usePortalCrumb(label: string) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { record, recordCaseId } = useDeepDiveScope();
  useEffect(() => {
    setBreadcrumbs([
      { label: "Deep Dive", href: DEEP_DIVE_TILES_PATH },
      { label: record.clientName, href: deepDivePath(recordCaseId) },
      { label },
    ]);
  }, [setBreadcrumbs, record.clientName, recordCaseId, label]);
}

function DeliverablesTab() {
  const { record, companyId } = useDeepDiveScope();
  usePortalCrumb("Deliverables");
  return <DeliverablesPanel caseId={record.clientCaseId} companyId={companyId} />;
}

function useDrafts() {
  const scope = useDeepDiveScope();
  return useQuery({ queryKey: deepDiveRecordsQueryKeys.drafts(scope), queryFn: () => deepDiveRecordsApi.drafts(scope) });
}

/** Approve or reject one agent draft, against the version on screen. Only people see these buttons work. */
function DraftDecision({ draft }: { draft: DeepDiveDraft }) {
  const scope = useDeepDiveScope();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: (decision: "approved" | "rejected") =>
      deepDiveRecordsApi.decide(scope, draft.id, { decision, expectedVersion: draft.version, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: deepDiveRecordsQueryKeys.drafts(scope) }),
      queryClient.invalidateQueries({ queryKey: deepDiveRecordsQueryKeys.list(scope.companyId) }),
    ]),
  });
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-end">
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-xs text-muted-foreground">Note for the agent (optional)</span>
        <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} />
      </label>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => decide.mutate("approved")} disabled={decide.isPending}>Approve</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => decide.mutate("rejected")} disabled={decide.isPending}>Reject</Button>
      </div>
      {decide.error ? <p role="alert" className="text-sm text-destructive">{errorText(decide.error)}</p> : null}
    </div>
  );
}

function DraftCard({ draft, children }: { draft: DeepDiveDraft; children: ReactNode }) {
  return (
    <article className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h3 className="break-words text-sm font-semibold">{draft.title}</h3>
          <p className="text-xs text-muted-foreground">
            {DEEP_DIVE_DRAFT_LABELS[draft.kind]} · {draft.createdByAgentId ? "logged by an agent" : "logged by a person"} · version {draft.version}
            {draft.decidedAt ? ` · decided ${formatDate(draft.decidedAt)}` : ""}
          </p>
        </div>
        <StatusBadge status={DRAFT_TONE[draft.status]} label={DEEP_DIVE_DRAFT_LABELS[draft.status]} />
      </header>
      {children}
      {draft.decisionNote ? <p className="text-xs text-muted-foreground">Note: {draft.decisionNote}</p> : null}
      {draft.status === "draft" ? <DraftDecision draft={draft} /> : null}
    </article>
  );
}

/** Interview answers: drafts waiting for a person first, then every approved interview. */
export function DeepDiveQuestions() {
  usePortalCrumb("Questions and answers");
  const drafts = useDrafts();
  if (drafts.isLoading) return <PageSkeleton variant="list" />;
  if (drafts.error) return <p role="alert" className="text-sm text-destructive">{errorText(drafts.error)}</p>;
  const logs = (drafts.data ?? []).filter((d) => d.kind === "interview_log");
  const waiting = logs.filter((d) => d.status === "draft");
  const approved = logs.filter((d) => d.status === "approved");
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Answers logged from interview transcripts. An agent logs each interview as a draft; it counts once a person
        approves it. The question bank in Ben's format comes next (phase 2).
      </p>
      <section className="space-y-3" aria-labelledby="qa-waiting">
        <h2 id="qa-waiting" className="text-sm font-semibold">Waiting for review ({waiting.length})</h2>
        {waiting.length === 0 ? <p className="text-sm text-muted-foreground">No interview waits for review.</p> : null}
        {waiting.map((draft) => (
          <DraftCard key={draft.id} draft={draft}>
            <p className="text-xs text-muted-foreground">{interviewLogCountsText(draft.payload as DeepDiveInterviewLog)}</p>
            <InterviewLogView log={draft.payload as DeepDiveInterviewLog} />
          </DraftCard>
        ))}
      </section>
      <section className="space-y-3" aria-labelledby="qa-approved">
        <h2 id="qa-approved" className="text-sm font-semibold">Approved interviews ({approved.length})</h2>
        {approved.length === 0 ? <p className="text-sm text-muted-foreground">None approved yet.</p> : null}
        {approved.map((draft) => (
          <details key={draft.id} className="rounded-lg border border-border bg-card p-4">
            <summary className="cursor-pointer text-sm font-medium">
              {draft.title} <span className="text-xs font-normal text-muted-foreground">{interviewLogCountsText(draft.payload as DeepDiveInterviewLog)}</span>
            </summary>
            <div className="mt-3"><InterviewLogView log={draft.payload as DeepDiveInterviewLog} /></div>
          </details>
        ))}
      </section>
    </div>
  );
}

/** Register rows agents proposed, by register. Approved rows stay here until the registers of phase 2. */
export function DeepDiveRegisters() {
  usePortalCrumb("Registers");
  const drafts = useDrafts();
  if (drafts.isLoading) return <PageSkeleton variant="list" />;
  if (drafts.error) return <p role="alert" className="text-sm text-destructive">{errorText(drafts.error)}</p>;
  const rows = (drafts.data ?? []).filter((d) => d.kind === "record_proposal" && d.status !== "rejected");
  const byRegister = new Map<string, DeepDiveDraft[]>();
  for (const row of rows) {
    const register = (row.payload as DeepDiveRecordProposal).register;
    byRegister.set(register, [...(byRegister.get(register) ?? []), row]);
  }
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Risks, decisions, evidence and other register rows, proposed by agents and approved by a person.
      </p>
      {byRegister.size === 0 ? <p className="text-sm text-muted-foreground">No register rows yet.</p> : null}
      {[...byRegister].map(([register, list]) => (
        <section key={register} className="space-y-3">
          <h2 className="text-sm font-semibold">{register}</h2>
          {list.map((draft) => {
            const proposal = draft.payload as DeepDiveRecordProposal;
            return (
              <DraftCard key={draft.id} draft={draft}>
                <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                  {Object.entries(proposal.values).map(([column, value]) => (
                    <div key={column} className="contents">
                      <dt className="text-xs text-muted-foreground">{column}</dt>
                      <dd className="break-words sm:col-span-2">{value}</dd>
                    </div>
                  ))}
                </dl>
                {proposal.workstream || proposal.pillars?.length ? (
                  <p className="text-xs text-muted-foreground">
                    {[proposal.workstream, ...(proposal.pillars ?? []).map((p) => DEEP_DIVE_PILLAR_LABELS[p])].filter(Boolean).join(" · ")}
                  </p>
                ) : null}
              </DraftCard>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/** Ben's workstreams for this Deep Dive: the grouping for everything in it. */
function Workstreams() {
  const scope = useDeepDiveScope();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState("");
  const record = useQuery({ queryKey: ["cases", "detail", scope.recordCaseId], queryFn: () => casesApi.get(scope.recordCaseId) });
  const fields = readDeepDiveRecordFields(record.data?.fields);
  const save = useMutation({
    mutationFn: (workstreams: string[]) => casesApi.patch(scope.recordCaseId, { fields: { ...(record.data?.fields ?? {}), workstreams } }),
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ["cases", "detail", scope.recordCaseId] }),
      queryClient.invalidateQueries({ queryKey: deepDiveRecordsQueryKeys.list(scope.companyId) }),
    ]),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const name = adding.trim();
    if (!name || fields.workstreams.includes(name)) return;
    save.mutate([...fields.workstreams, name]);
    setAdding("");
  }
  return (
    <section className="space-y-2 rounded-lg border border-border p-4" aria-labelledby="dd-workstreams">
      <h2 id="dd-workstreams" className="text-sm font-semibold">Workstreams</h2>
      <p className="text-xs text-muted-foreground">
        Everything in this Deep Dive is grouped by these, as in Ben's portal, and tagged with pillars. Agents can only use
        names listed here.
      </p>
      {fields.workstreams.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : (
        <ul className="flex flex-wrap gap-2">
          {fields.workstreams.map((name) => (
            <li key={name} className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs">
              {name}
              <button
                type="button"
                className="rounded-full px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50"
                aria-label={`Remove ${name}`}
                onClick={() => save.mutate(fields.workstreams.filter((w) => w !== name))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <Input value={adding} onChange={(event) => setAdding(event.target.value)} placeholder="Workstream name" maxLength={120} aria-label="New workstream" />
        <Button type="submit" size="sm" variant="outline" disabled={!adding.trim() || save.isPending}>Add</Button>
      </form>
      {save.error ? <p role="alert" className="text-sm text-destructive">{errorText(save.error)}</p> : null}
    </section>
  );
}

export function PortalHeader() {
  const scope = useDeepDiveScope();
  const caseHref = useCaseHref();
  const { record } = scope;
  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs text-muted-foreground">
            <Link to={DEEP_DIVE_TILES_PATH} className="underline-offset-4 hover:underline">Deep Dive</Link>
            {record.identifier ? <> · <span className="font-mono">{record.identifier}</span></> : null}
          </p>
          <h1 className="break-words text-xl font-bold">{record.clientName}</h1>
        </div>
        <div className="flex flex-wrap gap-3 text-xs font-medium">
          {record.organisationId ? (
            <Link to={`/organisations/${record.organisationId}`} className="underline-offset-4 hover:underline">Open client profile</Link>
          ) : null}
          <Link to={caseHref(record.identifier ?? record.id)} className="underline-offset-4 hover:underline">North Star and record documents</Link>
        </div>
      </div>
      <nav aria-label="Deep Dive sections" className="-mx-1 overflow-x-auto">
        <ul className="flex min-w-max gap-1 border-b border-border px-1">
          {TABS.map((tab) => (
            <li key={tab.path}>
              <NavLink
                to={deepDivePath(scope.recordCaseId, tab.path)}
                end={tab.path === ""}
                className={({ isActive }) =>
                  cn(
                    "inline-flex border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50",
                    isActive ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )
                }
              >
                {tab.label}
                {tab.path === "/questions" && record.draftsWaiting > 0 ? (
                  <span className="ml-1.5 rounded-full bg-status-warning-soft px-1.5 text-xs text-status-warning-foreground">{record.draftsWaiting}</span>
                ) : null}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}

/** The portal of one client's Deep Dive, at /deep-dive/:recordId. */
export function DeepDivePortal() {
  const { recordId = "" } = useParams<{ recordId: string }>();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const list = useQuery({
    queryKey: deepDiveRecordsQueryKeys.list(companyId),
    queryFn: () => deepDiveRecordsApi.list(companyId),
    enabled: !!companyId,
  });
  const record = list.data?.deepDives.find((entry) => entry.id === recordId) ?? null;

  if (!companyId) return <EmptyState icon={Microscope} message="Select a company to see its Deep Dives." />;
  if (list.isLoading) return <PageSkeleton variant="list" />;
  if (list.error) return <p role="alert" className="text-sm text-destructive">{errorText(list.error)}</p>;
  if (!record) return <EmptyState icon={Microscope} message="This Deep Dive was not found." />;

  const scope: DeepDivePortalScope = { companyId, recordCaseId: record.id, record };
  return (
    <DeepDiveScopeProvider value={scope}>
      <div key={record.id} className="space-y-6">
        <PortalHeader />
        <Routes>
          <Route index element={<div className="space-y-6"><Workstreams /><DeepDiveOverview /></div>} />
          <Route path="questions" element={<DeepDiveQuestions />} />
          <Route path="registers" element={<DeepDiveRegisters />} />
          <Route path="sessions" element={<DeepDiveSessions />} />
          <Route path="sessions/:sessionId" element={<DeepDiveSessionDetail />} />
          <Route path="findings" element={<DeepDiveFindings />} />
          <Route path="organisation" element={<DeepDiveOrganisation />} />
          <Route path="processes" element={<DeepDiveProcessBoard />} />
          <Route path="opportunities" element={<DeepDiveOpportunities />} />
          <Route path="traceability" element={<DeepDiveTraceability />} />
          <Route path="interviews" element={<DeepDiveInterviews />} />
          <Route path="documents" element={<DeepDiveFiles />} />
          <Route path="deliverables" element={<DeliverablesTab />} />
          <Route path="*" element={<EmptyState icon={Microscope} message="This part of the Deep Dive was not found." />} />
        </Routes>
      </div>
    </DeepDiveScopeProvider>
  );
}
