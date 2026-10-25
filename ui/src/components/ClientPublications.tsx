import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Copy, Link2, ShieldCheck } from "lucide-react";
import {
  CLIENT_PUBLICATION_GATE_MESSAGES,
  CLIENT_PUBLICATION_STATUS_LABELS,
  type ClientPublication,
  type ClientPublicationGateCode,
  type ClientPublicationsResponse,
  type EngagementTimeline,
} from "@greatstone/shared";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { clientPublicationsApi } from "../api/clientPublications";
import { pipelinesApi } from "../api/pipelines";
import { useToastActions } from "../context/ToastContext";
import { copyTextToClipboard } from "../lib/clipboard";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDate } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";

// Clients > Deliverables publishing (GRE-2373). A deliverable filed under a
// stage is sent for approval to a registered approver, approved by that
// person only, published once the NDA and engagement allow it, then shared
// with the client, who accepts it and gets a receipt. Every step shows in the
// audit under each deliverable.

function day(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDate(date) : value;
}

export type PublicationNextStep =
  | { kind: "submit" }
  | { kind: "approve" }
  | { kind: "waiting_for_approver"; approverName: string | null }
  | { kind: "publish" }
  | { kind: "blocked"; gates: ClientPublicationGateCode[] }
  | { kind: "share" }
  | { kind: "resend_receipt" }
  | { kind: "done" };

/** What the person looking at a publication can do next. */
export function publicationNextStep(
  publication: Pick<ClientPublication, "status" | "approverUserId" | "approverName" | "receipt">,
  context: { currentUserId: string | null; gates: ClientPublicationGateCode[] },
): PublicationNextStep {
  switch (publication.status) {
    case "draft":
      return { kind: "submit" };
    case "pending_approval":
      return context.currentUserId && context.currentUserId === publication.approverUserId
        ? { kind: "approve" }
        : { kind: "waiting_for_approver", approverName: publication.approverName };
    case "approved":
      return context.gates.length > 0 ? { kind: "blocked", gates: context.gates } : { kind: "publish" };
    case "published":
      return { kind: "share" };
    case "accepted":
      return publication.receipt.status === "sent" ? { kind: "done" } : { kind: "resend_receipt" };
    default:
      return { kind: "done" };
  }
}

const STATUS_TONE: Record<ClientPublication["status"], string> = {
  draft: "border-border text-muted-foreground",
  pending_approval: "border-status-warning/40 bg-status-warning-soft text-status-warning-foreground",
  approved: "border-primary/40 text-foreground",
  published: "border-primary bg-primary/10 text-foreground",
  accepted: "border-status-success/40 text-status-success",
  withdrawn: "border-border text-muted-foreground line-through",
};

const ACTION_LABELS: Record<string, string> = {
  created: "Draft started",
  submitted: "Sent for approval",
  approved: "Approved",
  rejected: "Sent back",
  published: "Published",
  acceptance_link_created: "Client link made",
  accepted: "Accepted by the client",
  receipt_sent: "Receipt sent",
  receipt_failed: "Receipt failed",
  receipt_not_configured: "Receipt not sent",
  withdrawn: "Withdrawn",
};

function receiptLine(publication: ClientPublication) {
  const { receipt } = publication;
  if (receipt.status === "sent") return `Receipt sent to ${publication.acceptedEmail} on ${day(receipt.sentAt)}.`;
  if (receipt.status === "not_sent") return null;
  return `Receipt not sent: ${receipt.error ?? "unknown reason"}`;
}

function ReasonForm({ label, onSubmit, pending }: { label: string; onSubmit: (reason: string) => void; pending: boolean }) {
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim()) onSubmit(reason.trim());
      }}
    >
      <Input aria-label={`${label}: reason`} placeholder="Reason" value={reason} onChange={(event) => setReason(event.target.value)} className="h-8 max-w-xs" />
      <Button type="submit" size="sm" variant="outline" disabled={!reason.trim() || pending}>{label}</Button>
    </form>
  );
}

function PublicationRow({
  publication,
  data,
  currentUserId,
  refresh,
}: {
  publication: ClientPublication;
  data: ClientPublicationsResponse;
  currentUserId: string | null;
  refresh: () => void;
}) {
  const { pushToast } = useToastActions();
  const [approverUserId, setApproverUserId] = useState(data.approvers[0]?.userId ?? "");
  const [shownLink, setShownLink] = useState<string | null>(null);
  const [closing, setClosing] = useState<"withdraw" | "reject" | null>(null);
  const step = publicationNextStep(publication, { currentUserId, gates: data.gates });
  const act = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: () => {
      setClosing(null);
      refresh();
    },
    onError: (error) => pushToast({ title: error instanceof Error ? error.message : "That did not work", tone: "error" }),
  });
  const makeLink = useMutation({
    mutationFn: () => clientPublicationsApi.createLink(publication.id),
    onSuccess: (result) => {
      setShownLink(result.url);
      refresh();
    },
    onError: (error) => pushToast({ title: error instanceof Error ? error.message : "Could not make the link", tone: "error" }),
  });
  const receipt = receiptLine(publication);
  const stale = publication.status !== "draft" && publication.latestVersion !== null && publication.version !== null
    && publication.latestVersion > publication.version;

  return (
    <li className="space-y-2 py-3" data-testid={`client-publication-${publication.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {publication.contentPath || publication.url ? (
            <a href={publication.contentPath ?? publication.url ?? undefined} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {publication.title}
            </a>
          ) : publication.title}
          {publication.version ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">v{publication.version}</span> : null}
        </span>
        <span className={cn("rounded-sm border px-1.5 py-0.5 text-xs", STATUS_TONE[publication.status])}>
          {CLIENT_PUBLICATION_STATUS_LABELS[publication.status]}
        </span>
      </div>

      {stale ? (
        <p className="text-xs text-muted-foreground">
          Version {publication.latestVersion} exists. This one stays frozen at version {publication.version}; withdraw it and start again to publish the newer one.
        </p>
      ) : null}
      {publication.rejectedReason && publication.status === "draft" ? (
        <p className="text-xs text-muted-foreground">Sent back: {publication.rejectedReason}</p>
      ) : null}
      {publication.status === "accepted" ? (
        <p className="text-xs text-muted-foreground">
          Accepted by {[publication.acceptedName, publication.acceptedRole].filter(Boolean).join(", ")} ({publication.acceptedEmail}) on {day(publication.acceptedAt)}.
        </p>
      ) : null}
      {receipt ? (
        <p className={cn("text-xs", publication.receipt.status === "sent" ? "text-muted-foreground" : "text-destructive")} role={publication.receipt.status === "sent" ? undefined : "alert"}>
          {receipt}
        </p>
      ) : null}
      {publication.status === "withdrawn" ? (
        <p className="text-xs text-muted-foreground">Withdrawn {day(publication.withdrawnAt)}: {publication.withdrawnReason}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {step.kind === "submit" ? (
          data.approvers.length > 0 ? (
            <>
              <NativeSelect
                aria-label="Approver"
                value={approverUserId}
                onChange={(event) => setApproverUserId(event.target.value)}
                className="h-8 w-auto"
              >
                {data.approvers.map((approver) => (
                  <option key={approver.id} value={approver.userId}>{approver.name ?? approver.email ?? approver.userId}</option>
                ))}
              </NativeSelect>
              <Button size="sm" disabled={!approverUserId || act.isPending} onClick={() => act.mutate(() => clientPublicationsApi.submit(publication.id, approverUserId))}>
                Send for approval
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">Register an approver below before sending this for approval.</span>
          )
        ) : null}
        {step.kind === "approve" ? (
          <>
            <Button size="sm" disabled={act.isPending} onClick={() => act.mutate(() => clientPublicationsApi.approve(publication.id))}>
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Approve version {publication.version}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setClosing(closing === "reject" ? null : "reject")}>Send back</Button>
          </>
        ) : null}
        {step.kind === "waiting_for_approver" ? (
          <span className="text-xs text-muted-foreground">Waiting for {step.approverName ?? "the approver"} to approve.</span>
        ) : null}
        {step.kind === "publish" ? (
          <Button size="sm" disabled={act.isPending} onClick={() => act.mutate(() => clientPublicationsApi.publish(publication.id))}>
            Publish to the client
          </Button>
        ) : null}
        {step.kind === "blocked" ? (
          <span className="text-xs text-muted-foreground">{CLIENT_PUBLICATION_GATE_MESSAGES[step.gates[0]!]}.</span>
        ) : null}
        {step.kind === "share" ? (
          <Button size="sm" variant="outline" disabled={makeLink.isPending} onClick={() => makeLink.mutate()}>
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
            {publication.acceptanceLink ? "Make a new client link" : "Make the client link"}
          </Button>
        ) : null}
        {step.kind === "resend_receipt" ? (
          <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate(() => clientPublicationsApi.resendReceipt(publication.id))}>
            Send the receipt again
          </Button>
        ) : null}
        {publication.status !== "accepted" && publication.status !== "withdrawn" ? (
          <Button size="sm" variant="ghost" onClick={() => setClosing(closing === "withdraw" ? null : "withdraw")}>Withdraw</Button>
        ) : null}
      </div>

      {publication.status === "published" && publication.acceptanceLink && !shownLink ? (
        <p className="text-xs text-muted-foreground">
          {publication.acceptanceLink.expired
            ? `The client link expired on ${day(publication.acceptanceLink.expiresAt)}. Make a new one to send.`
            : `A client link was made on ${day(publication.acceptanceLink.createdAt)} and works until ${day(publication.acceptanceLink.expiresAt)}.`}
        </p>
      ) : null}
      {shownLink ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-xs">
          <span className="text-muted-foreground">Send this link to the client. It is shown only once:</span>
          <code className="min-w-0 flex-1 truncate">{shownLink}</code>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await copyTextToClipboard(shownLink);
                pushToast({ title: "Link copied", body: "Paste it into your email to the client.", tone: "success" });
              } catch {
                pushToast({ title: "Could not copy the link", body: "Select it and copy it by hand.", tone: "error" });
              }
            }}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            Copy
          </Button>
        </div>
      ) : null}

      {closing === "reject" ? (
        <ReasonForm label="Send back" pending={act.isPending} onSubmit={(reason) => act.mutate(() => clientPublicationsApi.reject(publication.id, reason))} />
      ) : null}
      {closing === "withdraw" ? (
        <ReasonForm label="Withdraw" pending={act.isPending} onSubmit={(reason) => act.mutate(() => clientPublicationsApi.withdraw(publication.id, reason))} />
      ) : null}

      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" aria-hidden="true" />
          Audit ({publication.events.length})
        </summary>
        <ol className="mt-1 space-y-1 border-l border-border pl-3">
          {publication.events.map((event) => (
            <li key={event.id} className="text-xs">
              <span className="text-foreground">{ACTION_LABELS[event.action] ?? event.action}</span>
              <span className="text-muted-foreground">
                {" "}· {event.actorName ?? (event.actorType === "client" ? "the client" : event.actorType)} · {day(event.createdAt)}
              </span>
              {event.fingerprint ? (
                <span className="block truncate font-mono text-(length:--text-micro) text-muted-foreground" title={event.fingerprint}>
                  {event.fingerprint}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

function Approvers({ caseId, companyId, data, refresh }: { caseId: string; companyId: string | null; data: ClientPublicationsResponse; refresh: () => void }) {
  const { pushToast } = useToastActions();
  const [userId, setUserId] = useState("");
  const members = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId ?? ""),
    queryFn: () => accessApi.listMembers(companyId!),
    enabled: Boolean(companyId),
    retry: false,
  });
  const registered = new Set(data.approvers.map((approver) => approver.userId));
  const candidates = (members.data?.members ?? [])
    .filter((member) => member.status === "active" && !registered.has(member.principalId));
  const change = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: () => {
      setUserId("");
      refresh();
    },
    onError: (error) => pushToast({ title: error instanceof Error ? error.message : "That did not work", tone: "error" }),
  });
  return (
    <div className="space-y-2 py-3">
      <h3 className="text-xs font-semibold text-foreground">Registered approvers</h3>
      {data.approvers.length === 0 ? (
        <p className="text-xs text-muted-foreground">No approver yet. Only a registered approver can approve this client's deliverables.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {data.approvers.map((approver) => (
            <li key={approver.id} className="flex items-center gap-1 rounded-sm border border-border px-2 py-0.5 text-xs">
              {approver.name ?? approver.email ?? approver.userId}
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${approver.name ?? approver.userId}`}
                onClick={() => change.mutate(() => clientPublicationsApi.removeApprover(caseId, approver.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect aria-label="Add an approver" value={userId} onChange={(event) => setUserId(event.target.value)} className="h-8 w-auto">
            <option value="">Choose a person</option>
            {candidates.map((member) => (
              <option key={member.id} value={member.principalId}>{member.user?.name ?? member.user?.email ?? member.principalId}</option>
            ))}
          </NativeSelect>
          <Button size="sm" variant="outline" disabled={!userId || change.isPending} onClick={() => change.mutate(() => clientPublicationsApi.registerApprover(caseId, userId))}>
            Add approver
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ClientPublications({ caseId, companyId }: { caseId: string; companyId: string | null }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [stageLinkId, setStageLinkId] = useState("");
  const publications = useQuery({
    queryKey: queryKeys.pipelines.casePublications(caseId),
    queryFn: () => clientPublicationsApi.list(caseId),
  });
  const journey = useQuery({
    queryKey: queryKeys.pipelines.caseJourney(caseId),
    queryFn: () => pipelinesApi.getCaseJourney(caseId),
  });
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const currentUserId = session.data?.user.id ?? session.data?.session.userId ?? null;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.casePublications(caseId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseTimeline(caseId) });
  };
  const start = useMutation({
    mutationFn: () => clientPublicationsApi.create(caseId, stageLinkId),
    onSuccess: () => {
      setStageLinkId("");
      refresh();
    },
    onError: (error) => pushToast({ title: error instanceof Error ? error.message : "Could not start the draft", tone: "error" }),
  });

  if (publications.isLoading) return <p className="py-3 text-sm text-muted-foreground">Loading deliverables...</p>;
  if (publications.error || !publications.data) {
    return <p className="py-3 text-sm text-destructive" role="alert">Could not load the deliverables. Reload the page to try again.</p>;
  }
  const data = publications.data;
  const live = new Set(
    data.publications.filter((row) => row.status !== "withdrawn").map((row) => `${row.deliverableIssueId}:${row.deliverableKey}`),
  );
  const filed = (journey.data?.stages ?? []).flatMap((stage) =>
    stage.deliverables
      .filter((item) => !live.has(`${item.deliverable.issue.id}:${item.deliverable.key}`))
      .map((item) => ({ linkId: item.linkId, label: `${item.deliverable.title} (${stage.name})` })),
  );

  return (
    <div className="divide-y divide-border">
      {data.gates.length > 0 ? (
        <ul className="space-y-1 py-3 text-xs text-muted-foreground">
          {data.gates.map((gate) => <li key={gate}>{CLIENT_PUBLICATION_GATE_MESSAGES[gate]}.</li>)}
        </ul>
      ) : null}
      {!data.receiptSenderConfigured ? (
        <p className="py-3 text-xs text-muted-foreground">
          Receipts cannot be sent yet: the company secret "client-receipts-resend" needs a Resend sending-only key.
        </p>
      ) : null}

      {data.publications.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">Nothing is being published to this client yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.publications.map((publication) => (
            <PublicationRow key={publication.id} publication={publication} data={data} currentUserId={currentUserId} refresh={refresh} />
          ))}
        </ul>
      )}

      {filed.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 py-3">
          <NativeSelect aria-label="Deliverable to publish" value={stageLinkId} onChange={(event) => setStageLinkId(event.target.value)} className="h-8 w-auto max-w-full">
            <option value="">Choose a filed deliverable</option>
            {filed.map((item) => <option key={item.linkId} value={item.linkId}>{item.label}</option>)}
          </NativeSelect>
          <Button size="sm" variant="outline" disabled={!stageLinkId || start.isPending} onClick={() => start.mutate()}>
            Start a draft
          </Button>
        </div>
      ) : null}

      <Approvers caseId={caseId} companyId={companyId} data={data} refresh={refresh} />
    </div>
  );
}

/** The engagement timeline (screen 13): stage moves and milestones, read only from what is stored. */
export function EngagementTimelineView({ caseId }: { caseId: string }) {
  const timeline = useQuery({
    queryKey: queryKeys.pipelines.caseTimeline(caseId),
    queryFn: () => clientPublicationsApi.timeline(caseId),
  });
  if (timeline.isLoading) return <p className="py-3 text-sm text-muted-foreground">Loading the timeline...</p>;
  if (timeline.error || !timeline.data) {
    return <p className="py-3 text-sm text-destructive" role="alert">Could not load the timeline. Reload the page to try again.</p>;
  }
  const entries = timelineEntries(timeline.data);
  if (entries.length === 0) return <p className="py-3 text-sm text-muted-foreground">Nothing has happened with this client yet.</p>;
  return (
    <ol className="divide-y divide-border" aria-label="Engagement timeline">
      {entries.map((entry) => (
        <li key={entry.key} className="flex items-center justify-between gap-3 py-2 text-sm">
          <span className={entry.stage ? "font-medium text-foreground" : "text-foreground"}>
            {entry.label}
            {entry.current ? <span className="ml-1.5 text-xs text-muted-foreground">(now)</span> : null}
          </span>
          <time className="shrink-0 text-xs text-muted-foreground">{day(entry.at)}</time>
        </li>
      ))}
    </ol>
  );
}

/** Stage moves and milestones as one list, oldest first. */
export function timelineEntries(timeline: EngagementTimeline) {
  return [
    ...timeline.stages.map((stage, index) => ({
      key: `stage-${index}`,
      at: stage.enteredAt,
      label: `Entered ${stage.name}`,
      stage: true,
      current: stage.current,
    })),
    ...timeline.milestones.map((milestone, index) => ({
      key: `milestone-${index}`,
      at: milestone.at,
      label: milestone.label,
      stage: false,
      current: false,
    })),
  ].sort((left, right) => left.at.localeCompare(right.at));
}
