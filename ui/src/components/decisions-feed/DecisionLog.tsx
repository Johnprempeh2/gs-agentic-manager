import type { ActivityEvent } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { relativeTime } from "../../lib/utils";

/** The board's answers to agents' questions, plans and confirmations. */
export const DECISION_LOG_ACTIONS = [
  "issue.thread_interaction_accepted",
  "issue.thread_interaction_rejected",
  "issue.thread_interaction_answered",
];

/** What the board decided, in plain words, and its reason when it sent work back. */
export function decisionLogEntry(event: ActivityEvent): { verb: string; reason: string | null } {
  const details = event.details ?? {};
  if (event.action.endsWith("_rejected")) {
    const reason = typeof details.rejectionReason === "string" ? details.rejectionReason.trim() : "";
    return { verb: "Sent back", reason: reason || null };
  }
  if (event.action.endsWith("_answered")) return { verb: "Answered", reason: null };
  return { verb: details.interactionKind === "suggest_tasks" ? "Accepted the suggested tasks" : "Approved", reason: null };
}

/** A record of what John decided and when, newest first, each linked to its task. */
export function DecisionLog({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) return null;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border" data-decision-log>
      {events.map((event) => {
        const { verb, reason } = decisionLogEntry(event);
        const task = event.issueIdentifier ?? null;
        return (
          <li key={event.id} className="flex flex-col gap-1 px-3 py-2.5 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0">
                <span className="font-medium">{verb}</span>
                {task ? (
                  <>
                    {" "}
                    <Link to={`/issues/${task}`} className="text-muted-foreground hover:text-foreground hover:underline">
                      {task} {event.issueTitle}
                    </Link>
                  </>
                ) : null}
              </p>
              <span className="shrink-0 text-xs text-muted-foreground" title={new Date(event.createdAt).toLocaleString("en-GB")}>
                {relativeTime(event.createdAt)}
              </span>
            </div>
            {reason ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">"{reason}"</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
