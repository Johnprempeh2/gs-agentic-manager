import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Company } from "@greatstone/shared";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type PauseDialog = "pause" | "resume" | null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * GRE-1364: pause and resume use their own server actions. Pause stops runs,
 * routines and every connection; resume is a named act with a reason, and each
 * connection is then turned back on from the Connectors page.
 */
export function CompanyPauseSection({ company }: { company: Company }) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<PauseDialog>(null);
  const [pauseReason, setPauseReason] = useState("");
  const [operator, setOperator] = useState("");
  const [resumeReason, setResumeReason] = useState("");
  const paused = company.status === "paused";

  const onSettled = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.tools.connections(company.id) });
  };

  const pauseMutation = useMutation({
    mutationFn: (reason: string) =>
      companiesApi.pause(company.id, reason ? { reason } : {}),
    onSuccess: () => {
      setDialog(null);
      setPauseReason("");
      onSettled();
    },
  });

  const resumeMutation = useMutation({
    mutationFn: (input: { operator: string; reason: string }) =>
      companiesApi.resume(company.id, input),
    onSuccess: () => {
      setDialog(null);
      setOperator("");
      setResumeReason("");
      onSettled();
    },
  });

  const resumeReady = operator.trim().length > 0 && resumeReason.trim().length > 0;

  function openDialog(next: PauseDialog) {
    pauseMutation.reset();
    resumeMutation.reset();
    setDialog(next);
  }

  function handlePause(event: FormEvent) {
    event.preventDefault();
    pauseMutation.mutate(pauseReason.trim());
  }

  function handleResume(event: FormEvent) {
    event.preventDefault();
    if (!resumeReady) return;
    resumeMutation.mutate({ operator: operator.trim(), reason: resumeReason.trim() });
  }

  const busy = pauseMutation.isPending || resumeMutation.isPending;

  return (
    <div
      className="gs-glass-card max-w-2xl space-y-4 rounded-xl border p-5"
      data-testid="company-settings-pause-section"
    >
      <div className="gs-prop-heading text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Pause
      </div>
      {paused ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-foreground" data-testid="company-paused-since">
            {company.pausedAt ? `Paused since ${formatDateTime(company.pausedAt)}` : "Paused"}
          </p>
          <p className="text-sm text-muted-foreground">
            Agents, routines and connections are stopped. When you resume, routines start again at
            their next scheduled time, and you turn each connection back on from the Connectors
            page.
          </p>
          <Button size="sm" onClick={() => openDialog("resume")} disabled={busy}>
            Resume organization
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Pausing stops all running work, routines and connections straight away. Nothing runs
            until someone resumes the organization.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openDialog("pause")}
            disabled={busy || company.status === "archived"}
          >
            Pause organization
          </Button>
        </div>
      )}

      <Dialog
        open={dialog === "pause"}
        onOpenChange={(open) => {
          if (!open && !pauseMutation.isPending) setDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handlePause} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Pause "{company.name}"?</DialogTitle>
              <DialogDescription>
                Running work stops, routines stop and every connection is turned off. Resuming later
                needs your name and a reason.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="company-pause-reason">Reason (optional)</Label>
              <Textarea
                id="company-pause-reason"
                value={pauseReason}
                maxLength={2000}
                placeholder="For example: checking a billing problem"
                onChange={(event) => setPauseReason(event.target.value)}
              />
            </div>
            {pauseMutation.isError && (
              <p role="alert" className="text-xs text-destructive">
                {errorMessage(pauseMutation.error, "Could not pause the organization.")}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialog(null)}
                disabled={pauseMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={pauseMutation.isPending}>
                {pauseMutation.isPending ? "Pausing..." : "Pause"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === "resume"}
        onOpenChange={(open) => {
          if (!open && !resumeMutation.isPending) setDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleResume} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Resume "{company.name}"?</DialogTitle>
              <DialogDescription>
                Agents can work again and routines start at their next scheduled time. Missed runs
                are not replayed. Connections stay off until you turn each one back on.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="company-resume-operator">Your name</Label>
              <Input
                id="company-resume-operator"
                value={operator}
                maxLength={200}
                required
                autoComplete="name"
                onChange={(event) => setOperator(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="company-resume-reason">Reason</Label>
              <Textarea
                id="company-resume-reason"
                value={resumeReason}
                maxLength={2000}
                required
                placeholder="For example: billing problem fixed"
                onChange={(event) => setResumeReason(event.target.value)}
              />
            </div>
            {resumeMutation.isError && (
              <p role="alert" className="text-xs text-destructive">
                {errorMessage(resumeMutation.error, "Could not resume the organization.")}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialog(null)}
                disabled={resumeMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!resumeReady || resumeMutation.isPending}>
                {resumeMutation.isPending ? "Resuming..." : "Resume"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
