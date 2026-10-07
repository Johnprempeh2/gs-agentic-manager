import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  accessApi,
  type LegacyBoardControls,
  type LegacyBoardIssueRole,
} from "@/api/access";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

const ROLE_LABELS: Record<LegacyBoardIssueRole, string> = {
  assignee: "assignee",
  responsible: "responsible",
  current_reviewer: "reviewer",
  return_assignee: "return assignee",
  review_participant: "review step",
};

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Retire or restore the legacy `local-board` account from its row on the
 * Members page. The server decides who may: `controls` comes from the members
 * response and is only present in authenticated mode.
 */
export function LegacyBoardRetirementActions({
  companyId,
  controls,
}: {
  companyId: string;
  controls: LegacyBoardControls | null | undefined;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const dryRunQuery = useQuery({
    queryKey: ["access", "legacy-board-retire-dry-run", companyId],
    queryFn: () => accessApi.retireLegacyBoard(companyId, { dryRun: true }),
    enabled: dialogOpen,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(companyId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyUserDirectory(companyId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
  };

  const retireMutation = useMutation({
    mutationFn: () => accessApi.retireLegacyBoard(companyId, { dryRun: false }),
    onSuccess: async (report) => {
      setDialogOpen(false);
      await refresh();
      pushToast({
        title: "Legacy account retired",
        body: `${plural(report.issueCount, "open task")}, ${plural(report.pendingRequestCount, "pending request")} and ${plural(report.routineCount ?? 0, "routine")} moved to you.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not retire the legacy account",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: () => accessApi.restoreLegacyBoard(companyId),
    onSuccess: async () => {
      await refresh();
      pushToast({ title: "Legacy account restored", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Could not restore the legacy account",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (!controls) return null;

  if (controls.canRestore) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => restoreMutation.mutate()}
        disabled={restoreMutation.isPending}
      >
        {restoreMutation.isPending ? "Restoring..." : "Restore"}
      </Button>
    );
  }

  if (!controls.canRetire) return null;

  const report = dryRunQuery.data;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
        Retire legacy account
      </Button>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Retire the legacy board account</DialogTitle>
            <DialogDescription>
              This account is left over from before sign-in was turned on. Retiring it moves its open work to
              you and switches it off. Its comments, approvals and history stay as they are.
            </DialogDescription>
          </DialogHeader>
          {dryRunQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Checking what would change...</div>
          ) : dryRunQuery.error ? (
            <div className="text-sm text-destructive">
              {dryRunQuery.error instanceof Error ? dryRunQuery.error.message : "Could not check what would change."}
            </div>
          ) : report ? (
            <div className="space-y-4 text-sm">
              <div className="space-y-2">
                <div className="font-medium">Moves to you</div>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  <li>{plural(report.issueCount, "open task")}</li>
                  <li>{plural(report.pendingRequestCount, "pending question or request", "pending questions or requests")}</li>
                  <li>{plural(report.routineCount ?? 0, "routine")} (you become the responsible user)</li>
                </ul>
                {report.issues.length > 0 ? (
                  <div className="max-h-40 overflow-auto rounded-lg border border-border">
                    {report.issues.map((issue) => (
                      <div key={issue.id} className="border-b border-border px-3 py-2 last:border-b-0">
                        <div className="font-medium">{issue.identifier ?? issue.id.slice(0, 8)}</div>
                        <div className="truncate text-muted-foreground">
                          {issue.title} ({issue.roles.map((role) => ROLE_LABELS[role]).join(", ")})
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {(report.routines ?? []).length > 0 ? (
                  <div className="max-h-40 overflow-auto rounded-lg border border-border">
                    {(report.routines ?? []).map((routine) => (
                      <div key={routine.id} className="border-b border-border px-3 py-2 last:border-b-0">
                        <div className="font-medium">{routine.title}</div>
                        <div className="truncate text-muted-foreground">Routine ({routine.status})</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="space-y-2">
                <div className="font-medium">Switched off</div>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  <li>Membership set to suspended, so it leaves pickers and defaults</li>
                  <li>{plural(report.switchOff.boardKeysRevoked, "board API key")} revoked</li>
                  <li>{plural(report.switchOff.sessionsEnded, "sign-in session")} ended</li>
                  {report.switchOff.instanceAdmin === "removed" ? (
                    <li>Instance admin role removed (it has a sign-in account)</li>
                  ) : null}
                </ul>
              </div>
              <p className="text-muted-foreground">You can restore the account later. Moved work stays with you.</p>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => retireMutation.mutate()}
              disabled={!report || retireMutation.isPending}
            >
              {retireMutation.isPending ? "Retiring..." : "Retire legacy account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
