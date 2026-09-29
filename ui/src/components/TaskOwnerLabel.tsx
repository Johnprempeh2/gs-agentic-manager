import { Bot, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { resolveTaskOwner, type TaskOwnerKind } from "../lib/assignees";
import { cn } from "../lib/utils";

const TASK_OWNER_TONE: Record<TaskOwnerKind, string> = {
  agent: "border-border bg-secondary text-secondary-foreground",
  you: "border-primary/40 bg-primary/10 text-foreground",
  person: "border-border text-foreground",
};

export interface TaskOwnerLabelProps {
  issue: { assigneeAgentId?: string | null; assigneeUserId?: string | null };
  currentUserId: string | null | undefined;
  userLabels?: ReadonlyMap<string, string> | Record<string, string> | null;
  className?: string;
}

/**
 * The one "who is this task for" label on task rows: board cards, Tasks,
 * My tasks and Inbox. Unassigned tasks render nothing.
 */
export function TaskOwnerLabel({ issue, currentUserId, userLabels, className }: TaskOwnerLabelProps) {
  const owner = resolveTaskOwner(issue, currentUserId, userLabels);
  if (!owner) return null;
  const Icon = owner.kind === "agent" ? Bot : User;
  return (
    <Badge
      variant="outline"
      data-testid="task-owner-label"
      data-owner-kind={owner.kind}
      title={owner.label}
      className={cn(
        "max-w-32 shrink-0 gap-1 px-1.5 py-0 text-xs leading-4 [&>svg]:size-3",
        TASK_OWNER_TONE[owner.kind],
        className,
      )}
    >
      <Icon aria-hidden />
      <span className="truncate">{owner.label}</span>
    </Badge>
  );
}
