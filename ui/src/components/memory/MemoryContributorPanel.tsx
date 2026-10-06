import type { MouseEvent } from "react";
import { Bot, Crown, ShieldCheck, User, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "../AgentAvatar";
import { Button } from "../ui/button";
import type { MemoryContributor } from "./memoryContributors";
import type { MemoryGraphFocusMode } from "./memoryGraph3dData";

interface MemoryContributorPanelProps {
  contributors: MemoryContributor[];
  /** Total entries the server sent, for the "All agents" row. */
  total: number;
  selected: string[];
  /** `additive` is true for Ctrl, Cmd or Shift click: add or remove, keeping the rest. */
  onToggle: (key: string, additive: boolean) => void;
  onReset: () => void;
  focusMode: MemoryGraphFocusMode;
  onFocusModeChange: (mode: MemoryGraphFocusMode) => void;
  /** Hide and dim only mean something beside the graph. */
  showFocusMode: boolean;
  className?: string;
}

function ContributorIcon({ contributor }: { contributor: MemoryContributor }) {
  if (contributor.agent) return <AgentAvatar agent={contributor.agent} name={contributor.name} size={24} />;
  const Icon = contributor.actorType === "agent" ? Bot : contributor.actorType === "user" ? User : ShieldCheck;
  return (
    <span aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <Icon className="size-3.5" />
    </span>
  );
}

const rowClass =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Who contributed the entries on screen. Clicking one focuses the graph and list on
 * that contributor's entries and their direct connections; Ctrl or Cmd click adds more.
 */
export function MemoryContributorPanel({
  contributors,
  total,
  selected,
  onToggle,
  onReset,
  focusMode,
  onFocusModeChange,
  showFocusMode,
  className,
}: MemoryContributorPanelProps) {
  const chosen = new Set(selected);
  const onRowClick = (key: string) => (event: MouseEvent<HTMLButtonElement>) =>
    onToggle(key, event.ctrlKey || event.metaKey || event.shiftKey);

  return (
    <nav aria-label="Contributors" className={cn("flex min-h-0 flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between px-2 text-xs text-muted-foreground">
        <span className="font-medium">Contributors</span>
        <span className="tabular-nums">{contributors.length}</span>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto" aria-label="Focus on a contributor">
        <li>
          <button type="button" aria-pressed={chosen.size === 0} onClick={onReset} className={cn(rowClass, chosen.size === 0 && "bg-accent text-accent-foreground")}>
            <span aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Users className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">All agents</span>
            <span className="text-xs tabular-nums text-muted-foreground">{total}</span>
          </button>
        </li>
        {contributors.map((contributor) => {
          const pressed = chosen.has(contributor.key);
          return (
            <li key={contributor.key}>
              <button
                type="button"
                data-contributor={contributor.key}
                aria-pressed={pressed}
                onClick={onRowClick(contributor.key)}
                title={contributor.isCeo ? `${contributor.name}, main agent` : contributor.name}
                className={cn(rowClass, pressed && "bg-accent text-accent-foreground")}
              >
                <ContributorIcon contributor={contributor} />
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  <span className={cn("truncate", contributor.isCeo && "font-semibold")}>{contributor.name}</span>
                  {contributor.isCeo ? (
                    <>
                      <Crown aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                      <span className="sr-only">(main agent)</span>
                    </>
                  ) : null}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">{contributor.count}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {showFocusMode && chosen.size > 0 ? (
        <div role="group" aria-label="Everything else" className="flex items-center gap-1 px-2 text-xs text-muted-foreground">
          <span className="pr-1">Others</span>
          <Button type="button" size="xs" variant={focusMode === "hide" ? "secondary" : "ghost"} aria-pressed={focusMode === "hide"} onClick={() => onFocusModeChange("hide")}>
            Hide
          </Button>
          <Button type="button" size="xs" variant={focusMode === "dim" ? "secondary" : "ghost"} aria-pressed={focusMode === "dim"} onClick={() => onFocusModeChange("dim")}>
            Dim
          </Button>
        </div>
      ) : null}
      <p className="px-2 text-xs text-muted-foreground">Ctrl or Cmd click to focus on more than one.</p>
    </nav>
  );
}
