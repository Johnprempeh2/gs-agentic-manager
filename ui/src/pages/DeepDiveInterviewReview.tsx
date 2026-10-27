import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_GIF,
  DEEP_DIVE_PROPOSAL_BECOMES_LABELS,
  DEEP_DIVE_PROPOSAL_DEFAULT_GIF,
  DEEP_DIVE_PROPOSAL_LABELS,
  DEEP_DIVE_RELEASE_MAX_HEADLINE,
  deepDiveProposalBecomes,
  type DeepDiveGifKey,
  type DeepDiveInterviewProposal,
  type DeepDiveInterviewReleaseView,
  type DeepDiveInterviewRound,
  type DeepDiveProposalKind,
  type DeepDiveProposalRecordType,
} from "@greatstone/shared";
import { casesApi } from "@/api/cases";
import { deepDiveBoardsQueryKeys, deepDiveOrgApi } from "@/api/deepDiveBoards";
import { deepDiveFindingsQueryKeys } from "@/api/deepDiveFindings";
import { deepDiveInterviewsApi, deepDiveInterviewsQueryKeys } from "@/api/deepDiveInterviews";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/StatusBadge";
import { findingStreams, type StreamOption } from "./DeepDiveFindings";

// Synthesis review (GRE-2756) and release (GRE-2667), below the progress. An
// agent proposes the round's synthesis; a person accepts or rejects each
// theme, quote and person here. Accepting makes the item's Deep Dive record,
// Internal. Release sends only the accepted themes and quotes to the client's
// website; withdraw takes them away at once. Names come live from the
// website: GSAM's proposals hold only ids.

const PROPOSAL_TONE = { proposed: "pending", accepted: "succeeded", rejected: "archived" } as const;
const GROUPS: { kind: Exclude<DeepDiveProposalKind, "quote">; title: string }[] = [
  { kind: "pain", title: "Pains" },
  { kind: "process", title: "Processes" },
  { kind: "finding", title: "Findings" },
  { kind: "person", title: "People and roles" },
];
const RECORD_LINK: Record<DeepDiveProposalRecordType, { to: string; label: string }> = {
  finding: { to: "/deep-dive/findings", label: "Open the findings" },
  process: { to: "/deep-dive/processes", label: "Open the process board" },
  person: { to: "/deep-dive/organisation", label: "Open the organisation board" },
};

function errorText(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

interface Lookups {
  teamName: (unitId: string | null) => string | null;
  personName: (employeeId: string | null) => string | null;
  streams: StreamOption[];
}

function Provenance({ proposal }: { proposal: DeepDiveInterviewProposal }) {
  const interviews = new Set(proposal.sources.map((s) => s.interviewId)).size;
  return (
    <p className="text-xs text-muted-foreground">
      From {plural(interviews, "interview")} · rules {proposal.rulesVersion} · proposed {formatDateTime(proposal.createdAt)}
      {proposal.decidedAt ? ` · ${DEEP_DIVE_PROPOSAL_LABELS[proposal.status].toLowerCase()} ${formatDateTime(proposal.decidedAt)}` : ""}
    </p>
  );
}

function Decision({ proposal, roundId, companyId, streams, parentRejected }: {
  proposal: DeepDiveInterviewProposal;
  roundId: string;
  companyId: string;
  streams: StreamOption[];
  parentRejected?: boolean;
}) {
  const queryClient = useQueryClient();
  const becomes = deepDiveProposalBecomes(proposal.kind);
  // The streams may load after the card: until the person picks one, the first stream.
  const [picked, setStreamCaseId] = useState("");
  const streamCaseId = streams.some((stream) => stream.row.id === picked) ? picked : streams[0]?.row.id ?? "";
  const [gifKey, setGifKey] = useState<DeepDiveGifKey>(DEEP_DIVE_PROPOSAL_DEFAULT_GIF);
  const decide = useMutation({
    mutationFn: (decision: "accepted" | "rejected") =>
      deepDiveInterviewsApi.decide(proposal.id, becomes === "finding" && decision === "accepted" ? { decision, streamCaseId, gifKey } : { decision }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: deepDiveInterviewsQueryKeys.proposals(roundId) }),
        queryClient.invalidateQueries({ queryKey: deepDiveInterviewsQueryKeys.release(roundId) }),
        queryClient.invalidateQueries({ queryKey: deepDiveFindingsQueryKeys.list(companyId) }),
        queryClient.invalidateQueries({ queryKey: deepDiveBoardsQueryKeys.organisation(companyId) }),
        queryClient.invalidateQueries({ queryKey: deepDiveBoardsQueryKeys.process(companyId) }),
      ]);
    },
  });

  if (proposal.status !== "proposed") {
    const link = proposal.record ? RECORD_LINK[proposal.record.type] : null;
    return link && proposal.record?.id ? (
      <p className="text-xs">
        Now {DEEP_DIVE_PROPOSAL_BECOMES_LABELS[proposal.record.type]}.{" "}
        <Link to={link.to} className="font-medium underline-offset-4 hover:underline">{link.label}</Link>
      </p>
    ) : null;
  }
  const needsStream = becomes === "finding";
  const noStream = needsStream && streams.length === 0;
  return (
    <div className="space-y-2">
      {needsStream && !noStream ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Investigation Stream</span>
            <NativeSelect value={streamCaseId} onChange={(event) => setStreamCaseId(event.target.value)}>
              {streams.map((stream) => (
                <option key={stream.row.id} value={stream.row.id}>{stream.label}</option>
              ))}
            </NativeSelect>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">GIF cell</span>
            <NativeSelect value={gifKey} onChange={(event) => setGifKey(event.target.value as DeepDiveGifKey)}>
              {DEEP_DIVE_GIF.map((gif) => (
                <option key={gif.key} value={gif.key}>{gif.label}</option>
              ))}
            </NativeSelect>
          </label>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="xs"
          disabled={decide.isPending || noStream || parentRejected}
          onClick={() => decide.mutate("accepted")}
        >
          Accept
        </Button>
        <Button type="button" size="xs" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate("rejected")}>
          Reject
        </Button>
        <span className="text-xs text-muted-foreground">
          {noStream
            ? "Start the deep dive record first: a finding sits in one stream."
            : parentRejected
              ? "Its theme was rejected."
              : `Accepting makes ${DEEP_DIVE_PROPOSAL_BECOMES_LABELS[becomes]}, Internal.`}
        </span>
      </div>
      {decide.error ? <p role="alert" className="text-xs text-destructive">{errorText(decide.error)}</p> : null}
    </div>
  );
}

function QuoteRow({ quote, parent, roundId, companyId, lookups }: {
  quote: DeepDiveInterviewProposal;
  parent: DeepDiveInterviewProposal;
  roundId: string;
  companyId: string;
  lookups: Lookups;
}) {
  // An anonymous quote shows no person, not even a team.
  const who = quote.anonymous ? "Anonymous" : lookups.personName(quote.websiteEmployeeId) ?? "Name not on the website";
  return (
    <li className="space-y-2 border-l-2 border-border py-1 pl-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <blockquote className="min-w-0 flex-1 break-words text-sm">“{quote.statement}”</blockquote>
        <StatusBadge status={PROPOSAL_TONE[quote.status]} label={DEEP_DIVE_PROPOSAL_LABELS[quote.status]} />
      </div>
      <p className="text-xs text-muted-foreground">{who}</p>
      <Decision
        proposal={quote}
        roundId={roundId}
        companyId={companyId}
        streams={lookups.streams}
        parentRejected={parent.status === "rejected"}
      />
    </li>
  );
}

function ProposalCard({ proposal, quotes, roundId, companyId, lookups }: {
  proposal: DeepDiveInterviewProposal;
  quotes: DeepDiveInterviewProposal[];
  roundId: string;
  companyId: string;
  lookups: Lookups;
}) {
  const team = lookups.teamName(proposal.unitId);
  const person = proposal.kind === "person";
  const title = person ? lookups.personName(proposal.websiteEmployeeId) ?? "Name not on the website" : proposal.statement;
  const detail = person
    ? [proposal.statement, team].filter(Boolean).join(" · ")
    : [
        proposal.label && proposal.label !== proposal.statement ? `“${proposal.label}”` : null,
        `${plural(proposal.voices, "voice")}, ${proposal.firstHandVoices} first-hand`,
        team ?? "Across teams",
      ].filter(Boolean).join(" · ");
  return (
    <Card className="gap-3 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="break-words text-sm font-medium">{title}</p>
          <p className="break-words text-xs text-muted-foreground">{detail}</p>
          <Provenance proposal={proposal} />
        </div>
        <StatusBadge status={PROPOSAL_TONE[proposal.status]} label={DEEP_DIVE_PROPOSAL_LABELS[proposal.status]} />
      </div>
      <Decision proposal={proposal} roundId={roundId} companyId={companyId} streams={lookups.streams} />
      {quotes.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium">Quotes as evidence</p>
          <ul className="space-y-3">
            {quotes.map((quote) => (
              <QuoteRow key={quote.id} quote={quote} parent={proposal} roundId={roundId} companyId={companyId} lookups={lookups} />
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function ReleasePanel({ view, roundId }: { view: DeepDiveInterviewReleaseView; roundId: string }) {
  const queryClient = useQueryClient();
  const [headline, setHeadline] = useState("");
  const onSuccess = (next: DeepDiveInterviewReleaseView) => queryClient.setQueryData(deepDiveInterviewsQueryKeys.release(roundId), next);
  const release = useMutation({ mutationFn: () => deepDiveInterviewsApi.releaseSynthesis(roundId, { headline: headline.trim() }), onSuccess });
  const withdraw = useMutation({ mutationFn: () => deepDiveInterviewsApi.withdrawSynthesis(roundId), onSuccess });
  const { readiness, released } = view;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (headline.trim()) release.mutate();
  }

  return (
    <Card className="gap-3 px-4 py-3" aria-labelledby="interview-release">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="interview-release" className="text-sm font-semibold">Release to the client</h3>
        <StatusBadge status={released ? "succeeded" : "pending"} label={released ? "Released" : "Not released"} />
      </div>
      <p className="text-xs text-muted-foreground" data-testid="interview-client-sees">
        {released
          ? `The client sees the synthesis released ${released.releasedAt ? formatDateTime(released.releasedAt) : "earlier"}.`
          : "The client sees no synthesis yet."}{" "}
        Release sends {plural(readiness.themes, "accepted theme")} and {plural(readiness.quotes, "accepted quote")}. People and roles never leave
        GSAM.
      </p>
      {readiness.blockers.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-xs">
          {readiness.blockers.map((blocker) => (
            <li key={blocker.code}>{blocker.message}</li>
          ))}
        </ul>
      ) : null}
      <form className="space-y-2" onSubmit={submit}>
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Headline</span>
          <span className="block">The one line the client reads first.</span>
          <Textarea
            rows={2}
            maxLength={DEEP_DIVE_RELEASE_MAX_HEADLINE}
            value={headline}
            onChange={(event) => setHeadline(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={!readiness.ready || !headline.trim() || release.isPending}>
            {release.isPending ? "Releasing..." : released ? "Release again" : "Release"}
          </Button>
          {released ? (
            <Button type="button" size="sm" variant="outline" disabled={withdraw.isPending} onClick={() => withdraw.mutate()}>
              {withdraw.isPending ? "Withdrawing..." : "Withdraw"}
            </Button>
          ) : null}
        </div>
      </form>
      {release.error || withdraw.error ? (
        <p role="alert" className="text-xs text-destructive">{errorText(release.error) ?? errorText(withdraw.error)}</p>
      ) : null}
    </Card>
  );
}

/** Below the progress, once the round is open: review the synthesis, then release it. */
export function InterviewReview({ round, companyId }: { round: DeepDiveInterviewRound; companyId: string }) {
  const proposals = useQuery({
    queryKey: deepDiveInterviewsQueryKeys.proposals(round.id),
    queryFn: () => deepDiveInterviewsApi.proposals(round.id),
  });
  const release = useQuery({
    queryKey: deepDiveInterviewsQueryKeys.release(round.id),
    queryFn: () => deepDiveInterviewsApi.release(round.id),
  });
  // Shared with the progress panel: names are read live from the website.
  const progress = useQuery({
    queryKey: deepDiveInterviewsQueryKeys.progress(companyId),
    queryFn: () => deepDiveInterviewsApi.progress(companyId),
  });
  const board = useQuery({ queryKey: deepDiveBoardsQueryKeys.organisation(companyId), queryFn: () => deepDiveOrgApi.get(companyId) });
  const cases = useQuery({
    queryKey: [...queryKeys.cases.list(companyId), "deep-dive"],
    queryFn: () => casesApi.list(companyId, { types: [DEEP_DIVE_CASE_TYPES.record, DEEP_DIVE_CASE_TYPES.stream], limit: 200 }),
  });

  const all = proposals.data?.proposals ?? [];
  const lookups: Lookups = {
    teamName: (unitId) => (unitId ? board.data?.units.find((u) => u.id === unitId)?.name ?? null : null),
    personName: (employeeId) => (employeeId ? progress.data?.people.find((p) => p.websiteEmployeeId === employeeId)?.name || null : null),
    streams: findingStreams(cases.data ?? []),
  };
  const waiting = all.filter((p) => p.status === "proposed").length;

  return (
    <section className="space-y-3" aria-labelledby="interview-review">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="interview-review" className="text-sm font-semibold">Synthesis review</h2>
        {all.length > 0 ? (
          <span className="text-xs text-muted-foreground">{waiting > 0 ? `${waiting} to decide` : "All decided"}</span>
        ) : null}
      </div>
      {proposals.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading the synthesis...</p>
      ) : proposals.error ? (
        <Card className="gap-2 px-4 py-3">
          <p role="alert" className="text-xs text-destructive">{errorText(proposals.error)}</p>
          <Button type="button" size="xs" variant="outline" className="self-start" onClick={() => void proposals.refetch()}>
            Try again
          </Button>
        </Card>
      ) : all.length === 0 ? (
        <Card className="px-4 py-3">
          <p className="text-xs text-muted-foreground">
            No synthesis yet. Once interviews are in, an agent proposes the themes, quotes and roles here for you to accept or reject.
          </p>
        </Card>
      ) : (
        <>
          <p className="max-w-3xl text-xs text-muted-foreground">
            Each item is proposed and Internal. Accepting puts it in the Deep Dive: a pain or a finding becomes a proposed finding, a
            process a process candidate, a person goes on the organisation board, and a quote becomes evidence for its theme.
          </p>
          {GROUPS.map((group) => {
            const items = all.filter((p) => p.kind === group.kind);
            if (items.length === 0) return null;
            return (
              <div key={group.kind} className="space-y-2">
                <h3 className="text-xs font-semibold text-muted-foreground">{group.title}</h3>
                {items.map((item) => (
                  <ProposalCard
                    key={item.id}
                    proposal={item}
                    quotes={all.filter((q) => q.kind === "quote" && q.parentId === item.id)}
                    roundId={round.id}
                    companyId={companyId}
                    lookups={lookups}
                  />
                ))}
              </div>
            );
          })}
        </>
      )}
      {release.data ? (
        <ReleasePanel view={release.data} roundId={round.id} />
      ) : release.error ? (
        <p role="alert" className="text-xs text-destructive">Could not read what the client sees: {errorText(release.error)}</p>
      ) : null}
    </section>
  );
}
