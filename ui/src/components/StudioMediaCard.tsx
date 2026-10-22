import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertCircle, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface StudioMediaCardProps {
  /** CSS aspect ratio of the media, for example "16 / 9". */
  aspectRatio: string;
  status: "pending" | "completed" | "failed";
  /** The finished picture or clip; fills the card. */
  media?: ReactNode;
  /** Status line while it is being made. */
  pendingLabel: string;
  /** Inline error on the card when making it failed. */
  failure?: { message: string; detail?: string | null; onRetry: () => void; retrying?: boolean };
  /** Quick actions, shown over the media on hover or keyboard focus (always on touch screens). */
  actions?: ReactNode;
  /** Small marks that always show, top left (for example a favourite star). */
  badges?: ReactNode;
  /** Prompt and details under the media. */
  caption?: ReactNode;
  className?: string;
  "data-testid"?: string;
}

/**
 * One result in the studio gallery: media first, edge to edge in a rounded
 * card, with quick actions over it on hover or focus, a shimmer while it is
 * being made and the error inline when it failed.
 */
export function StudioMediaCard({
  aspectRatio,
  status,
  media,
  pendingLabel,
  failure,
  actions,
  badges,
  caption,
  className,
  "data-testid": testId,
}: StudioMediaCardProps) {
  return (
    <figure
      className={cn(
        "group mb-4 flex break-inside-avoid flex-col gap-2 transition-transform duration-300 motion-safe:hover:-translate-y-0.5",
        className,
      )}
      data-testid={testId}
      data-status={status}
    >
      <div
        className="relative w-full overflow-hidden rounded-xl bg-muted ring-1 ring-border transition-shadow group-hover:ring-ring"
        style={{ aspectRatio }}
      >
        {status === "completed" ? (
          media
        ) : status === "pending" ? (
          <div className="gs-skeleton flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center" role="status">
            <Loader2 className="h-6 w-6 text-foreground motion-safe:animate-spin" aria-hidden="true" />
            <span className="text-xs font-medium text-foreground">{pendingLabel}</span>
          </div>
        ) : failure ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
            <AlertCircle className="h-5 w-5 text-destructive" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">{failure.message}</p>
            {failure.detail ? (
              <p className="line-clamp-2 text-xs text-muted-foreground" title={failure.detail}>
                {failure.detail}
              </p>
            ) : null}
            <Button size="sm" variant="outline" onClick={failure.onRetry} disabled={failure.retrying}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Try again
            </Button>
          </div>
        ) : null}
        {badges && status === "completed" ? <div className="absolute left-2 top-2 flex gap-1">{badges}</div> : null}
        {actions && status === "completed" ? (
          <div
            className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
            data-testid="studio-card-actions"
          >
            {actions}
          </div>
        ) : null}
      </div>
      {caption ? <figcaption className="space-y-1 px-0.5">{caption}</figcaption> : null}
    </figure>
  );
}

const ACTION_CLASS =
  "grid size-8 pointer-coarse:size-10 place-items-center rounded-full bg-background/80 text-foreground shadow-sm outline-none backdrop-blur-sm transition-colors hover:bg-background focus-visible:ring-(length:--rad-3) focus-visible:ring-ring disabled:pointer-events-none disabled:text-subtle-foreground";

/** A round icon action for a media card overlay: a button, or a link when given an href. */
export function StudioMediaAction({
  icon: Icon,
  label,
  onClick,
  href,
  download,
  pressed,
  disabled,
  iconClassName,
  "data-testid": testId,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  href?: string;
  download?: string;
  pressed?: boolean;
  disabled?: boolean;
  iconClassName?: string;
  "data-testid"?: string;
}) {
  const icon = <Icon className={cn("h-4 w-4", iconClassName)} aria-hidden="true" />;
  if (href) {
    return (
      <a href={href} download={download} aria-label={label} title={label} className={ACTION_CLASS} data-testid={testId}>
        {icon}
      </a>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className={ACTION_CLASS}
      data-testid={testId}
    >
      {icon}
    </button>
  );
}

/** Classes for an image or clip that fills a media card and zooms gently on hover. */
export const STUDIO_MEDIA_CLASS =
  "h-full w-full object-cover transition-transform duration-300 motion-safe:group-hover:scale-105";

/** The masonry grid the cards sit in. */
export const STUDIO_GALLERY_CLASS = "columns-1 gap-4 sm:columns-2 lg:columns-3 2xl:columns-4";

/**
 * The gallery before anything is made: a few quiet frames, a short line, and
 * ready-made prompts as chips so the first try is one tap away.
 */
export function StudioEmptyGallery({
  icon: Icon,
  title,
  message,
  suggestions,
  disabled,
}: {
  icon: LucideIcon;
  title: string;
  message: string;
  suggestions?: ReadonlyArray<{ label: string; onPick: () => void }>;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-5 rounded-xl border border-dashed border-border p-4 sm:p-6" data-testid="studio-empty-gallery">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden="true">
        {["aspect-square", "aspect-video", "aspect-3/4", "aspect-4/3"].map((shape, index) => (
          <div
            key={shape}
            className={cn("grid place-items-center rounded-xl bg-muted max-sm:aspect-4/3", shape, index > 1 && "max-sm:hidden")}
          >
            <Icon className="h-6 w-6 text-muted-foreground" />
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <p className="text-base font-semibold text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
      {suggestions && suggestions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Try one of these">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Try one of these
          </span>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              disabled={disabled}
              onClick={suggestion.onPick}
              className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-(length:--rad-3) focus-visible:ring-ring disabled:pointer-events-none disabled:text-subtle-foreground"
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
