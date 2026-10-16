import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, FileCheck2, FileStack, FileUp, Globe, Package, Trash2 } from "lucide-react";
import type {
  ClientEvidenceItem,
  ClientJourneyStage,
  ClientJourneyStageDeliverable,
  ClientJourneyStageState,
  ClientNda,
  Deliverable,
  NdaStatus,
  UpdateClientJourneyDeliverable,
} from "@greatstone/shared";
import { pipelinesApi } from "../api/pipelines";
import { useToastActions } from "../context/ToastContext";
import { Link } from "@/lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDate } from "../lib/utils";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/native-select";
import { Textarea } from "./ui/textarea";
import { ToggleSwitch } from "./ui/toggle-switch";
import { ConfidentialityBadge } from "./deliverables/DeliverableBadges";
import { ClientUploadZone, formatFileSize } from "./PipelineCaseFiles";
import { ClientDocumentRequests } from "./ClientDocumentRequests";
import { FileDropArea } from "./FileDropArea";
import { ClientEngagementRow } from "./ClientEngagementRow";
import { ErrorState } from "./ErrorState";

// Client journey by stage (GRE-1473): each stage of the client's journey as a
// section with its standard templates and the deliverables filed under it, and
// a preview of what the client sees on its portal.

const STATE_LABEL: Record<ClientJourneyStageState, string> = {
  done: "Complete",
  current: "Now",
  next: "Not started",
  side: "Now",
};

function formatDay(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDate(date) : value;
}

function kindLabel(kind: Deliverable["kind"]) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function DeliverableTitle({ item }: { item: Deliverable }) {
  if (item.external && item.url) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-w-0 items-center gap-1 font-medium text-foreground hover:underline"
        title={`${item.title} (opens the site)`}
      >
        <span className="truncate">{item.title}</span>
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </a>
    );
  }
  return (
    <Link to={item.openPath} className="block truncate font-medium text-foreground hover:underline" title={item.title}>
      {item.title}
    </Link>
  );
}

function DeliverableMeta({ item }: { item: Deliverable }) {
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      <span>{kindLabel(item.kind)}</span>
      <ConfidentialityBadge value={item.confidentiality} />
      {item.status === "draft" ? <span className="font-medium text-foreground">Draft</span> : null}
      <span>{formatDay(item.updatedAt)}</span>
      <Link to={createIssueDetailPath(item.issue.identifier ?? item.issue.id)} className="text-foreground hover:underline" title={item.issue.title}>
        {item.issue.identifier ?? "Task"}
      </Link>
    </p>
  );
}

function StageDeliverableRow({
  row,
  stages,
  busy,
  onUpdate,
  onRemove,
}: {
  row: ClientJourneyStageDeliverable;
  stages: ClientJourneyStage[];
  busy: boolean;
  onUpdate: (patch: UpdateClientJourneyDeliverable) => void;
  onRemove: () => void;
}) {
  const item = row.deliverable;
  return (
    <li className="flex flex-col gap-2 py-2 text-sm sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Package className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <DeliverableTitle item={item} />
          <DeliverableMeta item={item} />
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-6 sm:pl-0">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ToggleSwitch
            checked={row.clientFacing}
            disabled={busy}
            aria-label={`Client can see ${item.title}`}
            onCheckedChange={(clientFacing) => onUpdate({ clientFacing })}
          />
          Client can see
        </label>
        <NativeSelect
          className="h-7 w-auto text-xs"
          aria-label={`Stage for ${item.title}`}
          value={row.stageId}
          disabled={busy}
          onChange={(event) => onUpdate({ stageId: event.target.value })}
        >
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>{stage.name}</option>
          ))}
        </NativeSelect>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          aria-label={`Take ${item.title} out of this stage`}
          title="Take out of this stage"
          disabled={busy}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

/** A file uploaded or filed under this stage, from the client's evidence. */
function StageFileRow({ item }: { item: ClientEvidenceItem }) {
  const external = item.kind === "link" || item.openPath.startsWith("/api/");
  const size = item.kind === "upload" ? formatFileSize(item.byteSize) : null;
  return (
    <li className="flex items-start gap-2 py-1.5 text-sm">
      <FileUp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {external ? (
          <a href={item.openPath} target="_blank" rel="noopener noreferrer" className="block truncate font-medium text-foreground hover:underline" title={item.title}>
            {item.title}
          </a>
        ) : (
          <Link to={item.openPath} className="block truncate font-medium text-foreground hover:underline" title={item.title}>
            {item.title}
          </Link>
        )}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
          <span>{item.typeLabel}</span>
          {size ? <span>{size}</span> : null}
          <span>{formatDay(item.createdAt)}</span>
        </p>
      </div>
    </li>
  );
}

function StageSection({
  caseId,
  stage,
  index,
  stages,
  files,
  busy,
  onUpdate,
  onRemove,
  organisationId,
}: {
  caseId: string;
  organisationId?: string | null;
  stage: ClientJourneyStage;
  index: number;
  stages: ClientJourneyStage[];
  files: ClientEvidenceItem[];
  busy: boolean;
  onUpdate: (linkId: string, patch: UpdateClientJourneyDeliverable) => void;
  onRemove: (linkId: string) => void;
}) {
  // A file that met a document request shows on that request, not twice.
  const requestFileIds = new Set((stage.requests ?? []).flatMap((request) => request.received ? [request.received.evidenceId] : []));
  const looseFiles = files.filter((item) => !requestFileIds.has(item.id));
  const empty = stage.templates.length === 0
    && stage.deliverables.length === 0
    && stage.expected.length === 0
    && files.length === 0
    && (stage.requests ?? []).length === 0
    && (stage.suggestedRequests ?? []).length === 0;
  const met = stage.expected.filter((entry) => entry.deliverableId).length;
  return (
    <section aria-labelledby={`journey-stage-${stage.id}`} className="py-3">
      <h3 id={`journey-stage-${stage.id}`} className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {stage.state !== "side" ? <span className="tabular-nums text-muted-foreground">{index + 1}</span> : null}
        {stage.name}
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5 text-xs font-medium",
            stage.state === "done" && "border-border bg-muted/40 text-foreground",
            (stage.state === "current" || stage.state === "side") && "border-primary text-foreground",
            stage.state === "next" && "border-dashed border-border text-muted-foreground",
          )}
        >
          {STATE_LABEL[stage.state]}
        </span>
      </h3>
      {stage.templates.length > 0 ? (
        <ul className="mt-2 space-y-1" aria-label={`${stage.name} templates`}>
          {stage.templates.map((template) => (
            <li key={template.title} className="flex items-start gap-2 text-sm">
              <FileStack className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                {template.url ? (
                  <a href={template.url} target="_blank" rel="noopener noreferrer" className="text-foreground hover:underline">
                    {template.title}
                  </a>
                ) : (
                  <span className="text-foreground">{template.title}</span>
                )}
                <span className="ml-2 text-xs text-muted-foreground">Template</span>
                {template.note ? <p className="text-xs text-muted-foreground">{template.note}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {stage.expected.length > 0 ? <ExpectedList stage={stage} met={met} /> : null}
      <ClientDocumentRequests caseId={caseId} stage={stage} />
      {stage.deliverables.length > 0 ? (
        <ul className="mt-1 divide-y divide-border" aria-label={`${stage.name} deliverables`}>
          {stage.deliverables.map((row) => (
            <StageDeliverableRow
              key={row.linkId}
              row={row}
              stages={stages}
              busy={busy}
              onUpdate={(patch) => onUpdate(row.linkId, patch)}
              onRemove={() => onRemove(row.linkId)}
            />
          ))}
        </ul>
      ) : null}
      {looseFiles.length > 0 ? (
        <ul className="mt-1" aria-label={`${stage.name} files`}>
          {looseFiles.map((item) => <StageFileRow key={item.id} item={item} />)}
        </ul>
      ) : null}
      {empty ? <p className="mt-1 text-sm text-muted-foreground">Nothing in this stage yet.</p> : null}
      {stage.state !== "next" || files.length > 0 ? (
        <div className="mt-2">
          <ClientUploadZone
            caseId={caseId}
            stageId={stage.id}
            organisationId={organisationId}
            label="Upload to this stage"
            hint={`Drop the ${stage.name} documents here, or choose them.`}
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * What the toolkit expects at this stage against what is filed. Read-only and
 * calm: a met entry gets a tick, a missing one a dashed ring and "Missing".
 */
export function ExpectedList({ stage, met }: { stage: Pick<ClientJourneyStage, "name" | "expected">; met: number }) {
  return (
    <div className="mt-2" data-testid="journey-stage-expected">
      <p className="text-xs text-muted-foreground">
        Toolkit expects {stage.expected.length}: {met} filed
        {met < stage.expected.length ? `, ${stage.expected.length - met} missing` : ""}
      </p>
      <ul className="mt-1 space-y-1" aria-label={`${stage.name} expected deliverables`}>
        {stage.expected.map((entry) => (
          <li key={entry.key} className="flex items-center gap-2 text-sm">
            {entry.deliverableId ? (
              <CircleCheck className="h-4 w-4 shrink-0 text-status-success" aria-hidden="true" />
            ) : (
              <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className={cn("min-w-0 truncate", entry.deliverableId ? "text-foreground" : "text-muted-foreground")}>
              {entry.title}
            </span>
            {entry.kind ? <span className="text-xs text-muted-foreground">{kindLabel(entry.kind)}</span> : null}
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{entry.deliverableId ? "Filed" : "Missing"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const NDA_OPTIONS: Array<{ value: NdaStatus; label: string }> = [
  { value: "required", label: "Required" },
  { value: "accepted", label: "Accepted" },
  { value: "suspended", label: "Suspended" },
];

/** What each NDA status means for the engagement, in one line. */
function ndaSummary(nda: ClientNda): string {
  const by = nda.changedBy ? ` by ${nda.changedBy}` : "";
  if (nda.status === "accepted") {
    return `Accepted${nda.acceptedAt ? ` ${formatDay(nda.acceptedAt)}` : ""}${by}. The engagement proceeds and client-labelled deliverables can reach the portal.`;
  }
  if (nda.status === "suspended") {
    return `Suspended${nda.changedAt ? ` ${formatDay(nda.changedAt)}` : ""}${by}, not waived. The engagement proceeds and client-labelled deliverables can reach the portal.`;
  }
  return "Every engagement needs a mutual NDA (governing law England and Wales). Until it is accepted or suspended, client-labelled deliverables stay off the portal. Public ones do not need it.";
}

/**
 * The client's NDA as a three-way control (Ben and John, 13 Oct): required,
 * accepted or suspended. Suspending asks for the reason first and shows it
 * while suspended. Board only; the server refuses anyone else.
 */
export function NdaRow({
  nda,
  busy,
  onChange,
  onUploadSigned,
}: {
  nda: ClientNda;
  busy: boolean;
  onChange: (input: { status: NdaStatus; reason?: string | null }) => void;
  /** Upload the signed NDA; it is kept with the client and marks the NDA accepted (Ben, 8 Oct). */
  onUploadSigned?: (file: File) => void;
}) {
  const signedInput = useRef<HTMLInputElement>(null);
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState("");
  const choose = (status: NdaStatus) => {
    if (status === nda.status && status !== "suspended") return;
    if (status === "suspended") {
      setReason(nda.suspendedReason ?? "");
      setSuspending(true);
      return;
    }
    setSuspending(false);
    onChange({ status });
  };
  return (
    <div className="space-y-2 py-3 text-sm" data-testid="journey-nda" data-nda-status={nda.status}>
      <div className="flex flex-wrap items-center gap-3">
        <span id="journey-nda-label" className="font-medium text-foreground">NDA</span>
        <div role="radiogroup" aria-labelledby="journey-nda-label" className="inline-flex rounded-md border border-border p-0.5">
          {NDA_OPTIONS.map((option) => {
            const checked = suspending ? option.value === "suspended" : nda.status === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={busy}
                onClick={() => choose(option.value)}
                className={cn(
                  "rounded-sm px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
                  checked ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{ndaSummary(nda)}</p>
      {nda.signedDocument ? (
        <p className="flex flex-wrap items-center gap-x-2 text-xs" data-testid="journey-nda-signed">
          <FileCheck2 className="h-3.5 w-3.5 shrink-0 text-status-success" aria-hidden="true" />
          <a
            href={nda.signedDocument.contentPath}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground hover:underline"
          >
            {nda.signedDocument.title}
          </a>
          <span className="text-muted-foreground">Uploaded {formatDay(nda.signedDocument.uploadedAt)}</span>
        </p>
      ) : null}
      {onUploadSigned && nda.status !== "suspended" ? (
        <FileDropArea
          label="Drop or paste the signed NDA here"
          disabled={busy}
          onFiles={([file]) => onUploadSigned(file)}
          className="-m-1 p-1"
          testId="journey-nda-drop"
        >
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => signedInput.current?.click()}>
            <FileUp className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {nda.signedDocument ? "Replace the signed NDA" : "Upload the signed NDA"}
          </Button>
          <input
            ref={signedInput}
            type="file"
            accept="application/pdf,image/*"
            className="hidden"
            aria-label="Upload the signed NDA"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onUploadSigned(file);
            }}
          />
          {nda.status === "required" ? (
            <p className="mt-1 text-xs text-muted-foreground">Uploading the signed copy marks the NDA accepted and keeps the file with this client. You can drop or paste it here too.</p>
          ) : null}
        </FileDropArea>
      ) : null}
      {nda.status === "suspended" && nda.suspendedReason && !suspending ? (
        <p className="text-xs text-foreground" data-testid="journey-nda-reason">
          <span className="font-medium">Reason: </span>{nda.suspendedReason}
        </p>
      ) : null}
      {suspending ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reason.trim()) return;
            onChange({ status: "suspended", reason: reason.trim() });
            setSuspending(false);
          }}
        >
          <label className="block text-xs font-medium text-foreground" htmlFor="journey-nda-reason">
            Why is the NDA suspended? (required)
          </label>
          <Textarea
            id="journey-nda-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="For example: the engagement was already under way when the NDA policy started."
            maxLength={500}
            className="min-h-16 text-sm"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setSuspending(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy || !reason.trim()}>Suspend NDA</Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function UnfiledRow({
  item,
  stages,
  busy,
  onFile,
}: {
  item: Deliverable;
  stages: ClientJourneyStage[];
  busy: boolean;
  onFile: (stageId: string) => void;
}) {
  return (
    <li className="flex flex-col gap-2 py-2 text-sm sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Package className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <DeliverableTitle item={item} />
          <DeliverableMeta item={item} />
        </div>
      </div>
      <NativeSelect
        className="ml-6 h-7 w-auto shrink-0 text-xs sm:ml-0"
        aria-label={`File ${item.title} under a stage`}
        value=""
        disabled={busy}
        onChange={(event) => {
          if (event.target.value) onFile(event.target.value);
        }}
      >
        <option value="">File under stage...</option>
        {stages.map((stage) => (
          <option key={stage.id} value={stage.id}>{stage.name}</option>
        ))}
      </NativeSelect>
    </li>
  );
}

/** Each journey stage as a section, with its templates and deliverables (GRE-1473). */
export function ClientJourneyStages({ caseId, organisationId }: { caseId: string; organisationId?: string | null }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [unfiledOpen, setUnfiledOpen] = useState(false);
  const journey = useQuery({
    queryKey: queryKeys.pipelines.caseJourney(caseId),
    queryFn: () => pipelinesApi.getCaseJourney(caseId),
  });
  const caseFiles = useQuery({
    queryKey: queryKeys.pipelines.caseFiles(caseId),
    queryFn: () => pipelinesApi.getCaseFiles(caseId),
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseJourney(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.casePortal(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(caseId) }),
    ]);
  const onError = (title: string) => () =>
    pushToast({ title, body: "You may not have the right to change this client.", tone: "error" });

  const fileDeliverable = useMutation({
    mutationFn: (input: { stageId: string; deliverableId: string }) =>
      pipelinesApi.fileCaseJourneyDeliverable(caseId, input),
    onSuccess: invalidate,
    onError: onError("Could not file the deliverable"),
  });
  const updateLink = useMutation({
    mutationFn: ({ linkId, patch }: { linkId: string; patch: UpdateClientJourneyDeliverable }) =>
      pipelinesApi.updateCaseJourneyDeliverable(caseId, linkId, patch),
    onSuccess: invalidate,
    onError: onError("Could not change the deliverable"),
  });
  const setNda = useMutation({
    mutationFn: (input: { status: NdaStatus; reason?: string | null }) => pipelinesApi.setCaseNda(caseId, input),
    onSuccess: invalidate,
    onError: () => pushToast({ title: "Could not change the NDA", body: "Only board users can change a client's NDA.", tone: "error" }),
  });
  const uploadSignedNda = useMutation({
    mutationFn: (file: File) => pipelinesApi.uploadSignedNda(caseId, file),
    onSuccess: async () => {
      pushToast({ title: "Signed NDA saved", body: "The NDA is now accepted.", tone: "success" });
      await Promise.all([
        invalidate(),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseFiles(caseId) }),
      ]);
    },
    onError: (error) =>
      pushToast({
        title: "Could not save the signed NDA",
        body: error instanceof Error ? error.message : "Only board users can change a client's NDA.",
        tone: "error",
      }),
  });
  const removeLink = useMutation({
    mutationFn: (linkId: string) => pipelinesApi.removeCaseJourneyDeliverable(caseId, linkId),
    onSuccess: invalidate,
    onError: onError("Could not take the deliverable out of the stage"),
  });

  if (journey.isLoading) return <p className="py-3 text-sm text-muted-foreground">Loading the journey...</p>;
  if (journey.error || !journey.data) {
    return (
      <ErrorState
        compact
        error={journey.error}
        title="Could not load the journey"
        onRetry={() => void journey.refetch()}
        retrying={journey.isFetching}
      />
    );
  }

  const { stages, unfiled } = journey.data;
  // A server from before 0335 sends only ndaAcceptedAt.
  const nda: ClientNda = journey.data.nda ?? {
    status: journey.data.ndaAcceptedAt ? "accepted" : "required",
    acceptedAt: journey.data.ndaAcceptedAt,
    suspendedReason: null,
    changedBy: null,
    changedAt: null,
  };
  const busy = fileDeliverable.isPending || updateLink.isPending || removeLink.isPending || setNda.isPending || uploadSignedNda.isPending;
  const filesByStage = new Map<string, ClientEvidenceItem[]>();
  for (const item of caseFiles.data?.evidence ?? []) {
    if (!item.stageId) continue;
    filesByStage.set(item.stageId, [...(filesByStage.get(item.stageId) ?? []), item]);
  }
  const journeyIndex = new Map(stages.filter((stage) => stage.state !== "side").map((stage, index) => [stage.id, index]));
  return (
    <div className="divide-y divide-border">
      <NdaRow
        nda={nda}
        busy={busy}
        onChange={(input) => setNda.mutate(input)}
        onUploadSigned={(file) => uploadSignedNda.mutate(file)}
      />
      <ClientEngagementRow caseId={caseId} engagement={journey.data.engagement} ndaCleared={nda.status !== "required"} />
      {stages.map((stage) => (
        <StageSection
          key={stage.id}
          caseId={caseId}
          organisationId={organisationId}
          files={filesByStage.get(stage.id) ?? []}
          stage={stage}
          index={journeyIndex.get(stage.id) ?? 0}
          stages={stages}
          busy={busy}
          onUpdate={(linkId, patch) => updateLink.mutate({ linkId, patch })}
          onRemove={(linkId) => removeLink.mutate(linkId)}
        />
      ))}
      {unfiled.length > 0 ? (
        <section className="py-3" aria-label="Deliverables not in a stage">
          <button
            type="button"
            className="text-sm font-medium text-foreground hover:underline"
            aria-expanded={unfiledOpen}
            onClick={() => setUnfiledOpen((open) => !open)}
          >
            {unfiled.length === 1 ? "1 deliverable is not in a stage" : `${unfiled.length} deliverables are not in a stage`}
          </button>
          {unfiledOpen ? (
            <ul className="mt-1 divide-y divide-border">
              {unfiled.map((item) => (
                <UnfiledRow
                  key={item.id}
                  item={item}
                  stages={stages}
                  busy={busy}
                  onFile={(stageId) => fileDeliverable.mutate({ stageId, deliverableId: item.id })}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** What the client sees on its portal: completed stages, client-facing final deliverables only. */
export function ClientPortalPreview({ caseId }: { caseId: string }) {
  const portal = useQuery({
    queryKey: queryKeys.pipelines.casePortal(caseId),
    queryFn: () => pipelinesApi.getCasePortal(caseId),
  });
  if (portal.isLoading) return <p className="py-3 text-sm text-muted-foreground">Loading the portal view...</p>;
  if (portal.error || !portal.data) return <p className="py-3 text-sm text-destructive">Could not load the portal view.</p>;
  const stages = portal.data.stages.filter((stage) => stage.deliverables.length > 0);
  if (stages.length === 0) {
    return (
      <p className="py-3 text-sm text-muted-foreground">
        The client sees nothing yet. A deliverable shows here when it is final, marked "Client can see", its stage is complete, and it is labelled Public, or Client with the NDA recorded.
      </p>
    );
  }
  return (
    <div className="divide-y divide-border">
      {stages.map((stage) => (
        <section key={stage.key} className="py-3" aria-label={`${stage.name} on the portal`}>
          <h3 className="text-sm font-semibold text-foreground">{stage.name}</h3>
          <ul className="mt-1 space-y-1">
            {stage.deliverables.map((item) => (
              <li key={`${item.title}-${item.version}`} className="text-sm text-foreground">
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{item.title}</a>
                ) : item.title}
                <span className="ml-3 text-xs text-muted-foreground">{kindLabel(item.kind)}</span>
                <span className="ml-3 text-xs text-muted-foreground">Version {item.version}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
