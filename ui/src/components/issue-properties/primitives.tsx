import type { CSSProperties, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "../../lib/utils";

export function PropertySection({
  children,
  className,
  title,
  first,
  streamlined,
}: {
  children: ReactNode;
  className?: string;
  /** Labeled section header (§4). When set, renders the uppercase header above the rows. */
  title?: string;
  /** First section drops the top padding on its header. */
  first?: boolean;
  streamlined?: boolean;
}) {
  return (
    <div className={className} data-property-section="true">
      {title ? (
        <div
          className={cn(
            streamlined
              ? "gs-prop-heading pb-1 font-mono text-(length:--text-nano) font-normal uppercase tracking-wide text-subtle-foreground"
              : "text-xs font-semibold uppercase tracking-wide text-muted-foreground pb-1",
            first ? "pt-0" : "pt-3",
          )}
        >
          {title}
        </div>
      ) : null}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

/**
 * Plain-words meaning of each task property, shown when the label is hovered.
 * Someone who did not build GS Agentic Manager should understand every row.
 */
export const PROPERTY_HINTS: Record<string, string> = {
  Status: "Where the task is: to do, in progress, in review, blocked or done.",
  Priority: "How urgent this task is.",
  Assignee: "The one agent or person doing this task.",
  Team: "The team this task belongs to.",
  Model: "The AI model the agent uses for this task.",
  Project: "The project this task is part of.",
  Labels: "Tags for grouping and finding tasks.",
  Parent: "The bigger task this one is part of.",
  "Blocked by": "Tasks that must finish before this one can carry on.",
  Blocking: "Tasks that are waiting for this one to finish.",
  Subtasks: "Smaller tasks this one was split into.",
  "Sub-tasks": "Smaller tasks this one was split into.",
  "Related tasks": "Other tasks that link to this one.",
  Approvals: "Requests on this task that need a yes or no.",
  Reviewers: "Who checks the work before the task can be done.",
  Approvers: "Who gives the final yes before the task is done.",
  Execution: "Where the agent does the work for this task.",
  Workspace: "The folder and branch the agent works in for this task.",
  "Scheduled retry": "When the agent will try again after a failed attempt.",
  Monitor: "A check booked for later that wakes the agent, for example to look at an outside service again.",
  Watchdog: "An agent that looks at this task when work stops and restarts it if it stopped by mistake.",
  Originating: "Who or what created this task.",
  Started: "When an agent first started work on this task.",
  Completed: "When the task was finished.",
};

export function PropertyRow({
  label,
  children,
  wrap,
}: {
  label: ReactNode;
  children: ReactNode;
  /** Opt-in wrapping for chip-collection rows only (§5). Default rows stay one line. */
  wrap?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 gap-3 py-1",
        wrap ? "items-start" : "items-center",
      )}
      data-property-row="true"
    >
      <span
        className={cn(
          "text-xs text-muted-foreground shrink-0 w-24 truncate",
          wrap && "mt-0.5",
        )}
        data-property-label={typeof label === "string" ? label : undefined}
        title={typeof label === "string" ? (PROPERTY_HINTS[label] ?? label) : undefined}
      >
        {label}
      </span>
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5",
          wrap && "flex-col items-start",
        )}
        data-property-value="true"
      >
        {children}
      </div>
    </div>
  );
}

export function PropertyChip({
  children,
  className,
  style,
  title,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Tooltip override for chips whose children are not a bare string. */
  title?: string;
}) {
  return (
    <Badge
      variant="outline"
      // Badge chassis; keep this chip's truncation + normal weight + start alignment.
      className={cn("max-w-full min-w-0 justify-start truncate font-normal", className)}
      style={style}
      title={title ?? (typeof children === "string" ? children : undefined)}
    >
      {children}
    </Badge>
  );
}
