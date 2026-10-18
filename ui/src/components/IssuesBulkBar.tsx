import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@greatstone/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import {
  BULK_PRIORITY_CHOICES,
  BULK_STATUS_CHOICES,
  parseBulkIssueChange,
  taskCount,
} from "../lib/bulk-issue-change";
import { useConfirm } from "@/context/ConfirmContext";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";

const STOPPED_AGENT_STATUSES = new Set(["paused", "terminated", "error", "pending_approval"]);

interface IssuesBulkBarProps {
  companyId: string;
  agents: Agent[] | undefined;
  selectedIds: string[];
  onClear: () => void;
  onDone: () => void;
}

/**
 * Shown on the Tasks list while tasks are selected: change their status,
 * priority or assignee in one go. Each change goes through the normal task
 * update, so wakeups, permissions and the activity log behave as usual.
 */
export function IssuesBulkBar({ companyId, agents, selectedIds, onClear, onDone }: IssuesBulkBarProps) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { pushToast } = useToastActions();
  const [choice, setChoice] = useState("");
  const workingAgents = (agents ?? []).filter((agent) => !STOPPED_AGENT_STATUSES.has(agent.status));

  const apply = useMutation({
    mutationFn: async ({ ids, data }: { ids: string[]; data: Record<string, unknown> }) => {
      let changed = 0;
      let failed = 0;
      for (const id of ids) {
        try {
          await issuesApi.update(id, data);
          changed += 1;
        } catch {
          failed += 1;
        }
      }
      return { changed, failed };
    },
    onSuccess: ({ changed, failed }) => {
      pushToast({
        tone: failed > 0 ? "warn" : "success",
        title: `${taskCount(changed)} changed`,
        body: failed > 0 ? `${taskCount(failed)} could not be changed. Open them to see why.` : undefined,
      });
      if (failed === 0) onClear();
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Could not change the tasks", body: error instanceof Error ? error.message : undefined });
    },
    onSettled: () => {
      setChoice("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  const count = selectedIds.length;

  return (
    <div
      className="sticky top-2 z-raised mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/95 px-3 py-2 shadow-sm backdrop-blur"
      data-testid="issues-bulk-bar"
    >
      <span className="mr-auto text-sm text-muted-foreground">
        {count === 0 ? "Tick the tasks you want to change" : `${taskCount(count)} selected`}
      </span>
      <NativeSelect
        aria-label="Change the selected tasks"
        value={choice}
        disabled={count === 0 || apply.isPending}
        onChange={async (event) => {
          const value = event.target.value;
          setChoice(value);
          const change = parseBulkIssueChange(value, workingAgents);
          if (!change) return;
          const ok = await confirm({
            title: `Set ${taskCount(count)} to ${change.label}?`,
            description:
              change.field === "assignee"
                ? `${change.label} becomes the assignee and is woken to pick them up. The change is logged on each task.`
                : "The change is logged on each task.",
            confirmLabel: "Change tasks",
          });
          if (ok) apply.mutate({ ids: selectedIds, data: change.data });
          else setChoice("");
        }}
      >
        <option value="">{apply.isPending ? "Changing" : "Change to"}</option>
        <optgroup label="Status">
          {BULK_STATUS_CHOICES.map((option) => (
            <option key={option.value} value={`status:${option.value}`}>
              {option.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Priority">
          {BULK_PRIORITY_CHOICES.map((option) => (
            <option key={option.value} value={`priority:${option.value}`}>
              {option.label}
            </option>
          ))}
        </optgroup>
        {workingAgents.length > 0 ? (
          <optgroup label="Assign to">
            {workingAgents.map((agent) => (
              <option key={agent.id} value={`assignee:${agent.id}`}>
                {agent.name}
              </option>
            ))}
          </optgroup>
        ) : null}
      </NativeSelect>
      {count > 0 ? (
        <Button size="sm" variant="ghost" onClick={onClear}>
          Deselect all
        </Button>
      ) : null}
      <Button size="sm" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
