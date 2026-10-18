import { useId, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StudioComposerChip {
  id: string;
  icon: LucideIcon;
  /** What the chip sets, for example "Shape". */
  label: string;
  /** The current pick, for example "Square". Shown on the chip when set. */
  value?: string | null;
  /** The settings this chip opens, shown above the prompt. */
  panel: ReactNode;
}

interface StudioComposerProps {
  /** Heading for the composer region (read by screen readers, shown small). */
  title: string;
  /** Optional line beside the title, for example which service is used. */
  aside?: ReactNode;
  /** Shown above everything, for example a "not switched on" note or a source image. */
  notice?: ReactNode;
  /** The prompt field. */
  children: ReactNode;
  chips: StudioComposerChip[];
  /** The chip whose panel is open, or null. */
  openChip: string | null;
  onOpenChipChange: (id: string | null) => void;
  /** The one bright primary action. */
  action: ReactNode;
  /** A short muted line under the bar. */
  footnote?: ReactNode;
  className?: string;
  "data-tour"?: string;
}

/**
 * The studio's floating prompt bar: the prompt, a row of compact setting chips
 * and one bright Generate action. Each chip opens its settings above the
 * prompt, one at a time. On a phone the bar docks at the bottom of the screen
 * (its parent must be a flex column) and the chips scroll sideways inside it.
 */
export function StudioComposer({
  title,
  aside,
  notice,
  children,
  chips,
  openChip,
  onOpenChipChange,
  action,
  footnote,
  className,
  "data-tour": dataTour,
}: StudioComposerProps) {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const open = chips.find((chip) => chip.id === openChip) ?? null;

  return (
    <section
      aria-labelledby={titleId}
      data-tour={dataTour}
      data-testid="studio-composer"
      className={cn(
        "gs-glass-card space-y-3 rounded-xl border bg-card p-3 shadow-sm transition-colors focus-within:border-ring sm:p-4",
        "max-md:sticky max-md:bottom-(--tc-composer-bottom) max-md:z-sticky max-md:order-last",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <h2 id={titleId} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {aside ? <span className="ml-auto truncate text-xs text-muted-foreground">{aside}</span> : null}
      </div>
      {notice}
      {chips.map((chip) => (
        <div
          key={chip.id}
          id={`${baseId}-${chip.id}`}
          role="group"
          aria-label={chip.label}
          hidden={chip.id !== open?.id}
          className="space-y-3 rounded-lg border border-border bg-background p-3 max-md:max-h-(--sz-50vh) max-md:overflow-y-auto"
          data-testid={`studio-panel-${chip.id}`}
        >
          {chip.panel}
        </div>
      ))}
      {children}
      <div className="flex items-center gap-2">
        <div
          className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto scrollbar-none"
          role="toolbar"
          aria-label="Settings"
          data-testid="studio-chips"
        >
          {chips.map((chip) => {
            const Icon = chip.icon;
            const expanded = chip.id === open?.id;
            return (
              <button
                key={chip.id}
                type="button"
                aria-expanded={expanded}
                aria-controls={`${baseId}-${chip.id}`}
                aria-label={chip.value ? `${chip.label}: ${chip.value}` : chip.label}
                title={chip.value ? `${chip.label}: ${chip.value}` : chip.label}
                onClick={() => onOpenChipChange(expanded ? null : chip.id)}
                className={cn(
                  "inline-flex h-8 max-w-48 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors outline-none",
                  "focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
                  expanded
                    ? "border-ring bg-accent text-accent-foreground"
                    : "border-border bg-muted text-foreground hover:bg-accent hover:text-accent-foreground",
                )}
                data-testid={`studio-chip-${chip.id}`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{chip.value || chip.label}</span>
                <ChevronDown
                  className={cn("h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none", expanded && "rotate-180")}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      {footnote ? <p className="text-xs text-muted-foreground max-md:hidden">{footnote}</p> : null}
    </section>
  );
}

/** The bright lime Generate button style, for the composer's action slot. */
export const STUDIO_GENERATE_CLASS =
  "rounded-full bg-highlight px-5 font-semibold text-highlight-foreground hover:bg-highlight/90";

/** A borderless prompt box that sits inside the composer bar. */
export const STUDIO_PROMPT_CLASS =
  "max-h-(--sz-28dvh) min-h-16 resize-none border-0 bg-transparent px-1 shadow-none focus-visible:shadow-none focus-visible:ring-0 dark:bg-transparent";
