import type { Goal } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { issueUrl } from "../../lib/utils";

/**
 * A KPI pre-filled from a research pack (GRE-1161): the peer benchmark as
 * context, a link back to its slide-5 bullet and, while it is a draft, what a
 * person must do to make it live.
 */
export function KpiDraftNotice({
  goal,
  onAccept,
  pending,
}: {
  goal: Pick<Goal, "status" | "benchmarkNote" | "sourceIssueId" | "sourceDocumentKey" | "sourceBulletId" | "targetValue" | "targetDate">;
  onAccept: () => void;
  pending: boolean;
}) {
  const isDraft = goal.status === "draft";
  const hasTarget = goal.targetValue != null && !!goal.targetDate;
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4" data-testid="kpi-draft-notice">
      {isDraft ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">
            <span className="font-semibold">Draft KPI.</span>{" "}
            {hasTarget
              ? "Target is set. Accept it to make it live and give it a status."
              : "Not live yet: set a target value and date in Plan, then accept it."}
          </p>
          <Button size="sm" className="ml-auto" onClick={onAccept} disabled={!hasTarget || pending}>
            Accept KPI
          </Button>
        </div>
      ) : null}
      {goal.benchmarkNote ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Benchmark (context, not a target)</p>
          <p className="mt-1 whitespace-pre-line text-sm">{goal.benchmarkNote}</p>
        </div>
      ) : null}
      {goal.sourceIssueId ? (
        <p className="text-xs text-muted-foreground">
          Source:{" "}
          <Link
            className="underline underline-offset-2"
            to={`${issueUrl({ id: goal.sourceIssueId })}#document-${goal.sourceDocumentKey ?? "pre-read"}`}
          >
            research pack {goal.sourceDocumentKey ?? "document"}
            {goal.sourceBulletId ? `, ${goal.sourceBulletId}` : ""}
          </Link>
        </p>
      ) : null}
    </section>
  );
}
