import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A compact studio tool tile: icon, title, one muted line and an optional
 * small badge ("New", "Top"). On a phone it shrinks to icon and title on one
 * line, so all six tiles fit above the composer. Selected tiles carry aria-pressed.
 */
export function StudioModeTile({
  icon: Icon,
  title,
  description,
  badge,
  selected,
  onClick,
  "data-testid": testId,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  badge?: string;
  selected?: boolean;
  onClick: () => void;
  "data-testid"?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "gs-glass-card flex min-h-12 min-w-0 flex-col items-start gap-2 rounded-xl border bg-card p-3 text-left max-sm:flex-row max-sm:items-center outline-none transition-all duration-200",
        "motion-safe:hover:-translate-y-0.5 hover:border-ring focus-visible:ring-(length:--rad-3) focus-visible:ring-ring motion-reduce:transition-none",
        selected && "border-ring bg-accent",
      )}
      data-testid={testId}
    >
      <Icon className="h-5 w-5 shrink-0 text-foreground" aria-hidden="true" />
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="truncate text-sm font-semibold text-foreground">{title}</span>
        {badge ? (
          <span className="shrink-0 rounded-full bg-highlight max-sm:hidden px-1.5 py-0.5 text-xs font-bold uppercase leading-none text-highlight-foreground">
            {badge}
          </span>
        ) : null}
      </span>
      <span className="line-clamp-2 text-xs text-muted-foreground max-sm:sr-only">{description}</span>
    </button>
  );
}
