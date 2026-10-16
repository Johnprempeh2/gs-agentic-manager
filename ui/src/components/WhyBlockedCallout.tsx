import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";
import { explainWhyBlocked, type WhyBlocked, type WhyBlockedInput } from "../lib/why-blocked";

export interface WhyBlockedCalloutProps extends Omit<WhyBlockedInput, "lastRun" | "approvals"> {
  className?: string;
}

/**
 * The calm box at the top of a blocked task: why it is stuck, who can clear
 * it and what they need to do, with a link to the next step when there is one.
 * Renders nothing when the task is not blocked.
 */
export function WhyBlockedCallout({ className, ...input }: WhyBlockedCalloutProps) {
  const blocked = input.issue.status === "blocked";
  // Same query keys as the run ledger and the linked approvals, so these share their cache.
  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(input.issue.id),
    queryFn: () => activityApi.runsForIssue(input.issue.id),
    enabled: blocked,
  });
  const { data: approvals } = useQuery({
    queryKey: queryKeys.issues.approvals(input.issue.id),
    queryFn: () => issuesApi.listApprovals(input.issue.id),
    enabled: blocked,
  });
  if (!blocked) return null;
  const explanation = explainWhyBlocked({ ...input, lastRun: runs?.[0] ?? null, approvals: approvals ?? null });
  if (!explanation) return null;
  return <WhyBlockedBox explanation={explanation} className={className} />;
}

export function WhyBlockedBox({ explanation, className }: { explanation: WhyBlocked; className?: string }) {
  const { link } = explanation;
  const linkClass =
    "shrink-0 text-sm font-medium text-foreground underline underline-offset-2 hover:text-status-warning-foreground";
  return (
    <section
      role="status"
      aria-label="Why this task is blocked"
      data-testid="why-blocked-callout"
      data-source={explanation.source}
      className={cn(
        "flex items-start gap-3 rounded-md border border-status-warning/40 bg-status-warning-soft px-3 py-2.5",
        className,
      )}
    >
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warning-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium text-foreground" data-testid="why-blocked-headline">
          {explanation.headline}
        </p>
        {explanation.detail ? <p className="text-sm text-muted-foreground">{explanation.detail}</p> : null}
        <p className="text-sm text-muted-foreground" data-testid="why-blocked-next">
          {"Who can clear it: "}
          <span className="font-medium text-foreground">{explanation.whoCanUnblock}</span>
          {". "}
          {explanation.nextStep}
        </p>
      </div>
      {link ? (
        link.href.startsWith("#") ? (
          <a href={link.href} className={linkClass} data-testid="why-blocked-link">
            {link.label}
          </a>
        ) : (
          <Link to={link.href} className={linkClass} data-testid="why-blocked-link">
            {link.label}
          </Link>
        )
      ) : null}
    </section>
  );
}
