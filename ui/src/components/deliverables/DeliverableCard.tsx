import { Download, ExternalLink, Eye, Link2 } from "lucide-react";
import type { Deliverable, DeliverableKind } from "@/api/deliverables";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/lib/router";
import { cn, formatDate } from "@/lib/utils";
import { DeliverableThumbnail } from "./DeliverableDocument";

export const DELIVERABLE_KIND_LABELS: Record<DeliverableKind, string> = {
  report: "Report",
  brief: "Brief",
  plan: "Plan",
  deck: "Deck",
  other: "Other",
};

/** Absolute link that opens this deliverable in Quick Look on the Deliverables page. */
export function deliverableShareUrl(id: string) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("open", id);
  return url.toString();
}

function QuickAction({
  label,
  onClick,
  href,
  download,
  children,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  download?: boolean;
  children: React.ReactNode;
}) {
  const className =
    "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  if (href) {
    return (
      <a
        href={href}
        {...(download ? { download: "" } : { target: "_blank", rel: "noreferrer" })}
        title={label}
        aria-label={label}
        className={className}
      >
        {children}
      </a>
    );
  }
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className={className}>
      {children}
    </button>
  );
}

export function DeliverableCard({
  deliverable,
  onPreview,
  onCopyLink,
}: {
  deliverable: Deliverable;
  onPreview: () => void;
  onCopyLink: () => void;
}) {
  return (
    <article
      data-testid="deliverable-card"
      className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm transition duration-150 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md focus-within:border-foreground/20 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <button
        type="button"
        onClick={onPreview}
        aria-label={`Preview ${deliverable.title}`}
        data-testid="deliverable-card-preview"
        className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <DeliverableThumbnail source={deliverable} />
      </button>

      <div
        className="absolute right-2 top-2 flex items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-within:opacity-100"
      >
        <QuickAction label="Preview" onClick={onPreview}>
          <Eye className="h-3.5 w-3.5" />
        </QuickAction>
        <QuickAction label="Open in new tab" href={deliverable.openPath}>
          <ExternalLink className="h-3.5 w-3.5" />
        </QuickAction>
        <QuickAction label="Download" href={deliverable.downloadPath} download>
          <Download className="h-3.5 w-3.5" />
        </QuickAction>
        <QuickAction label="Copy link" onClick={onCopyLink}>
          <Link2 className="h-3.5 w-3.5" />
        </QuickAction>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary">{DELIVERABLE_KIND_LABELS[deliverable.kind]}</Badge>
          <span className="truncate text-xs text-muted-foreground">{deliverable.brand}</span>
          {deliverable.status === "draft" ? (
            <Badge variant="outline" className="ml-auto">Draft</Badge>
          ) : null}
        </div>
        <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-foreground" title={deliverable.title}>
          {deliverable.title}
        </h3>
        {deliverable.summary ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{deliverable.summary}</p>
        ) : null}
        <div className={cn("mt-auto flex items-center gap-2 pt-1 text-xs text-muted-foreground")}>
          {deliverable.createdByAgent ? (
            <AgentAvatar agent={deliverable.createdByAgent} size={20} label={deliverable.createdByAgent.name} />
          ) : null}
          <span className="truncate">{deliverable.createdByAgent?.name ?? "Board"}</span>
          <span aria-hidden="true">·</span>
          <Link
            to={deliverable.href}
            disableIssueQuicklook
            className="shrink-0 font-mono hover:text-foreground hover:underline"
          >
            {deliverable.issue.identifier}
          </Link>
          <span aria-hidden="true">·</span>
          <time dateTime={deliverable.createdAt} className="shrink-0">{formatDate(deliverable.createdAt)}</time>
          {deliverable.versionCount > 1 ? (
            <span className="ml-auto shrink-0">v{deliverable.version}</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}
