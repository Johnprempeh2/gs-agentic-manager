import type { CSSProperties } from "react";
import { TriangleAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { UNEXPLAINED_BLOCK_SHORT_TEXT, type TreeBlockLine, type TreeBlockReason } from "@/lib/task-tree-block-reason";
import { cn } from "@/lib/utils";

function ReasonLine({
  line,
  warning,
  wrap = false,
  className,
}: {
  line: TreeBlockLine;
  warning?: boolean;
  /** Wrap long reasons instead of cutting them short. */
  wrap?: boolean;
  className?: string;
}) {
  const body = (
    <>
      {warning ? <TriangleAlert className={cn("size-3 shrink-0", wrap && "mt-0.5")} aria-hidden="true" /> : null}
      <span className={wrap ? "break-words" : "truncate"}>{line.text}</span>
    </>
  );
  const classes = cn(
    "flex min-w-0 gap-1 text-xs font-medium",
    wrap ? "items-start" : "items-center",
    warning ? "text-status-warning-foreground" : "text-status-danger-foreground",
    className,
  );
  if (!line.href) {
    return (
      <span data-slot="task-tree-block-line" className={classes} title={line.text}>
        {body}
      </span>
    );
  }
  return (
    <Link
      to={line.href}
      data-slot="task-tree-block-line"
      title={line.text}
      className={cn(classes, "hover:underline")}
      // The card opens its task and the canvas pans; the link goes to the blocker.
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {body}
    </Link>
  );
}

/**
 * Why a blocked task is blocked (GRE-2277). `compact` is one line for a tree
 * card: the root of the chain when there is one, else what blocks it directly.
 */
export function TaskTreeBlockReason({
  reason,
  compact = false,
  className,
  style,
}: {
  reason: TreeBlockReason;
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  if (compact) {
    return (
      <div data-slot="task-tree-block-reason" data-unexplained={reason.unexplained ? "" : undefined} className={className}>
        <ReasonLine
          line={reason.unexplained ? { text: UNEXPLAINED_BLOCK_SHORT_TEXT, href: null } : (reason.root ?? reason.own)}
          warning={reason.unexplained}
        />
      </div>
    );
  }
  return (
    <div
      data-slot="task-tree-block-reason"
      data-unexplained={reason.unexplained ? "" : undefined}
      className={cn("flex min-w-0 flex-col gap-0.5", className)}
      style={style}
    >
      <ReasonLine line={reason.own} warning={reason.unexplained} wrap />
      {reason.root ? <ReasonLine line={reason.root} wrap /> : null}
    </div>
  );
}
