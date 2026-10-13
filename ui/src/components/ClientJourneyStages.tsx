import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, FileStack, Globe, Package, Trash2 } from "lucide-react";
import type {
  ClientJourneyStage,
  ClientJourneyStageDeliverable,
  ClientJourneyStageState,
  Deliverable,
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
import { ToggleSwitch } from "./ui/toggle-switch";
import { ConfidentialityBadge } from "./deliverables/DeliverableBadges";

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

function StageSection({
  stage,
  index,
  stages,
  busy,
  onUpdate,
  onRemove,
}: {
  stage: ClientJourneyStage;
  index: number;
  stages: ClientJourneyStage[];
  busy: boolean;
  onUpdate: (linkId: string, patch: UpdateClientJourneyDeliverable) => void;
  onRemove: (linkId: string) => void;
}) {
  const empty = stage.templates.length === 0 && stage.deliverables.length === 0 && stage.expected.length === 0;
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
      {empty ? <p className="mt-1 text-sm text-muted-foreground">No templates or deliverables for this stage yet.</p> : null}
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

/** The client's NDA: client-labelled deliverables reach the portal only once it is recorded. */
function NdaRow({ acceptedAt, busy, onChange }: { acceptedAt: string | null; busy: boolean; onChange: (accepted: boolean) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 py-3 text-sm" data-testid="journey-nda">
      <label className="flex items-center gap-2 font-medium text-foreground">
        <ToggleSwitch checked={acceptedAt !== null} disabled={busy} aria-label="NDA accepted" onCheckedChange={onChange} />
        NDA accepted
      </label>
      <span className="text-xs text-muted-foreground">
        {acceptedAt
          ? `Recorded ${formatDay(acceptedAt)}. Client-labelled deliverables can reach the portal.`
          : "Client-labelled deliverables stay off the portal until the NDA is recorded. Public ones do not need it."}
      </span>
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
export function ClientJourneyStages({ caseId }: { caseId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [unfiledOpen, setUnfiledOpen] = useState(false);
  const journey = useQuery({
    queryKey: queryKeys.pipelines.caseJourney(caseId),
    queryFn: () => pipelinesApi.getCaseJourney(caseId),
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
    mutationFn: (accepted: boolean) => pipelinesApi.setCaseNda(caseId, accepted),
    onSuccess: invalidate,
    onError: () => pushToast({ title: "Could not record the NDA", body: "Only board users can record a client's NDA.", tone: "error" }),
  });
  const removeLink = useMutation({
    mutationFn: (linkId: string) => pipelinesApi.removeCaseJourneyDeliverable(caseId, linkId),
    onSuccess: invalidate,
    onError: onError("Could not take the deliverable out of the stage"),
  });

  if (journey.isLoading) return <p className="py-3 text-sm text-muted-foreground">Loading the journey...</p>;
  if (journey.error || !journey.data) return <p className="py-3 text-sm text-destructive">Could not load the journey.</p>;

  const { stages, unfiled, ndaAcceptedAt } = journey.data;
  const busy = fileDeliverable.isPending || updateLink.isPending || removeLink.isPending || setNda.isPending;
  const journeyIndex = new Map(stages.filter((stage) => stage.state !== "side").map((stage, index) => [stage.id, index]));
  return (
    <div className="divide-y divide-border">
      <NdaRow acceptedAt={ndaAcceptedAt} busy={busy} onChange={(accepted) => setNda.mutate(accepted)} />
      {stages.map((stage) => (
        <StageSection
          key={stage.id}
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
