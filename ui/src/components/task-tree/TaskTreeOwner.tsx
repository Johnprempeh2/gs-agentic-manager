import type { Agent } from "@greatstone/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { deriveInitials, Identity } from "@/components/Identity";
import type { CompanyUserProfile } from "@/lib/company-members";
import { cn } from "@/lib/utils";

/** Who can own a task in the tree: the company's agents and people. */
export interface TaskTreePeople {
  agents: ReadonlyMap<string, Pick<Agent, "id" | "name" | "appearance">>;
  users: ReadonlyMap<string, CompanyUserProfile>;
  /** The signed-in user, so their own tasks read "You". */
  viewerUserId?: string | null;
}

export function ownerName(
  people: TaskTreePeople,
  owner: { assigneeAgentId: string | null; assigneeUserId: string | null },
): string | null {
  if (owner.assigneeAgentId) return people.agents.get(owner.assigneeAgentId)?.name ?? "An agent";
  if (owner.assigneeUserId) {
    if (owner.assigneeUserId === people.viewerUserId) return "You";
    return people.users.get(owner.assigneeUserId)?.label ?? "A teammate";
  }
  return null;
}

/** Owner avatar (agent avatar, or a person's initials) with their name. */
export function TaskTreeOwner({
  people,
  owner,
  className,
}: {
  people: TaskTreePeople;
  owner: { assigneeAgentId: string | null; assigneeUserId: string | null };
  className?: string;
}) {
  const name = ownerName(people, owner);
  if (!name) return <span className={cn("truncate text-xs text-muted-foreground", className)}>No owner yet</span>;
  if (owner.assigneeAgentId) {
    const agent = people.agents.get(owner.assigneeAgentId);
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
        <AgentAvatar agent={agent} name={name} size={20} className="rounded-full bg-muted" />
        <span className="truncate text-xs text-muted-foreground">{name}</span>
      </span>
    );
  }
  const profile = owner.assigneeUserId ? people.users.get(owner.assigneeUserId) : undefined;
  return (
    <Identity
      name={name}
      initials={deriveInitials(profile?.label ?? name)}
      avatarUrl={profile?.image ?? null}
      size="xs"
      className={cn("text-muted-foreground [&>span:last-child]:text-xs", className)}
    />
  );
}
