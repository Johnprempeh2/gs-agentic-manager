import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight, CircleCheck, Download, ExternalLink, Link2, MessageSquarePlus, X } from "lucide-react";
import { deliverablesApi, type Deliverable } from "@/api/deliverables";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import { DeliverableCommentsPanel, DeliverableReviewFrame, useDeliverableReview } from "./DeliverableComments";
import { DeliverableDocumentView, isHtmlDeliverable } from "./DeliverableDocument";
import { DELIVERABLE_KIND_LABELS } from "./DeliverableCard";

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

  const hasPrevious = index > 0;
  const hasNext = index < items.length - 1;

  if (!current) return null;
  const shown = detail && detail.id === shownId ? detail : current;
  const versions = detail?.versions ?? [];
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
        className={cn(
          "inset-0 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 sm:max-w-none md:top-0 md:translate-y-0",
          reviewing && "flex-col md:flex-row",
        )}
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
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close preview">
                <X />
              </Button>
            </DialogClose>
          </div>
          <div className="min-h-0 flex-1 bg-muted/40">
            {reviewing ? <DeliverableReviewFrame review={review} title={shown.title} /> : <DeliverableDocumentView source={shown} />}
          </div>
        </div>

        {reviewing ? (
          <aside className="flex max-h-[45dvh] w-full shrink-0 flex-col overflow-y-auto border-t border-border bg-background p-4 md:max-h-none md:w-80 md:border-t-0 md:border-l md:p-5">
            <DeliverableCommentsPanel review={review} />
          </aside>
        ) : (
        <aside className="hidden w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l border-border bg-background p-5 md:flex">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{DELIVERABLE_KIND_LABELS[shown.kind]}</Badge>
              <Badge variant="outline">{shown.status === "draft" ? "Draft" : "Final"}</Badge>
            </div>
            <DialogDescription className="text-sm text-muted-foreground">
              {shown.summary ?? "No summary."}
            </DialogDescription>
          </div>

          <div className="flex flex-col gap-2">
            <Button asChild variant="default" size="sm" className="justify-start">
              <a href={shown.downloadPath} download>
                <Download /> Download
              </a>
            </Button>
            <Button asChild variant="outline" size="sm" className="justify-start">
              <a href={shown.openPath} target="_blank" rel="noreferrer">
                <ExternalLink /> Open in new tab
              </a>
            </Button>
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
                {shown.createdByAgent?.name ?? "Board"}
              </span>
            </PanelRow>
            <PanelRow label="Created">
              <time dateTime={shown.createdAt}>{formatDateTime(shown.createdAt)}</time>
            </PanelRow>
            <PanelRow label="Brand">{shown.brand}</PanelRow>
            {shown.project ? <PanelRow label="Project">{shown.project.name}</PanelRow> : null}
          </dl>

          <section className="flex flex-col gap-2" aria-label="Version history">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Versions</h3>
            {versions.length === 0 ? (
              <p className="text-sm text-muted-foreground">v{shown.version}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {versions.map((version) => (
                  <li key={version.id}>
                    <button
                      type="button"
                      onClick={() => setVersionId(version.id === current.id ? null : version.id)}
                      aria-current={version.id === shown.id ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50",
                        version.id === shown.id && "bg-accent text-foreground",
                      )}
                    >
                      <span>
                        v{version.version}
                        {version.status === "draft" ? <span className="ml-1.5 text-xs text-muted-foreground">Draft</span> : null}
                      </span>
                      <span className="text-xs text-muted-foreground">{formatDate(version.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
        )}
      </DialogContent>
    </Dialog>
  );
}
