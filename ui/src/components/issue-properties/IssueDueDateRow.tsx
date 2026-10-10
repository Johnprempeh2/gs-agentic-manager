import { useQuery } from "@tanstack/react-query";
import { findPlanObjective, type StrategyBoardGoal } from "@greatstone/shared";
import { X } from "lucide-react";
import { goalsApi } from "@/api/goals";
import { Input } from "@/components/ui/input";
import { queryKeys } from "@/lib/queryKeys";
import { PropertyRow } from "./primitives";

/**
 * Due date of a plan action (GRE-1188). The row shows only on a task under a
 * plan objective (the server refuses a date anywhere else), or on a task that
 * still carries one.
 */
export function dueDateRowState(
  goalId: string | null,
  dueDate: string | null | undefined,
  goals: readonly StrategyBoardGoal[] | undefined,
): "hidden" | "editable" | "read_only" {
  const onPlan = goals ? findPlanObjective(goalId, new Map(goals.map((goal) => [goal.id, goal]))) != null : false;
  if (onPlan) return "editable";
  return dueDate ? "read_only" : "hidden";
}

/** True when the date is before today (local calendar day). */
export function isPastDue(dueDate: string, today: Date = new Date()): boolean {
  const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return dueDate < local;
}

export function IssueDueDateRow({
  companyId,
  goalId,
  dueDate,
  status,
  onUpdate,
}: {
  companyId: string;
  goalId: string | null;
  dueDate: string | null | undefined;
  status: string;
  onUpdate: (data: Record<string, unknown>) => void;
}) {
  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
    enabled: !!goalId || !!dueDate,
  });
  const state = dueDateRowState(goalId, dueDate, goals);
  if (state === "hidden") return null;
  const overdue = !!dueDate && status !== "done" && status !== "cancelled" && isPastDue(dueDate);
  if (state === "read_only") {
    return (
      <PropertyRow label="Due date">
        <span className="text-sm">{dueDate}</span>
      </PropertyRow>
    );
  }
  return (
    <PropertyRow label="Due date">
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          type="date"
          aria-label="Due date"
          className="h-7 w-auto px-2 py-0 text-sm"
          value={dueDate ?? ""}
          onChange={(event) => onUpdate({ dueDate: event.target.value || null })}
        />
        {dueDate ? (
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            aria-label="Clear due date"
            onClick={() => onUpdate({ dueDate: null })}
          >
            <X className="size-3" />
          </button>
        ) : null}
        {overdue ? <span className="text-xs font-medium text-status-danger">Overdue</span> : null}
      </div>
    </PropertyRow>
  );
}
