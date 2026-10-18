import { useState } from "react";
import type { BudgetIncident } from "@greatstone/shared";
import { AlertOctagon, ArrowUpRight, PauseCircle } from "lucide-react";
import { formatCents } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/context/ConfirmContext";

function centsInputValue(value: number) {
  return (value / 100).toFixed(2);
}

function parseDollarInput(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function incidentStateLabel(incident: BudgetIncident) {
  if (incident.status === "resolved") return "Resolved";
  if (incident.status === "dismissed") return "Dismissed";
  if (incident.approvalStatus === "revision_requested") return "Escalated";
  if (incident.approvalStatus === "pending") return "Pending approval";
  return "Open";
}

export function BudgetIncidentCard({
  incident,
  onRaiseAndResume,
  onKeepPaused,
  isMutating,
}: {
  incident: BudgetIncident;
  onRaiseAndResume: (amountCents: number) => void;
  onKeepPaused: () => void;
  isMutating?: boolean;
}) {
  const confirm = useConfirm();
  const [draftAmount, setDraftAmount] = useState(
    centsInputValue(Math.max(incident.amountObserved + 1000, incident.amountLimit)),
  );
  const parsed = parseDollarInput(draftAmount);
  const stateLabel = incidentStateLabel(incident);

  return (
    <Card className="overflow-hidden border-red-500/20 bg-(image:--gradient-extract-4)">
      <CardHeader className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-red-700/90 dark:text-red-200/80">
                {incident.scopeType === "company" ? "Organisation" : incident.scopeType === "agent" ? "Agent" : "Project"} limit reached
              </div>
              <Badge variant={incident.status === "resolved" ? "outline" : "secondary"}>
                {stateLabel}
              </Badge>
            </div>
            <CardTitle className="mt-1 text-base text-red-950 dark:text-red-50">{incident.scopeName}</CardTitle>
            <CardDescription className="mt-1 text-red-900/75 dark:text-red-100/70">
              Spending reached {formatCents(incident.amountObserved)} against a limit of {formatCents(incident.amountLimit)}.
            </CardDescription>
          </div>
          <div className="rounded-full border border-red-400/30 bg-red-500/10 p-2 text-red-600 dark:text-red-200">
            <AlertOctagon className="h-4 w-4" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        <div className="flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-950/90 dark:text-red-50/90">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {incident.scopeType === "project"
              ? "This project is paused. New work in it will not start until you raise its limit or choose to keep it paused."
              : incident.scopeType === "agent"
                ? "This agent is paused. It will not start new work until you raise its limit or choose to keep it paused."
                : "Agents in this organisation are paused. They will not start new work until you raise the limit or choose to keep it paused."}
          </div>
        </div>

        <div className="rounded-xl border border-border/60 bg-background/60 p-3">
          <label className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
            New budget (USD)
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Input
              value={draftAmount}
              onChange={(event) => setDraftAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
            <Button
              className="gap-2"
              disabled={isMutating || parsed === null || parsed <= incident.amountObserved}
              onClick={() => {
                if (typeof parsed === "number") onRaiseAndResume(parsed);
              }}
            >
              <ArrowUpRight className="h-4 w-4" />
              {isMutating ? "Applying..." : "Raise limit and restart work"}
            </Button>
          </div>
          {parsed !== null && parsed <= incident.amountObserved ? (
            <p className="mt-2 text-xs text-red-700 dark:text-red-200/80">
              The new limit must be higher than what has already been spent.
            </p>
          ) : null}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" className="text-muted-foreground" disabled={isMutating} onClick={async () => {
              const ok = await confirm({
                title: "Keep this paused?",
                description: "Work stays stopped until someone raises the limit.",
                confirmLabel: "Keep work paused",
              });
              if (ok) onKeepPaused();
            }}
          >
            Keep work paused
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
