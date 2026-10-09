import type { GoalWithProgress } from "@greatstone/shared";
import { User } from "lucide-react";
import type { CompanyUserProfile } from "@/lib/company-members";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "../AgentAvatar";
import { Identity } from "../Identity";
import type { AgentsById } from "./GoalScoreboard";

export type UsersById = ReadonlyMap<string, CompanyUserProfile>;

type OwnedGoal = Pick<GoalWithProgress, "ownerAgentId" | "ownerUserId">;

/** The owner's display name, person or agent; null when nobody owns it. */
export function goalOwnerName(goal: OwnedGoal, agentsById: AgentsById, usersById?: UsersById): string | null {
  if (goal.ownerUserId) return usersById?.get(goal.ownerUserId)?.label ?? "A person";
  if (goal.ownerAgentId) return agentsById.get(goal.ownerAgentId)?.name ?? "An agent";
  return null;
}

/** Avatar and name of the goal owner. People get their photo or initials, agents their avatar. */
export function GoalOwner({
  goal,
  agentsById,
  usersById,
  className,
}: {
  goal: OwnedGoal;
  agentsById: AgentsById;
  usersById?: UsersById;
  className?: string;
}) {
  const name = goalOwnerName(goal, agentsById, usersById);
  if (goal.ownerUserId) {
    const profile = usersById?.get(goal.ownerUserId);
    return (
      <span className={cn("inline-flex min-w-0 items-center text-xs", className)} data-owner="person">
        <Identity name={name ?? "A person"} avatarUrl={profile?.image} size="xs" />
      </span>
    );
  }
  if (goal.ownerAgentId) {
    const agent = agentsById.get(goal.ownerAgentId);
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-1 text-xs", className)} data-owner="agent">
        <AgentAvatar agent={agent} name={name ?? undefined} size={16} />
        <span className="min-w-0 truncate">{name}</span>
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)} data-owner="none">
      <User className="size-3.5" aria-hidden />
      No owner
    </span>
  );
}
