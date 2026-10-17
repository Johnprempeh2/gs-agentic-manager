import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { useConfirm } from "@/context/ConfirmContext";
import { useToastActions } from "../context/ToastContext";
import { InlineBanner } from "./InlineBanner";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";

/** Statuses that still need someone to work on them. */
export const OPEN_TASK_STATUSES = "todo,in_progress,blocked,in_review";
const STOPPED_STATUSES = new Set(["paused", "terminated", "error"]);

interface MoveOpenTasksBannerProps {
  companyId: string;
  agent: { id: string; name: string; status: string };
}

/**
 * On a paused, stopped or removed agent's page: "Ridge still has 4 open tasks".
 * Pick a working colleague and move them all in one go, so the work does not
 * sit with an agent that will not pick it up. Each move goes through the normal
 * task update, so the new assignee is woken and the change is logged.
 */
export function MoveOpenTasksBanner({ companyId, agent }: MoveOpenTasksBannerProps) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { pushToast } = useToastActions();
  const stopped = STOPPED_STATUSES.has(agent.status);
  const [targetId, setTargetId] = useState("");

  const { data: openTasks } = useQuery({
    queryKey: ["agent-open-tasks", companyId, agent.id],
    queryFn: () => issuesApi.list(companyId, { assigneeAgentId: agent.id, status: OPEN_TASK_STATUSES }),
    enabled: stopped,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: stopped,
  });

  const move = useMutation({
    mutationFn: async ({ taskIds, toAgentId }: { taskIds: string[]; toAgentId: string }) => {
      let moved = 0;
      const failed: string[] = [];
      for (const taskId of taskIds) {
        try {
          await issuesApi.update(taskId, { assigneeAgentId: toAgentId });
          moved += 1;
        } catch {
          failed.push(taskId);
        }
      }
      return { moved, failed: failed.length };
    },
    onSuccess: ({ moved, failed }) => {
      pushToast({
        tone: failed > 0 ? "warn" : "success",
        title: `${moved} ${moved === 1 ? "task" : "tasks"} moved`,
        body: failed > 0 ? `${failed} could not be moved. Open them to see why.` : undefined,
      });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Could not move the tasks", body: error instanceof Error ? error.message : undefined });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-open-tasks", companyId, agent.id] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  const tasks = openTasks ?? [];
  if (!stopped || tasks.length === 0) return null;
  const candidates = (agents ?? []).filter(
    (candidate) => candidate.id !== agent.id && !STOPPED_STATUSES.has(candidate.status) && candidate.status !== "pending_approval",
  );
  const target = candidates.find((candidate) => candidate.id === targetId) ?? null;
  const count = tasks.length;
  const taskWord = count === 1 ? "task" : "tasks";

  return (
    <InlineBanner
      tone="warning"
      compact
      title={`${agent.name} still has ${count} open ${taskWord}`}
      actions={
        <div className="flex flex-wrap items-center gap-2" data-testid="move-open-tasks">
          <NativeSelect
            aria-label="Move the tasks to"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
          >
            <option value="">Choose an agent</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </NativeSelect>
          <Button
            size="sm"
            disabled={!target || move.isPending}
            onClick={async () => {
              if (!target) return;
              const ok = await confirm({
                title: `Move ${count} ${taskWord} to ${target.name}?`,
                description: `${target.name} becomes the assignee and is woken to pick them up. The move is logged on each task.`,
                confirmLabel: `Move ${taskWord}`,
              });
              if (ok) move.mutate({ taskIds: tasks.map((task) => task.id), toAgentId: target.id });
            }}
          >
            {move.isPending ? "Moving" : `Move ${count} ${taskWord}`}
          </Button>
        </div>
      }
    >
      Nobody will work on them while this agent is stopped. Move them to a working colleague.
    </InlineBanner>
  );
}
