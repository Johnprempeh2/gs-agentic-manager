import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_FINDING_LABELS,
  DEEP_DIVE_GIF,
  DEEP_DIVE_LABELS,
  DEEP_DIVE_STREAMS,
  DEEP_DIVE_VISIBILITIES,
  deepDiveFindingNextSteps,
  type DeepDiveFinding,
  type DeepDiveFindingStatus,
  type DeepDiveGifKey,
  type DeepDiveVisibility,
} from "@greatstone/shared";
import { casesApi, type CaseSummary } from "@/api/cases";
import { deepDiveFindingsApi, deepDiveFindingsQueryKeys } from "@/api/deepDiveFindings";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { formatShortDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { StatusBadge } from "@/components/StatusBadge";

// Deep Dive findings (GRE-2367): Screen 4 of the GRE-2327 plan. A finding is
// proposed by a person or an agent and validated by a person. It is never
// edited: "Replace" proposes a new finding, and validating that one marks the
// old one Superseded. Each finding sits in one GIF cell and cites the evidence
// of its stream's client.

const STATUS_TONE: Record<DeepDiveFindingStatus, string> = {
  proposed: "warning",
  validated: "succeeded",
  rejected: "failed",
  superseded: "archived",
};

const SELECT_CLASS =
  "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50 disabled:text-subtle-foreground";

const GIF_LABEL = new Map(DEEP_DIVE_GIF.map((gif) => [gif.key, gif.label]));

export interface StreamOption {
  key: string;
  label: string;
  row: CaseSummary;
}

/** The streams that exist, in Book V order. */
export function findingStreams(rows: readonly CaseSummary[]): StreamOption[] {
  return DEEP_DIVE_STREAMS.flatMap((stream) => {
    const row = rows.find((entry) => entry.caseType === DEEP_DIVE_CASE_TYPES.stream && entry.key === stream.key);
    return row ? [{ key: stream.key, label: stream.label, row }] : [];
  });
}

interface Draft {
  streamCaseId: string;
  gifKey: DeepDiveGifKey;
  statement: string;
  evidenceIds: string[];
  supersedes: DeepDiveFinding | null;
}

function emptyDraft(streamCaseId: string): Draft {
  return { streamCaseId, gifKey: DEEP_DIVE_GIF[0].key, statement: "", evidenceIds: [], supersedes: null };
}

function errorText(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function ProposeForm({
  companyId,
  streams,
  draft,
  onChange,
  onDone,
}: {
  companyId: string;
  streams: StreamOption[];
  draft: Draft;
  onChange: (draft: Draft) => void;
  onDone: () => Promise<void>;
}) {
  const stream = streams.find((entry) => entry.row.id === draft.streamCaseId) ?? null;
  const clientCaseId = stream?.row.clientCaseId ?? null;
  const evidenceQuery = useQuery({
    queryKey: deepDiveFindingsQueryKeys.clientEvidence(clientCaseId ?? ""),
    queryFn: () => deepDiveFindingsApi.clientEvidence(clientCaseId!),
    enabled: !!clientCaseId,
  });
  const [formError, setFormError] = useState<string | null>(null);

  const proposeMutation = useMutation({
    mutationFn: () =>
      deepDiveFindingsApi.propose(companyId, {
        streamCaseId: draft.streamCaseId,
        gifKey: draft.gifKey,
        statement: draft.statement.trim(),
        evidenceIds: draft.evidenceIds,
        supersedesFindingId: draft.supersedes?.id ?? null,
      }),
    onSuccess: async () => {
      setFormError(null);
      await onDone();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.statement.trim()) {
      setFormError("Write the finding.");
      return;
    }
    proposeMutation.mutate();
  }

  function toggleEvidence(id: string, checked: boolean) {
    onChange({
      ...draft,
      evidenceIds: checked ? [...draft.evidenceIds, id] : draft.evidenceIds.filter((entry) => entry !== id),
    });
  }

  const shownError = formError ?? errorText(proposeMutation.error);

  return (
    <Card className="gap-3 px-4 py-3">
      <form onSubmit={submit} className="space-y-3" aria-labelledby="deep-dive-propose">
        <h2 id="deep-dive-propose" className="text-sm font-semibold">
          {draft.supersedes ? "Propose a replacement" : "Propose a finding"}
        </h2>
        {draft.supersedes ? (
          <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
            Replaces: <span className="text-foreground">{draft.supersedes.statement}</span>. The old finding stays
            on record and becomes Superseded when a person validates this one.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Investigation Stream</span>
            <NativeSelect
              value={draft.streamCaseId}
              onChange={(event) => onChange({ ...draft, streamCaseId: event.target.value, evidenceIds: [] })}
            >
              {streams.map((entry) => (
                <option key={entry.key} value={entry.row.id}>
                  {entry.label}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>GIF question</span>
            <NativeSelect
              value={draft.gifKey}
              onChange={(event) => onChange({ ...draft, gifKey: event.target.value as DeepDiveGifKey })}
            >
              {DEEP_DIVE_GIF.map((gif) => (
                <option key={gif.key} value={gif.key}>
                  {gif.label}: {gif.question}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span>Finding</span>
          <Textarea
            aria-invalid={formError ? true : undefined}
            placeholder="What did we find?"
            value={draft.statement}
            onChange={(event) => onChange({ ...draft, statement: event.target.value })}
          />
        </label>
        <fieldset className="space-y-1.5">
          <legend className="text-xs text-muted-foreground">Evidence</legend>
          {!clientCaseId ? (
            <p className="text-xs text-muted-foreground">
              This stream is not linked to a client yet, so there is no client evidence to cite.
            </p>
          ) : evidenceQuery.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading the client's evidence...</p>
          ) : evidenceQuery.error ? (
            <p role="alert" className="text-xs text-destructive">
              {errorText(evidenceQuery.error) ?? "Could not load the client's evidence."}
            </p>
          ) : (evidenceQuery.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">The client has no evidence filed yet.</p>
          ) : (
            <ul className="space-y-1">
              {(evidenceQuery.data ?? []).map((item) => (
                <li key={item.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={draft.evidenceIds.includes(item.id)}
                      onChange={(event) => toggleEvidence(item.id, event.target.checked)}
                    />
                    <span className="min-w-0 truncate">{item.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{item.typeLabel}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        {shownError ? (
          <p role="alert" className="text-xs text-destructive">
            {shownError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={proposeMutation.isPending}>
            {proposeMutation.isPending ? "Proposing..." : "Propose"}
          </Button>
          {draft.supersedes ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(emptyDraft(draft.streamCaseId))}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

function FindingRow({
  finding,
  busy,
  onDecide,
  onShare,
  onReplace,
}: {
  finding: DeepDiveFinding;
  busy: boolean;
  onDecide: (finding: DeepDiveFinding, decision: "validated" | "rejected") => void;
  onShare: (finding: DeepDiveFinding, visibility: DeepDiveVisibility) => void;
  onReplace: (finding: DeepDiveFinding) => void;
}) {
  const next = deepDiveFindingNextSteps(finding.status);
  const closed = finding.status === "superseded" || finding.status === "rejected";
  return (
    <li className="space-y-1.5 px-3 py-2.5" data-deep-dive-finding={finding.id} data-status={finding.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={STATUS_TONE[finding.status]} label={DEEP_DIVE_FINDING_LABELS[finding.status]} />
          <span className="text-xs text-muted-foreground">{GIF_LABEL.get(finding.gifKey)}</span>
        </div>
        <select
          aria-label="Visibility"
          className={SELECT_CLASS}
          value={finding.visibility}
          disabled={busy}
          onChange={(event) => onShare(finding, event.target.value as DeepDiveVisibility)}
        >
          {DEEP_DIVE_VISIBILITIES.map((value) => (
            <option key={value} value={value}>
              {DEEP_DIVE_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <p className={closed ? "text-sm text-muted-foreground line-through decoration-muted-foreground/40" : "text-sm"}>
        {finding.statement}
      </p>
      {finding.evidence.length > 0 ? (
        <p className="text-xs text-muted-foreground">Evidence: {finding.evidence.map((item) => item.title).join(", ")}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Proposed by {finding.proposedByAgentId ? "an agent" : "a person"} on {formatShortDate(finding.createdAt)}
          {finding.supersedesFindingId ? ", replacing an earlier finding" : ""}
          {finding.status === "superseded" ? ". Replaced by a newer finding" : ""}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {next.decide ? (
            <>
              <Button type="button" size="xs" disabled={busy} onClick={() => onDecide(finding, "validated")}>
                Validate
              </Button>
              <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => onDecide(finding, "rejected")}>
                Reject
              </Button>
            </>
          ) : null}
          {next.supersede ? (
            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => onReplace(finding)}>
              Replace
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function DeepDiveFindings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: "Deep Dive", href: "/deep-dive" }, { label: "Findings" }]);
  }, [setBreadcrumbs]);

  const casesQuery = useQuery({
    queryKey: [...queryKeys.cases.list(companyId), "deep-dive"],
    queryFn: () => casesApi.list(companyId, { types: [DEEP_DIVE_CASE_TYPES.record, DEEP_DIVE_CASE_TYPES.stream], limit: 200 }),
    enabled: !!selectedCompanyId,
  });
  const findingsQuery = useQuery({
    queryKey: deepDiveFindingsQueryKeys.list(companyId),
    queryFn: () => deepDiveFindingsApi.list(companyId),
    enabled: !!selectedCompanyId,
  });
  const streams = useMemo(() => findingStreams(casesQuery.data ?? []), [casesQuery.data]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const currentDraft = draft ?? (streams[0] ? emptyDraft(streams[0].row.id) : null);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: deepDiveFindingsQueryKeys.list(companyId) });
  }

  const decideMutation = useMutation({
    mutationFn: ({ finding, decision }: { finding: DeepDiveFinding; decision: "validated" | "rejected" }) =>
      deepDiveFindingsApi.decide(finding.id, decision),
    onSettled: refresh,
  });
  const shareMutation = useMutation({
    mutationFn: ({ finding, visibility }: { finding: DeepDiveFinding; visibility: DeepDiveVisibility }) =>
      deepDiveFindingsApi.setVisibility(finding.id, visibility),
    onSettled: refresh,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Lightbulb} message="Select a company to see its findings." />;
  }
  if (casesQuery.isLoading || findingsQuery.isLoading) return <PageSkeleton variant="list" />;
  const loadError = errorText(casesQuery.error) ?? errorText(findingsQuery.error);
  if (loadError) return <p className="text-sm text-destructive">{loadError}</p>;

  if (streams.length === 0 || !currentDraft) {
    return (
      <EmptyState
        icon={Lightbulb}
        title="No Investigation Streams yet"
        message="Start the deep dive record first. Every finding sits in one GIF cell of a stream."
      />
    );
  }

  const findings = findingsQuery.data ?? [];
  const actionError = errorText(decideMutation.error) ?? errorText(shareMutation.error);
  const busy = decideMutation.isPending || shareMutation.isPending;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold">Findings</h1>
          <Link to="/deep-dive" className="text-xs font-medium underline-offset-4 hover:underline">
            Back to the Deep Dive
          </Link>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          A person or an agent proposes a finding; a person validates it. A finding is never edited: replace it with a
          new one, and the old one stays on record as Superseded. Every finding starts Internal.
        </p>
      </header>

      <ProposeForm
        companyId={companyId}
        streams={streams}
        draft={currentDraft}
        onChange={setDraft}
        onDone={async () => {
          setDraft(emptyDraft(currentDraft.streamCaseId));
          await refresh();
        }}
      />

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No findings yet.</p>
      ) : (
        streams.map((stream) => {
          const own = findings.filter((finding) => finding.streamCaseId === stream.row.id);
          if (own.length === 0) return null;
          const headingId = `deep-dive-findings-${stream.key}`;
          return (
            <section key={stream.key} aria-labelledby={headingId} className="rounded-lg border border-border">
              <h2 id={headingId} className="border-b border-border px-3 py-2 text-sm font-semibold">
                {stream.label}
              </h2>
              <ul className="divide-y divide-border">
                {own.map((finding) => (
                  <FindingRow
                    key={finding.id}
                    finding={finding}
                    busy={busy}
                    onDecide={(target, decision) => decideMutation.mutate({ finding: target, decision })}
                    onShare={(target, visibility) => shareMutation.mutate({ finding: target, visibility })}
                    onReplace={(target) => {
                      setDraft({
                        streamCaseId: target.streamCaseId,
                        gifKey: target.gifKey,
                        statement: target.statement,
                        evidenceIds: target.evidence.map((item) => item.id),
                        supersedes: target,
                      });
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
