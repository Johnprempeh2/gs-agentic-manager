import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { approvalsApi } from "../api/approvals";
import { calendarApi } from "../api/calendar";
import { decisionsApi } from "../api/decisions";
import { useDialogActions } from "../context/DialogContext";
import { useToastActions } from "../context/ToastContext";
import { calendarFeedKey } from "./CalendarFeed";
import { queryKeys } from "../lib/queryKeys";
import {
  firstWeekSteps,
  readFirstWeekMark,
  setFirstWeekMark,
  subscribeFirstWeekMarks,
  type FirstWeekStep,
} from "../lib/first-week";
import { cn } from "../lib/utils";

function useFirstWeekMarks(companyId: string) {
  const read = () => ({
    quickStart: readFirstWeekMark(companyId, "quick-start"),
    weeklyReport: readFirstWeekMark(companyId, "weekly-report"),
    hidden: readFirstWeekMark(companyId, "hidden"),
  });
  const [marks, setMarks] = useState(read);
  useEffect(() => {
    setMarks(read());
    return subscribeFirstWeekMarks(() => setMarks(read()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);
  return marks;
}

export function FirstWeekChecklistView({
  steps,
  onQuickStart,
  onHide,
}: {
  steps: FirstWeekStep[];
  onQuickStart: () => void;
  onHide: () => void;
}) {
  const doneCount = steps.filter((step) => step.done).length;
  return (
    <Card className="gap-3 px-4 py-3" role="region" aria-label="Your first week" data-testid="first-week-checklist">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold">Your first week</h3>
          <p className="text-sm text-muted-foreground">
            Four small steps to see how things work. {doneCount} of {steps.length} done.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onHide} data-testid="first-week-hide">
          Hide
        </Button>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {steps.map((step) => {
          const Icon = step.done ? CheckCircle2 : Circle;
          const label = (
            <span className={cn("font-medium", step.done && "text-muted-foreground line-through")}>{step.label}</span>
          );
          return (
            <li key={step.id} className="flex items-start gap-2 text-sm" data-testid={`first-week-${step.id}`} data-done={step.done}>
              <Icon
                className={cn("mt-0.5 size-4 shrink-0", step.done ? "text-primary" : "text-muted-foreground")}
                aria-label={step.done ? "Done" : "Not done yet"}
              />
              <div className="min-w-0">
                {step.done ? (
                  label
                ) : step.id === "quick-start" ? (
                  <button type="button" className="text-left hover:underline" onClick={onQuickStart}>
                    {label}
                  </button>
                ) : (
                  <Link to={stepHref(step.id)} className="hover:underline">
                    {label}
                  </Link>
                )}
                <p className="text-xs text-muted-foreground">{step.hint}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function stepHref(id: FirstWeekStep["id"]): string {
  switch (id) {
    case "calendar-feed":
      return "/company/settings/integrations";
    case "decision":
      return "/decisions";
    case "weekly-report":
      return "/weekly-report";
    default:
      return "/dashboard";
  }
}

/**
 * A short checklist on Home for a new executive. Each step ticks itself off
 * when it happens; the card goes away once all four are done or it is hidden.
 */
export function FirstWeekChecklist({ companyId, currentUserId }: { companyId: string; currentUserId: string | null }) {
  const marks = useFirstWeekMarks(companyId);
  const { openNewIssue } = useDialogActions();
  const { pushToast } = useToastActions();

  const { data: feed } = useQuery({
    queryKey: calendarFeedKey(companyId),
    queryFn: () => calendarApi.feedStatus(companyId),
    enabled: !marks.hidden,
  });
  const { data: decided = [] } = useQuery({
    queryKey: [...queryKeys.decisions.list(companyId, "decided"), "first-week"],
    queryFn: () => decisionsApi.list(companyId, { status: "decided", limit: 50 }),
    enabled: !marks.hidden,
  });
  const { data: approvals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(companyId),
    queryFn: () => approvalsApi.list(companyId),
    enabled: !marks.hidden,
  });

  if (marks.hidden) return null;

  const decisionAnswered =
    decided.some((decision) => !currentUserId || decision.decidedByUserId === currentUserId) ||
    approvals.some(
      (approval) => approval.status !== "pending" && !!approval.decidedByUserId && (!currentUserId || approval.decidedByUserId === currentUserId),
    );

  const steps = firstWeekSteps({
    calendarFeedOn: !!feed?.enabled,
    quickStartPicked: marks.quickStart,
    decisionAnswered,
    weeklyReportRead: marks.weeklyReport,
  });
  if (steps.every((step) => step.done)) return null;

  const hide = () => {
    setFirstWeekMark(companyId, "hidden");
    pushToast({
      id: `first-week-hidden-${companyId}`,
      title: "Checklist hidden",
      tone: "info",
      action: { label: "Undo", onClick: () => setFirstWeekMark(companyId, "hidden", false) },
    });
  };

  return <FirstWeekChecklistView steps={steps} onQuickStart={() => openNewIssue()} onHide={hide} />;
}
