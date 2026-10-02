import type { AgentTeam } from "@greatstone/shared";
import { cn } from "../lib/utils";
import { TeamColorDot } from "./AgentTeamsDialog";

/** The team a task is assigned to (GRE-437). */
export function TeamBadge({ team, className }: { team: Pick<AgentTeam, "name" | "color">; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-32 shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground",
        className,
      )}
      title={`Team: ${team.name}`}
      data-testid="issue-team-badge"
    >
      <TeamColorDot color={team.color} className="h-2 w-2" />
      <span className="truncate">{team.name}</span>
    </span>
  );
}
