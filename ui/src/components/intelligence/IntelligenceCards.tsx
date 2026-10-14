import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ExternalLink, Minus, Star } from "lucide-react";
import type { IntelligenceBoardMovement } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** External source link: every intelligence item carries one. */
export function SourceLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
        className,
      )}
    >
      <span className="truncate">{children}</span>
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

/** One to five stars, with the value spoken. */
export function RatingStars({ value, label }: { value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" aria-label={`${label}: ${value} of 5`} role="img">
      <span aria-hidden="true">{label}</span>
      <span className="inline-flex" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((n) => (
          <Star key={n} className={cn("h-3.5 w-3.5", n <= value ? "fill-current text-status-warning" : "text-border")} />
        ))}
      </span>
    </span>
  );
}

/** Rank movement against the compared snapshot: up, down, new, or no change. */
export function MovementChip({ movement }: { movement: IntelligenceBoardMovement }) {
  if (movement.isNew) {
    return <span className="rounded-full bg-status-info-soft px-1.5 py-0.5 text-xs font-medium text-status-info-foreground">New</span>;
  }
  if (movement.rankDelta === null) return <span className="text-xs text-muted-foreground" aria-label="No earlier snapshot">·</span>;
  if (movement.rankDelta === 0) {
    return (
      <span className="inline-flex items-center text-xs text-muted-foreground" aria-label="No change">
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    );
  }
  const up = movement.rankDelta > 0;
  const Icon = up ? ArrowUp : ArrowDown;
  const places = Math.abs(movement.rankDelta);
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 text-xs font-medium", up ? "text-status-success" : "text-status-danger")}
      aria-label={`${up ? "Up" : "Down"} ${places} ${places === 1 ? "place" : "places"}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {places}
    </span>
  );
}

/** Section heading with a count, over a responsive card grid (one column on a phone). */
export function IntelligenceSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
          {count !== undefined ? <span className="ml-2 font-mono normal-case">{count}</span> : null}
        </h2>
        {action}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

/**
 * The two-layer card: one-sentence verdict, at most three short points and one
 * "Do this" line. Anything longer goes in `analysis`, behind "Full analysis".
 */
export function VerdictCard({
  eyebrow,
  title,
  href,
  verdict,
  points = [],
  action,
  meta,
  analysis,
  footer,
  leading,
  media,
  hero = false,
  className,
}: {
  eyebrow?: ReactNode;
  title: string;
  href?: string;
  verdict?: string;
  points?: string[];
  action?: string;
  meta?: ReactNode;
  analysis?: ReactNode;
  footer?: ReactNode;
  /** Brand logo beside the eyebrow. */
  leading?: ReactNode;
  /** Full-bleed image on top, in a fixed-ratio box. */
  media?: ReactNode;
  /** The lead story: larger title and verdict. */
  hero?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-muted-foreground/40",
        className,
      )}
    >
      {media}
      <div className={cn("flex min-w-0 flex-1 flex-col gap-2 p-4", hero ? "gap-3 sm:p-5" : null)}>
        {eyebrow || leading ? (
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {leading}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{eyebrow}</div>
          </div>
        ) : null}
        <h3 className={cn("font-semibold leading-snug", hero ? "text-lg" : "text-sm")}>
          {href ? (
            <a href={href} target="_blank" rel="noreferrer noopener" className="hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
              {title}
              <ExternalLink className="ml-1 inline h-3 w-3 text-muted-foreground" aria-hidden="true" />
            </a>
          ) : (
            title
          )}
        </h3>
        {verdict ? <p className={hero ? "text-base" : "text-sm"}>{verdict}</p> : null}
        {points.length > 0 ? (
          <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
            {points.slice(0, 3).map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        ) : null}
        {action ? (
          <p className="rounded-md border border-status-success/30 bg-status-success/10 px-3 py-2 text-sm">
            <span className="font-semibold">Do this: </span>
            {action}
          </p>
        ) : null}
        {meta ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{meta}</div> : null}
        {analysis || footer ? (
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
            {analysis ? (
              <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                Full analysis
              </Button>
            ) : null}
            {footer}
          </div>
        ) : null}
      </div>
      {analysis ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
            <SheetHeader>
              <SheetTitle className="pr-6 leading-snug">{title}</SheetTitle>
              {verdict ? <SheetDescription>{verdict}</SheetDescription> : null}
            </SheetHeader>
            <div className="space-y-4 px-4 pb-6 text-sm">{analysis}</div>
          </SheetContent>
        </Sheet>
      ) : null}
    </article>
  );
}
