import { useState } from "react";
import { Briefcase, Download, ExternalLink, Eye, FolderOpen, History } from "lucide-react";
import type { DeliverableVersion } from "@/api/deliverables";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { cn, formatDate } from "@/lib/utils";

// Version history as a progression (Ben, 10 Nov): Release 1, Release 2 and so
// on, newest first, so nobody opens an old version by mistake. The versions
// already exist (each review makes one); this only shows them plainly.

export function releaseLabel(version: number) {
  return `Release ${version}`;
}

/** Newest release first, whatever order they arrive in. */
export function sortVersionsNewestFirst<T extends Pick<DeliverableVersion, "version" | "createdAt">>(versions: readonly T[]): T[] {
  return [...versions].sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt));
}

/** Shown above an older release: says which one this is and which is current. */
export function OldVersionBanner({
  shownVersion,
  latestVersion,
  onViewLatest,
  className,
}: {
  shownVersion: number;
  latestVersion: number;
  onViewLatest: () => void;
  className?: string;
}) {
  if (shownVersion >= latestVersion) return null;
  return (
    <div
      role="status"
      data-testid="deliverable-old-version-banner"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-status-warning/30 bg-status-warning-soft px-4 py-2 text-sm text-status-warning-foreground",
        className,
      )}
    >
      <History className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        You're viewing {releaseLabel(shownVersion)}. The latest is {releaseLabel(latestVersion)}.
      </span>
      <Button variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={onViewLatest}>
        View the latest
      </Button>
    </div>
  );
}

/**
 * Every release of a deliverable, newest first. Each shows when, who, the
 * review note sent on it (or the maker's summary) and links to view or
 * download that release. The latest is marked Current; the one on screen is
 * marked Viewing.
 */
export function DeliverableVersionTimeline({
  versions,
  shownId,
  onView,
  className,
}: {
  versions: readonly DeliverableVersion[];
  shownId: string | null;
  onView: (id: string) => void;
  className?: string;
}) {
  const ordered = sortVersionsNewestFirst(versions);
  const latestId = ordered[0]?.id ?? null;
  return (
    <section className={cn("flex flex-col gap-2", className)} aria-label="Version history">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Releases</h3>
      <ol className="relative flex flex-col" data-testid="deliverable-version-timeline">
        {ordered.map((version, index) => {
          const isLatest = version.id === latestId;
          const isShown = version.id === shownId;
          const note = version.reviewNote ?? version.summary;
          const isLink = version.attachmentId === null;
          return (
            <li
              key={version.id}
              data-testid="deliverable-release"
              data-version={version.version}
              aria-current={isShown ? "true" : undefined}
              className="relative flex gap-3 pb-4 last:pb-0"
            >
              <span aria-hidden="true" className="relative flex w-3 shrink-0 justify-center">
                <span
                  className={cn(
                    "mt-1.5 h-2.5 w-2.5 rounded-full border-2",
                    isLatest ? "border-primary bg-primary" : "border-border bg-background",
                  )}
                />
                {index < ordered.length - 1 ? (
                  <span className="absolute top-5 bottom-0 w-px bg-border" />
                ) : null}
              </span>
              <div
                className={cn(
                  "flex min-w-0 flex-1 flex-col gap-1 rounded-md px-2 py-1.5",
                  isShown && "bg-accent text-accent-foreground",
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold">{releaseLabel(version.version)}</span>
                  {isLatest ? (
                    <Badge variant="outline" className="border-status-success/40 bg-status-success-soft text-status-success-foreground">
                      Current
                    </Badge>
                  ) : null}
                  {isShown && !isLatest ? <Badge variant="outline">Viewing</Badge> : null}
                  {version.status === "draft" ? <Badge variant="outline">Draft</Badge> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  <time dateTime={version.createdAt}>{formatDate(version.createdAt)}</time>
                  {" · "}
                  {version.createdByAgent?.name ?? "A person"}
                </p>
                {note ? (
                  <p className="line-clamp-3 text-sm text-foreground" title={note}>
                    {version.reviewNote ? <span className="text-muted-foreground">Review note: </span> : null}
                    {note}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  <Button
                    variant={isShown ? "secondary" : "outline"}
                    size="sm"
                    className="min-h-11 md:min-h-8"
                    aria-label={`View ${releaseLabel(version.version)}`}
                    onClick={() => onView(version.id)}
                  >
                    <Eye /> View
                  </Button>
                  <Button asChild variant="ghost" size="sm" className="min-h-11 md:min-h-8">
                    {isLink ? (
                      <a href={version.contentPath} target="_blank" rel="noopener noreferrer" aria-label={`Open ${releaseLabel(version.version)} in a new tab`}>
                        <ExternalLink /> Open
                      </a>
                    ) : (
                      <a href={version.downloadPath} download aria-label={`Download ${releaseLabel(version.version)}`}>
                        <Download /> Download
                      </a>
                    )}
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export interface ProjectChoice {
  id: string;
  name: string;
}

/**
 * Which project and client a deliverable belongs to, and a way for a person
 * to move it (Ben, 10 Nov: the latest portal sat under the wrong project, so
 * it was invisible where people looked). Moving asks to confirm; the server
 * refuses agents and records the move in the activity log.
 */
export function DeliverableProjectAssignment({
  title,
  project,
  clientName,
  projects,
  canMove = true,
  pending = false,
  onMove,
}: {
  title: string;
  project: ProjectChoice | null;
  clientName: string | null;
  projects: readonly ProjectChoice[];
  canMove?: boolean;
  pending?: boolean;
  onMove: (projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState("");
  const choices = projects.filter((choice) => choice.id !== project?.id);
  const target = choices.find((choice) => choice.id === targetId) ?? null;
  return (
    <div className="flex flex-col gap-2" data-testid="deliverable-project-assignment">
      <dl className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm">
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <dt className="sr-only">Project</dt>
          <dd className="min-w-0 truncate" data-testid="deliverable-assigned-project">{project?.name ?? "No project"}</dd>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Briefcase className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <dt className="sr-only">Client</dt>
          <dd className="min-w-0 truncate" data-testid="deliverable-assigned-client">{clientName ?? "No client"}</dd>
        </div>
      </dl>
      {canMove ? (
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 justify-start md:min-h-8"
          disabled={pending || choices.length === 0}
          onClick={() => {
            setTargetId("");
            setOpen(true);
          }}
          data-testid="deliverable-move-open"
        >
          <FolderOpen /> Move to another project
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move to another project</DialogTitle>
            <DialogDescription>
              Every release of "{title}" moves together. It shows under the new project and its client, and the move is
              recorded in the activity log.
            </DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">New project</span>
            <NativeSelect
              aria-label="New project"
              value={targetId}
              onChange={(event) => setTargetId(event.currentTarget.value)}
              className="min-h-11 md:min-h-9"
              data-testid="deliverable-move-select"
            >
              <option value="">Choose a project</option>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>{choice.name}</option>
              ))}
            </NativeSelect>
          </label>
          {target ? (
            <p className="text-sm" data-testid="deliverable-move-summary">
              Move from <strong>{project?.name ?? "no project"}</strong> to <strong>{target.name}</strong>?
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" className="min-h-11 md:min-h-9" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="min-h-11 md:min-h-9"
              disabled={!target || pending}
              data-testid="deliverable-move-confirm"
              onClick={() => {
                if (!target) return;
                onMove(target.id);
                setOpen(false);
              }}
            >
              Move deliverable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
