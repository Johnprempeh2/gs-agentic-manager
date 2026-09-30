import type { GoalBlocker, GoalWithProgress } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { issueUrl } from "@/lib/utils";
import {
  blockerSentence,
  GOAL_BLOCKERS_ANCHOR,
  mainBlockerSummary,
  type GoalHealth,
} from "@/lib/goal-journey";
import { healthStyle } from "./GoalHealth";

const TICKET_LINK =
  "relative z-10 font-mono text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline";

function TicketLinks({ blocker }: { blocker: GoalBlocker }) {
  if (blocker.kind !== "issue") return null;
  const waitingOn = blocker.reason === "waiting_on_issue" ? blocker.waitingOn : null;
  return (
    <>
      <Link to={issueUrl({ id: blocker.issueId, identifier: blocker.identifier })} className={TICKET_LINK}>
        {blocker.identifier ?? "Open task"}
      </Link>
      {waitingOn ? (
        <span className="text-xs text-subtle-foreground">
          waits on{" "}
          <Link to={issueUrl({ id: waitingOn.issueId, identifier: waitingOn.identifier })} className={TICKET_LINK}>
            {waitingOn.identifier ?? "task"}
          </Link>
        </span>
      ) : null}
    </>
  );
}

/**
 * The goal card's "Main blocker" line: one plain sentence, two lines at most,
 * the full text on hover, ticket numbers as small links under it.
 */
export function MainBlocker({ goal, health }: { goal: GoalWithProgress; health: GoalHealth }) {
  const summary = mainBlockerSummary(goal, health);
  if (!summary) return null;
  const blocker = summary.kind === "blocker" ? summary.blocker : null;
  const more = summary.kind === "blocker" ? summary.moreCount : 0;
  return (
    <div
      className="border-l-2 border-[var(--sc)] py-0.5 pl-2.5 text-sm text-muted-foreground"
      style={healthStyle(health === "blocked" ? "blocked" : "at_risk")}
      data-testid="goal-main-blocker"
    >
      <p className="line-clamp-2" title={summary.sentence}>
        {blocker ? <span className="font-semibold text-foreground">Main blocker: </span> : null}
        {summary.sentence}
      </p>
      {blocker && (blocker.kind === "issue" || more > 0) ? (
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2">
          <TicketLinks blocker={blocker} />
          {more > 0 ? (
            <Link
              to={`/goals/${goal.id}#${GOAL_BLOCKERS_ANCHOR}`}
              className="relative z-10 text-xs text-subtle-foreground underline underline-offset-2 hover:text-foreground"
              data-testid="goal-more-blockers"
            >
              +{more} more {more === 1 ? "blocker" : "blockers"}
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** Every blocker on the goal page, main one first, each as a plain sentence. */
export function GoalBlockerList({ goal, health }: { goal: GoalWithProgress; health: GoalHealth }) {
  const summary = mainBlockerSummary(goal, health);
  if (!summary) return null;
  if (summary.kind === "open") {
    return <p className="text-sm text-muted-foreground">{summary.sentence}</p>;
  }
  return (
    <ol className="space-y-2" data-testid="goal-blocker-list">
      {goal.blockers.map((blocker, index) => (
        <li
          key={blocker.kind === "issue" ? blocker.issueId : `${blocker.checkInId}-${index}`}
          className="border-l-2 border-[var(--sc)] py-0.5 pl-2.5 text-sm"
          style={healthStyle(index === 0 && health === "blocked" ? "blocked" : "at_risk")}
        >
          <p>
            {index === 0 ? <span className="font-semibold">Main blocker: </span> : null}
            {blockerSentence(blocker)}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-subtle-foreground">
            {blocker.kind === "check_in" ? <span>From the last check-in</span> : <TicketLinks blocker={blocker} />}
          </p>
        </li>
      ))}
    </ol>
  );
}
