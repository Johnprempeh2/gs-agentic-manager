import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { workflowTemplatesApi } from "../api/workflowTemplates";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import {
  workflowDefinitionFromTask,
  workflowKey,
  type WorkflowSourceSubtask,
  type WorkflowSourceTask,
} from "../lib/workflow-from-task";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SaveAsWorkflowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  task: WorkflowSourceTask;
  subtasks: WorkflowSourceSubtask[];
}

/**
 * "Save as workflow": keeps the shape of a task that went well (its subtasks,
 * who did each one and what waited on what) so the same set of tasks can be
 * started again in one click from Workflows.
 */
export function SaveAsWorkflowDialog({ open, onOpenChange, companyId, task, subtasks }: SaveAsWorkflowDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const [name, setName] = useState(task.title);

  useEffect(() => {
    if (open) setName(task.title);
  }, [open, task.title]);

  const definition = useMemo(() => workflowDefinitionFromTask(task, subtasks), [task, subtasks]);
  const save = useMutation({
    mutationFn: async () => {
      if (!definition) throw new Error("This task has no subtasks to save.");
      const existing = await queryClient.fetchQuery({
        queryKey: queryKeys.workflowTemplates.list(companyId),
        queryFn: () => workflowTemplatesApi.list(companyId),
      });
      const usedKeys = new Set(existing.map((template) => template.key));
      const base = workflowKey(name);
      let key = base;
      for (let n = 2; usedKeys.has(key); n += 1) key = `${base.slice(0, 44)}-${n}`;
      return workflowTemplatesApi.create(companyId, { key, name: name.trim(), description: null, definition });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflowTemplates.list(companyId) });
      pushToast({
        title: "Saved as a workflow",
        body: "Start the same set of tasks again from Workflows.",
        tone: "success",
        action: { label: "Open Workflows", onClick: () => navigate("/workflows") },
      });
      onOpenChange(false);
    },
    onError: (err: Error) => pushToast({ title: "Could not save the workflow", body: err.message, tone: "error" }),
  });

  const steps = definition?.steps ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as workflow</DialogTitle>
          <DialogDescription>
            Each subtask becomes a step, with the same agent and the same order. Start it again any time from Workflows.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="save-as-workflow-name">Name</Label>
            <Input
              id="save-as-workflow-name"
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {steps.length > 0 ? (
            <ol className="list-decimal space-y-1 pl-5 text-sm" data-testid="save-as-workflow-steps">
              {steps.map((step) => (
                <li key={step.key}>
                  {step.title}
                  {step.blockedBy.length > 0 ? (
                    <span className="text-muted-foreground"> (waits for {step.blockedBy.length === 1 ? "1 step" : `${step.blockedBy.length} steps`})</span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">This task has no subtasks to save.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!definition || name.trim().length === 0 || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving..." : "Save workflow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
