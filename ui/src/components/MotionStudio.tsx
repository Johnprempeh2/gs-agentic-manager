import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MOTION_STUDY_DECISION_LABELS,
  MOTION_STUDY_DECISIONS,
  MOTION_STUDY_STATUS_LABELS,
  MOTION_STUDY_STATUSES,
  MOTION_TEXT_SAFE_CONTRACT,
  type MotionStudiesResponse,
  type MotionStudy,
  type MotionStudyDecision,
  type MotionStudyStatus,
} from "@greatstone/shared";
import { Check, ChevronDown, ExternalLink, Loader2, Play, Sparkles, Type, X } from "lucide-react";
import { motionStudiesApi } from "../api/motionStudies";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

// GS Studio's Motion section (GRE-2212): the Animation Lab's studies, each a
// small HTML page that runs sandboxed with no network. A card shows a still
// frame and plays its study while it is hovered or focused; opening it shows
// the study large with the Decision and Status for a person to set.

export type MotionFilter = "all" | "text-safe" | MotionStudyDecision;

export const MOTION_FILTERS: ReadonlyArray<{ id: MotionFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "text-safe", label: "Text-safe" },
  ...MOTION_STUDY_DECISIONS.map((decision) => ({ id: decision, label: MOTION_STUDY_DECISION_LABELS[decision] })),
];

export function filterMotionStudies(studies: readonly MotionStudy[], filter: MotionFilter, showArchived: boolean) {
  return studies.filter((study) => {
    if (!showArchived && study.status === "archived") return false;
    if (filter === "all") return true;
    if (filter === "text-safe") return study.textSafe;
    return study.decision === filter;
  });
}

const STATUS_TONE: Record<MotionStudyStatus, string> = {
  new: "bg-status-info-soft text-status-info-foreground",
  reviewed: "bg-status-review-soft text-status-review-foreground",
  approved: "bg-status-success-soft text-status-success-foreground",
  implemented: "bg-status-success-soft text-status-success-foreground",
  archived: "bg-status-neutral-soft text-status-neutral-foreground",
};

const DECISION_TONE: Record<MotionStudyDecision, string> = {
  undecided: "bg-status-neutral-soft text-status-neutral-foreground",
  implement: "bg-status-success-soft text-status-success-foreground",
  maybe: "bg-status-warning-soft text-status-warning-foreground",
  pass: "bg-status-neutral-soft text-status-neutral-foreground",
};

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | null;
    if (body && typeof body.error === "string") return body.error;
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

/** What an agent proposed, in words, for example "Decision: Implement". */
export function proposalSummary(study: MotionStudy): string | null {
  const proposal = study.proposal;
  if (!proposal) return null;
  const parts: string[] = [];
  if (proposal.status) parts.push(`Status: ${MOTION_STUDY_STATUS_LABELS[proposal.status]}`);
  if (proposal.decision) parts.push(`Decision: ${MOTION_STUDY_DECISION_LABELS[proposal.decision]}`);
  return parts.join(", ");
}

/** Studies are laid out for a full screen; each is drawn at this size and scaled to fit its box. */
const STUDY_STAGE = { width: 1280, height: 720 };

function useBoxWidth() {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return { ref: setNode, width };
}

/**
 * The study, sandboxed: scripts only, no same-origin, forms, pop-ups or top
 * navigation (the server's CSP also blocks the network). It renders at the
 * full stage size and is scaled down, so a card shows a true thumbnail.
 */
function StudyFrame({ study, interactive, className }: { study: MotionStudy; interactive?: boolean; className?: string }) {
  const box = useBoxWidth();
  const scale = box.width > 0 ? box.width / STUDY_STAGE.width : 0;
  return (
    <div
      ref={box.ref}
      className={cn("relative w-full overflow-hidden bg-background", className)}
      style={{ height: box.width > 0 ? Math.round(box.width * (STUDY_STAGE.height / STUDY_STAGE.width)) : undefined }}
    >
      {!study.previewPath ? (
        <div className="grid h-full w-full place-items-center text-xs text-muted-foreground">No study page</div>
      ) : (
        <iframe
          src={study.previewPath}
          title={`${study.title}, motion study ${study.number}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          tabIndex={interactive ? 0 : -1}
          className={cn("absolute left-0 top-0 origin-top-left border-0", !interactive && "pointer-events-none")}
          style={{ width: STUDY_STAGE.width, height: STUDY_STAGE.height, transform: `scale(${scale})` }}
        />
      )}
    </div>
  );
}

/** On a card every mark shows; the open study keeps only Text-safe, since its controls already show the rest. */
function StudyPills({ study, withState = true }: { study: MotionStudy; withState?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {study.textSafe ? (
        <Badge className="bg-status-success-soft text-status-success-foreground" data-testid="motion-text-safe">
          <Type aria-hidden="true" />
          Text-safe
        </Badge>
      ) : null}
      {withState ? <Badge className={STATUS_TONE[study.status]}>{MOTION_STUDY_STATUS_LABELS[study.status]}</Badge> : null}
      {withState ? <Badge className={DECISION_TONE[study.decision]}>{MOTION_STUDY_DECISION_LABELS[study.decision]}</Badge> : null}
      {withState && study.proposal ? (
        <Badge variant="outline" title={proposalSummary(study) ?? undefined}>
          <Sparkles aria-hidden="true" />
          Agent proposal
        </Badge>
      ) : null}
    </div>
  );
}

const CHIP_ON_FRAME = "rounded-md bg-background/85 px-1.5 py-0.5 text-xs text-foreground backdrop-blur-sm";

function MotionCard({ study, onOpen }: { study: MotionStudy; onOpen: () => void }) {
  const [playing, setPlaying] = useState(false);
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onOpen}
        onPointerEnter={(event) => event.pointerType === "mouse" && setPlaying(true)}
        onPointerLeave={() => setPlaying(false)}
        onFocus={() => setPlaying(true)}
        onBlur={() => setPlaying(false)}
        className="group flex w-full flex-col gap-2 rounded-xl text-left outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring"
        data-testid={`motion-card-${study.slug}`}
        aria-label={`Open ${study.number} ${study.title}`}
      >
        <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-muted ring-1 ring-border transition-shadow group-hover:ring-ring">
          {playing ? (
            <StudyFrame study={study} className="absolute inset-0 h-full" />
          ) : (
            // A still frame until the card is hovered or focused, so a page of studies is not a page of running canvases.
            <>
              {study.posterPath ? (
                <img
                  src={study.posterPath}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 h-full w-full object-cover"
                  data-testid="motion-poster"
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center bg-card text-muted-foreground">
                  <Play className="h-6 w-6" aria-hidden="true" />
                </div>
              )}
              {/* Chips sit on the top edge and the bottom right, clear of the title a study draws bottom left. */}
              <div className="absolute inset-0 flex flex-col justify-between p-2">
                <span className="flex items-start justify-between gap-2">
                  {study.theme[0] ? <span className={cn(CHIP_ON_FRAME, "truncate")}>{study.theme[0]}</span> : <span />}
                  {study.tech ? <span className={cn(CHIP_ON_FRAME, "shrink-0")}>{study.tech}</span> : null}
                </span>
                <span className="flex justify-end">
                  <span className={cn(CHIP_ON_FRAME, "flex shrink-0 items-center gap-1")}>
                    <Play className="h-3 w-3" aria-hidden="true" />
                    <span className="pointer-coarse:hidden">Hover to play</span>
                    <span className="hidden pointer-coarse:inline">Tap to open</span>
                  </span>
                </span>
              </div>
            </>
          )}
        </div>
        <div className="space-y-1 px-0.5">
          <p className="flex items-baseline gap-2">
            <span className="font-mono text-xs text-muted-foreground">{study.number}</span>
            <span className="text-sm font-semibold text-foreground">{study.title}</span>
          </p>
          <p className="line-clamp-2 text-xs text-muted-foreground">{study.concept}</p>
          <p className="truncate text-xs text-muted-foreground">{[...study.theme, study.tech].filter(Boolean).join(" · ")}</p>
          <StudyPills study={study} />
        </div>
      </button>
    </li>
  );
}

/** Implement first: the order a person reads the choice in, with Undecided last. */
const MOTION_STUDY_DECISIONS_IN_ORDER: readonly MotionStudyDecision[] = ["implement", "maybe", "pass", "undecided"];

/** Decision, one tap each: the reason the open study exists. */
function DecisionPicker({
  value,
  disabled,
  onChange,
}: {
  value: MotionStudyDecision;
  disabled: boolean;
  onChange: (decision: MotionStudyDecision) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span id="motion-decision-label" className="text-sm font-medium text-foreground">
        Decision
      </span>
      <div
        role="radiogroup"
        aria-labelledby="motion-decision-label"
        className="grid grid-cols-4 rounded-lg border border-border p-0.5"
        data-testid="motion-decision"
      >
        {MOTION_STUDY_DECISIONS_IN_ORDER.map((decision) => {
          const checked = value === decision;
          return (
            <button
              key={decision}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled}
              onClick={() => (checked ? undefined : onChange(decision))}
              className={cn(
                "min-h-10 rounded-md px-1 text-xs font-medium sm:px-2 sm:text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
                checked ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {MOTION_STUDY_DECISION_LABELS[decision]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StudyDetail({ study, onClose }: { study: MotionStudy; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const refresh = (updated: MotionStudy) => {
    setError(null);
    queryClient.setQueryData<MotionStudiesResponse>(queryKeys.motionStudies.list(study.companyId), (current) =>
      current ? { studies: current.studies.map((item) => (item.id === updated.id ? updated : item)) } : current,
    );
  };
  const update = useMutation({
    mutationFn: (body: { status?: MotionStudyStatus; decision?: MotionStudyDecision }) => motionStudiesApi.update(study.id, body),
    onSuccess: refresh,
    onError: (err) => setError(errorMessage(err)),
  });
  const resolve = useMutation({
    mutationFn: (accept: boolean) => motionStudiesApi.resolveProposal(study.id, accept),
    onSuccess: refresh,
    onError: (err) => setError(errorMessage(err)),
  });
  const proposal = proposalSummary(study);
  const busy = update.isPending || resolve.isPending;

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        // On a phone the study is a full-height sheet; the close button stays pinned while the body scrolls.
        className="max-h-(--sz-90vh) sm:max-w-4xl max-sm:top-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:p-4"
        scrollBody
      >
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-baseline gap-2 pr-6">
            <span className="font-mono text-sm text-muted-foreground">No. {study.number}</span>
            {study.title}
          </DialogTitle>
          <DialogDescription>{study.concept}</DialogDescription>
        </DialogHeader>

        <StudyFrame study={study} interactive className="rounded-lg ring-1 ring-border" />

        {/* Stretch, so the Status select matches the Decision row's height and both labels share a top line. */}
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="min-w-0 flex-1">
            <DecisionPicker value={study.decision} disabled={busy} onChange={(decision) => update.mutate({ decision })} />
          </div>
          <label className="flex shrink-0 flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">Status</span>
            <NativeSelect
              value={study.status}
              disabled={busy}
              onChange={(event) => update.mutate({ status: event.target.value as MotionStudyStatus })}
              className="sm:h-auto sm:w-40 sm:flex-1"
              data-testid="motion-status-select"
            >
              {MOTION_STUDY_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {MOTION_STUDY_STATUS_LABELS[status]}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
        {busy ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
            Saving
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {proposal ? (
          <div className="space-y-2 rounded-lg border border-status-info/30 bg-status-info/10 p-3" data-testid="motion-proposal">
            <p className="text-sm text-foreground">
              <span className="font-medium">An agent proposes</span> {proposal}.
            </p>
            {study.proposal?.reason ? <p className="text-sm text-muted-foreground">{study.proposal.reason}</p> : null}
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => resolve.mutate(true)}>
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                Accept
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => resolve.mutate(false)}>
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                Decline
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <StudyPills study={study} withState={false} />
          {study.previewPath ? (
            <Button asChild size="sm" variant="outline">
              <a href={study.previewPath} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                Open full screen
              </a>
            </Button>
          ) : null}
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Theme</dt>
            <dd className="text-foreground">{study.theme.join(", ") || "None given"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Tech</dt>
            <dd className="text-foreground">{study.tech || "Not given"}</dd>
          </div>
        </dl>

        {study.textSafe ? (
          <Collapsible className="rounded-lg border border-border">
            <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
              Background rules: safe behind text
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="list-disc space-y-0.5 px-3 pb-3 pl-8 text-sm text-foreground" data-testid="motion-background-rules">
                {MOTION_TEXT_SAFE_CONTRACT.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ) : null}

        {study.notes ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Notes</p>
            <p className="whitespace-pre-line text-sm text-foreground">{study.notes}</p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FilterChip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
        pressed ? "border-foreground bg-foreground text-background" : "border-border text-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

export function MotionStudio({ companyId }: { companyId: string }) {
  const [filter, setFilter] = useState<MotionFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: queryKeys.motionStudies.list(companyId),
    queryFn: () => motionStudiesApi.list(companyId),
  });
  const studies = query.data?.studies ?? [];
  const shown = filterMotionStudies(studies, filter, showArchived);
  const opened = studies.find((study) => study.id === openId) ?? null;
  const proposals = studies.filter((study) => study.proposal).length;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="motion-heading" data-testid="motion-studio">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 id="motion-heading" className="text-base font-semibold text-foreground">
            Motion
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            The Animation Lab's studies.{" "}
            <span className="pointer-coarse:hidden">Hover a card to play it, open it to decide.</span>
            <span className="hidden pointer-coarse:inline">Open a card to play it and decide.</span> Text-safe studies are made
            to sit behind words.
          </p>
        </div>
        {proposals > 0 ? (
          <p className="text-sm text-muted-foreground">
            {proposals === 1 ? "1 agent proposal waits for you" : `${proposals} agent proposals wait for you`}
          </p>
        ) : null}
      </div>

      {/* One row that scrolls sideways on a phone, so the first studies stay on the first screen. */}
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 py-0.5" role="group" aria-label="Show" data-testid="motion-filters">
        {MOTION_FILTERS.map((item) => (
          <FilterChip key={item.id} pressed={filter === item.id} onClick={() => setFilter(item.id)}>
            {item.label}
          </FilterChip>
        ))}
        <FilterChip pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>
          Show archived
        </FilterChip>
      </div>

      {query.isLoading ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <li key={index} className="gs-skeleton aspect-video rounded-xl bg-muted" />
          ))}
        </ul>
      ) : query.isError ? (
        <div className="space-y-2 rounded-xl border border-border p-4" role="alert">
          <p className="text-sm text-foreground">The studies did not load. {errorMessage(query.error)}</p>
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>
            Try again
          </Button>
        </div>
      ) : studies.length === 0 ? (
        <div className="space-y-1 rounded-xl border border-dashed border-border p-6" data-testid="motion-empty">
          <p className="text-base font-semibold text-foreground">No motion studies yet</p>
          <p className="text-sm text-muted-foreground">
            The Lab's studies arrive here once they are imported, and the daily study adds a new one each day as New.
          </p>
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">No studies match this filter.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" data-testid="motion-grid">
          {shown.map((study) => (
            <MotionCard key={study.id} study={study} onOpen={() => setOpenId(study.id)} />
          ))}
        </ul>
      )}

      {opened ? <StudyDetail study={opened} onClose={() => setOpenId(null)} /> : null}
    </section>
  );
}
