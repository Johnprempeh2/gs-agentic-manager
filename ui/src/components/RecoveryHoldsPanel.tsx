import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecoveryHold } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { Textarea } from "@/components/ui/textarea";
import { issuesApi } from "../api/issues";
import { recoveryHoldsApi } from "../api/recoveryHolds";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import {
  buildHoldReconciliation,
  HOLD_OUTCOME_OPTIONS,
  WORKSPACE_NOTE_MIN_LENGTH,
  type HoldOutcomeChoice,
} from "../lib/recoveryHolds";
import { relativeTime } from "../lib/utils";

interface RecoveryHoldsPanelProps {
  companyId: string;
  agentNameById: ReadonlyMap<string, string>;
}

/**
 * Tasks GS Agentic Manager will not run again until someone says what their
 * last run did. Each one can be cleared here, which wakes its agent.
 */
export function RecoveryHoldsPanel({ companyId, agentNameById }: RecoveryHoldsPanelProps) {
  const [clearing, setClearing] = useState<RecoveryHold | null>(null);
  const [clearedMessage, setClearedMessage] = useState<string | null>(null);
  const { data, error } = useQuery({
    queryKey: queryKeys.issues.recoveryHolds(companyId),
    queryFn: () => recoveryHoldsApi.list(companyId),
  });

  if (error) {
    return (
      <p role="alert" className="px-3 text-sm text-destructive sm:px-4" data-testid="recovery-holds-error">
        Couldn't load the held tasks. {error instanceof Error ? error.message : ""}
      </p>
    );
  }
  const holds = data?.holds ?? [];
  if (holds.length === 0 && !clearedMessage) return null;

  const agentName = (hold: RecoveryHold) =>
    (hold.assigneeAgentId ? agentNameById.get(hold.assigneeAgentId) : null) ?? "its agent";

  return (
    <Card data-testid="recovery-holds" className="mx-2 mb-4 gap-3 border-border/70 bg-card/60 p-4 sm:mx-0">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">
          {holds.length === 1 ? "1 task is on hold after a run stopped" : `${holds.length} tasks are on hold after a run stopped`}
        </h3>
        <p className="text-xs text-muted-foreground">
          These runs stopped part-way through a step outside GS Agentic Manager, such as a push or an email. To be safe, nothing runs again until you say what happened.
        </p>
      </div>
      {clearedMessage ? (
        <p role="status" className="text-xs text-foreground" data-testid="recovery-holds-cleared">
          {clearedMessage}
        </p>
      ) : null}
      <ul className="space-y-2">
        {holds.map((hold) => (
          <li
            key={hold.recoveryActionId}
            className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/40 p-3 sm:flex-row sm:items-center sm:justify-between"
            data-testid="recovery-hold-row"
          >
            <div className="min-w-0 space-y-0.5">
              <Link
                to={createIssueDetailPath(hold.issue.identifier ?? hold.issue.id)}
                className="text-sm font-medium text-foreground no-underline hover:underline"
              >
                {hold.issue.identifier ? (
                  <span className="mr-1.5 font-mono text-xs text-muted-foreground">{hold.issue.identifier}</span>
                ) : null}
                {hold.issue.title}
              </Link>
              <p className="text-xs text-muted-foreground">
                {agentName(hold)} · on hold since {relativeTime(hold.heldSince)}
              </p>
            </div>
            {hold.runId ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setClearing(hold)}>
                Clear and wake
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">Open the task to clear it</span>
            )}
          </li>
        ))}
      </ul>
      {clearing ? (
        <ClearHoldDialog
          hold={clearing}
          agentName={agentName(clearing)}
          companyId={companyId}
          onClose={() => setClearing(null)}
          onCleared={(message) => {
            setClearing(null);
            setClearedMessage(message);
          }}
        />
      ) : null}
    </Card>
  );
}

function ClearHoldDialog({
  hold,
  agentName,
  companyId,
  onClose,
  onCleared,
}: {
  hold: RecoveryHold;
  agentName: string;
  companyId: string;
  onClose: () => void;
  onCleared: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<HoldOutcomeChoice>("not_sure");
  const [note, setNote] = useState("");
  const [workspaceNote, setWorkspaceNote] = useState("");
  const workspaceNoteMissing =
    hold.needsWorkspaceRepair && workspaceNote.trim().length < WORKSPACE_NOTE_MIN_LENGTH;

  const clear = useMutation({
    mutationFn: () =>
      issuesApi.resolveRecoveryAction(hold.issue.id, {
        actionId: hold.recoveryActionId,
        outcome: "restored",
        // A task in review stays in review, so its review is not skipped.
        sourceIssueStatus: hold.issue.status === "in_review" ? "in_review" : "todo",
        resolutionNote: "Cleared from the holds list.",
        executionReconciliation: buildHoldReconciliation({
          runId: hold.runId!,
          choice,
          note,
          workspaceNote: hold.needsWorkspaceRepair ? workspaceNote : undefined,
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["issues", companyId] });
      onCleared(`Cleared ${hold.issue.identifier ?? hold.issue.title}. ${agentName} will pick it up again.`);
    },
  });

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent data-testid="clear-hold-dialog">
        <DialogHeader>
          <DialogTitle>Clear the hold on {hold.issue.identifier ?? hold.issue.title}</DialogTitle>
          <DialogDescription>
            {agentName}'s last run stopped part-way through. {hold.nextAction} What happened to that step?
          </DialogDescription>
        </DialogHeader>
        <RadioCardGroup
          ariaLabel="What happened to the step"
          value={choice}
          onValueChange={(value) => setChoice(value as HoldOutcomeChoice)}
          options={HOLD_OUTCOME_OPTIONS}
        />
        {hold.needsWorkspaceRepair ? (
          <label className="block space-y-1 text-sm">
            <span className="font-medium">What did you check or fix in its workspace?</span>
            <Textarea
              value={workspaceNote}
              onChange={(event) => setWorkspaceNote(event.target.value)}
              placeholder="For example: I checked the branch is clean and matches GitHub."
            />
            <span className="text-xs text-muted-foreground">The run also left its files in an unsafe state, so a short note is needed.</span>
          </label>
        ) : null}
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Anything the agent should know? (optional)</span>
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        {clear.error ? (
          <p role="alert" className="text-sm text-destructive">
            {clear.error instanceof Error ? clear.error.message : "Couldn't clear the hold."}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => clear.mutate()}
            disabled={clear.isPending || workspaceNoteMissing}
          >
            {clear.isPending ? "Clearing…" : `Clear and wake ${agentName}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
