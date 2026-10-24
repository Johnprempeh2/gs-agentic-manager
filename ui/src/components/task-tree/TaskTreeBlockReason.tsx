import type { CSSProperties } from "react";
import { Repeat, TriangleAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { UNEXPLAINED_BLOCK_SHORT_TEXT, type TreeBlockLine, type TreeBlockReason } from "@/lib/task-tree-block-reason";
import { cn } from "@/lib/utils";

const TONE = {
  danger: "text-status-danger-foreground",
  warning: "text-status-warning-foreground",
  /** Violet, like the Loop badge and the loop line on the canvas (GRE-2290). */
  loop: "text-status-review-foreground",
} as const;

function ReasonLine({
  line,
  tone = "danger",
  wrap = false,
  className,
}: {
  line: TreeBlockLine;
  tone?: keyof typeof TONE;
  /** Wrap long reasons instead of cutting them short. */
  wrap?: boolean;
  className?: string;
}) {
  const body = (
    <>
      {tone === "warning" ? <TriangleAlert className={cn("size-3 shrink-0", wrap && "mt-0.5")} aria-hidden="true" /> : null}
      {tone === "loop" ? <Repeat className={cn("size-3 shrink-0", wrap && "mt-0.5")} aria-hidden="true" /> : null}
      <span className={wrap ? "break-words" : "truncate"}>{line.text}</span>
    </>
  );
  const classes = cn(
    "flex min-w-0 gap-1 text-xs font-medium",
    wrap ? "items-start" : "items-center",
    TONE[tone],
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
 * card: the loop it sits in, else the root of the chain when there is one,
 * else what blocks it directly.
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
          line={reason.unexplained ? { text: UNEXPLAINED_BLOCK_SHORT_TEXT, href: null } : (reason.loop ?? reason.root ?? reason.own)}
          tone={reason.unexplained ? "warning" : reason.loop ? "loop" : "danger"}
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
      <ReasonLine line={reason.own} tone={reason.unexplained ? "warning" : "danger"} wrap />
      {reason.root ? <ReasonLine line={reason.root} wrap /> : null}
      {reason.loop ? <ReasonLine line={reason.loop} tone="loop" wrap /> : null}
    </div>
  );
}
