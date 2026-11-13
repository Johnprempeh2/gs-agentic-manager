import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Camera, ChevronLeft, ChevronRight, CircleCheck, Download, ExternalLink, Info, Link2, MessageSquarePlus, Sparkles, X } from "lucide-react";
import { projectsApi } from "@/api/projects";
import { deliverablesApi, type Deliverable, type DeliverableConfidentiality } from "@/api/deliverables";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { useOptionalToastActions } from "@/context/ToastContext";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import { DeliverableCommentsPanel, DeliverableReviewFrame, useDeliverableReview } from "./DeliverableComments";
import { DeliverableDocumentView, isHtmlDeliverable, liveEditPath } from "./DeliverableDocument";
import { DELIVERABLE_KIND_LABELS } from "./DeliverableCard";
import { CONFIDENTIALITY_LABELS, ConfidentialityBadge, DeliverableStageBadge, LinkStatusBadges, siteDomain } from "./DeliverableBadges";
import { DeliverableProjectAssignment, DeliverableVersionTimeline, OldVersionBanner } from "./DeliverableVersionTimeline";

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function PanelRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

/**
 * Full-screen Quick Look for deliverables. ← / → move through `items`, Esc
 * closes (Radix). The side panel carries the task, author, versions and the
 * file actions. `onBack` shows a Back button for a deliverable opened from
 * another page, so the installed app (no browser Back) can return there.
 */
export function DeliverableQuickLook({
  companyId,
  items,
  index,
  onIndexChange,
  onClose,
  onBack,
  onCopyLink,
}: {
  companyId: string;
  items: Deliverable[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onBack?: () => void;
  onCopyLink: (id: string) => void;
}) {
  const current = items[index] ?? null;
  const [versionId, setVersionId] = useState<string | null>(null);
  // Comment mode (GRE-982): mark up the shown version and send the notes.
  const [commenting, setCommenting] = useState(false);
  // Phones: the side panel opens below the document on demand.
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    setVersionId(null);
  }, [current?.id]);

  const shownId = versionId ?? current?.id ?? null;
  const { data: detail } = useQuery({
    queryKey: queryKeys.deliverables.detail(companyId, shownId ?? ""),
    queryFn: () => deliverablesApi.get(companyId, shownId!),
    enabled: !!shownId,
  });

  useEffect(() => {
    if (!current) return;
    void deliverablesApi.markOpened(companyId, current.id).catch(() => undefined);
  }, [companyId, current?.id]);

  const review = useDeliverableReview(companyId, shownId ?? "", commenting && !!shownId);
  const queryClient = useQueryClient();
  const pushToast = useOptionalToastActions()?.pushToast ?? (() => null);
  const refreshAll = () => queryClient.invalidateQueries({ queryKey: queryKeys.deliverables.all(companyId) });
  const relabel = useMutation({
    mutationFn: (input: { confidentiality?: DeliverableConfidentiality; restricted?: boolean }) =>
      deliverablesApi.update(companyId, current!.id, input),
    onSuccess: () => refreshAll(),
    onError: () => pushToast({ title: "Could not save the label", tone: "error" }),
  });
  const screenshot = useMutation({
    mutationFn: () => deliverablesApi.refreshScreenshot(companyId, current!.id),
    onSuccess: (result) => {
      void refreshAll();
      pushToast(result.captured
        ? { title: "Screenshot refreshed", tone: "success", ttlMs: 2500 }
        : { title: "Screenshots are not available on this server", tone: "info" });
    },
    onError: () => pushToast({ title: "Could not refresh the screenshot", tone: "error" }),
  });

  const { data: projectList } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const move = useMutation({
    mutationFn: (projectId: string) => deliverablesApi.move(companyId, current!.id, projectId),
    onSuccess: (moved) => {
      void refreshAll();
      pushToast({ title: `Moved to ${moved.project?.name ?? "the new project"}`, tone: "success", ttlMs: 3000 });
    },
    onError: () => pushToast({ title: "Could not move the deliverable", tone: "error" }),
  });

  const hasPrevious = index > 0;
  const hasNext = index < items.length - 1;

  if (!current) return null;
  const shown = detail && detail.id === shownId ? detail : current;
  const versions = detail?.versions ?? [];
  const latestVersion = Math.max(current.version, ...versions.map((version) => version.version));
  const canComment = isHtmlDeliverable(shown);
  const reviewing = commenting && canComment;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        data-testid="deliverable-quicklook"
        onKeyDown={(event) => {
          if (isTypingTarget(event.target)) return;
          if (event.key === "ArrowLeft" && hasPrevious) {
            event.preventDefault();
            onIndexChange(index - 1);
          } else if (event.key === "ArrowRight" && hasNext) {
            event.preventDefault();
            onIndexChange(index + 1);
          }
        }}
        className="inset-0 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 sm:max-w-none md:top-0 md:translate-y-0 md:flex-row"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
            {onBack ? (
              <>
                <Button variant="ghost" size="sm" onClick={onBack} data-testid="deliverable-quicklook-back">
                  <ArrowLeft /> Back
                </Button>
                <span className="h-5 w-px bg-border" aria-hidden="true" />
              </>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous deliverable"
              disabled={!hasPrevious}
              onClick={() => onIndexChange(index - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next deliverable"
              disabled={!hasNext}
              onClick={() => onIndexChange(index + 1)}
            >
              <ChevronRight />
            </Button>
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-semibold">{shown.title}</DialogTitle>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {index + 1} of {items.length}
            </span>
            {liveEditPath(shown) ? (
              <Button asChild variant="default" size="sm">
                <Link to={liveEditPath(shown)!} disableIssueQuicklook data-testid="deliverable-edit-live-top">
                  <Sparkles /> Edit live
                </Link>
              </Button>
            ) : null}
            {canComment ? (
              <Button
                variant={reviewing ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={reviewing}
                onClick={() => setCommenting((value) => !value)}
                data-testid="deliverable-comment-mode"
              >
                <MessageSquarePlus /> <span className="hidden sm:inline">{reviewing ? "Done commenting" : "Comment"}</span>
              </Button>
            ) : null}
            {!reviewing ? (
              <Button
                variant={showDetails ? "secondary" : "ghost"}
                size="icon-sm"
                className="md:hidden"
                aria-label={showDetails ? "Hide details" : "Show details and releases"}
                aria-pressed={showDetails}
                onClick={() => setShowDetails((value) => !value)}
                data-testid="deliverable-details-toggle"
              >
                <Info />
              </Button>
            ) : null}
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close preview">
                <X />
              </Button>
            </DialogClose>
          </div>
          <OldVersionBanner
            shownVersion={shown.version}
            latestVersion={latestVersion}
            onViewLatest={() => setVersionId(null)}
          />
          <div className="min-h-0 flex-1 bg-muted/40">
            {reviewing ? <DeliverableReviewFrame review={review} title={shown.title} /> : <DeliverableDocumentView source={shown} />}
          </div>
        </div>

        {reviewing ? (
          <aside className="flex max-h-(--sz-50vh) w-full shrink-0 flex-col overflow-y-auto border-t border-border bg-background p-4 md:max-h-none md:w-80 md:border-t-0 md:border-l md:p-5">
            <DeliverableCommentsPanel review={review} />
          </aside>
        ) : (
        <aside
          data-testid="deliverable-quicklook-details"
          className={cn(
            "max-h-(--sz-50vh) w-full shrink-0 flex-col gap-5 overflow-y-auto border-t border-border bg-background p-4 md:flex md:max-h-none md:w-80 md:border-t-0 md:border-l md:p-5",
            showDetails ? "flex" : "hidden",
          )}
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{DELIVERABLE_KIND_LABELS[shown.kind]}</Badge>
              <DeliverableStageBadge stage={current.stage} />
              <ConfidentialityBadge value={shown.confidentiality} />
              <LinkStatusBadges deliverable={shown} />
            </div>
            <DialogDescription className="text-sm text-muted-foreground">
              {shown.summary ?? "No summary."}
            </DialogDescription>
          </div>

          <div className="flex flex-col gap-2">
            {liveEditPath(shown) ? (
              <Button asChild variant="default" size="sm" className="justify-start">
                <Link to={liveEditPath(shown)!} disableIssueQuicklook data-testid="deliverable-edit-live">
                  <Sparkles /> Edit live
                </Link>
              </Button>
            ) : null}
            {shown.external && shown.url ? (
              <>
                <Button asChild variant="default" size="sm" className="justify-start">
                  <a href={shown.url} target="_blank" rel="noopener noreferrer" data-testid="deliverable-open-site">
                    <ExternalLink /> Open site
                  </a>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-start"
                  disabled={screenshot.isPending}
                  onClick={() => screenshot.mutate()}
                >
                  <Camera /> {screenshot.isPending ? "Taking screenshot" : "Refresh screenshot"}
                </Button>
              </>
            ) : (
              <>
                <Button asChild variant={liveEditPath(shown) ? "outline" : "default"} size="sm" className="justify-start">
                  <a href={shown.downloadPath} download>
                    <Download /> Download
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm" className="justify-start">
                  <a href={shown.openPath} target="_blank" rel="noopener noreferrer">
                    <ExternalLink /> Open in new tab
                  </a>
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" className="justify-start" onClick={() => onCopyLink(current.id)}>
              <Link2 /> Copy link
            </Button>
            <Button asChild variant="outline" size="sm" className="justify-start">
              <Link to={shown.href} disableIssueQuicklook>
                <CircleCheck /> Open task
              </Link>
            </Button>
          </div>

          <dl className="flex flex-col gap-4">
            <PanelRow label="Task">
              <Link to={shown.href} disableIssueQuicklook className="hover:underline">
                <span className="font-mono text-xs text-muted-foreground">{shown.issue.identifier}</span>{" "}
                {shown.issue.title}
              </Link>
            </PanelRow>
            <PanelRow label="Made by">
              <span className="flex items-center gap-2">
                {shown.createdByAgent ? (
                  <AgentAvatar agent={shown.createdByAgent} size={20} />
                ) : null}
                {shown.createdByAgent?.name ?? "A person"}
              </span>
            </PanelRow>
            <PanelRow label="Created">
              <time dateTime={shown.createdAt}>{formatDateTime(shown.createdAt)}</time>
            </PanelRow>
            <PanelRow label="Brand">{shown.brand}</PanelRow>
            {shown.external ? (
              <PanelRow label="Site">
                <span className="break-all">{siteDomain(shown.url)}</span>
                {shown.linkCheck ? (
                  <span className="block text-xs text-muted-foreground">
                    Checked {formatDateTime(shown.linkCheck.lastCheckedAt)}
                    {shown.linkCheck.httpStatus ? `, answered ${shown.linkCheck.httpStatus}` : ", no answer"}
                  </span>
                ) : (
                  <span className="block text-xs text-muted-foreground">Not checked yet</span>
                )}
              </PanelRow>
            ) : null}
            <PanelRow label="Label">
              <NativeSelect
                aria-label="Confidentiality"
                value={current.confidentiality}
                disabled={relabel.isPending}
                onChange={(event) => relabel.mutate({ confidentiality: event.currentTarget.value as DeliverableConfidentiality })}
                data-testid="deliverable-confidentiality-select"
                className="h-8"
              >
                {(Object.keys(CONFIDENTIALITY_LABELS) as DeliverableConfidentiality[]).map((value) => (
                  <option key={value} value={value}>{CONFIDENTIALITY_LABELS[value]}</option>
                ))}
              </NativeSelect>
              {current.external ? (
                <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={current.restricted}
                    disabled={relabel.isPending}
                    onCheckedChange={(checked) => relabel.mutate({ restricted: checked === true })}
                  />
                  Password protected or unlisted
                </label>
              ) : null}
            </PanelRow>
          </dl>

          <DeliverableProjectAssignment
            title={current.title}
            project={current.project}
            clientName={current.clientCase?.name ?? null}
            projects={(projectList ?? []).filter((project) => !project.archivedAt).map((project) => ({ id: project.id, name: project.name }))}
            pending={move.isPending}
            onMove={(projectId) => move.mutate(projectId)}
          />

          {versions.length > 0 ? (
            <DeliverableVersionTimeline
              versions={versions}
              shownId={shown.id}
              onView={(id) => setVersionId(id === current.id ? null : id)}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Release {shown.version}</p>
          )}
        </aside>
        )}
      </DialogContent>
    </Dialog>
  );
}
