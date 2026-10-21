import { cn } from "@/lib/utils";

export interface ProgressRingProps {
  done: number;
  total: number;
  /** Diameter in pixels. */
  size?: number;
  /** Show "5/7" beside the ring. */
  showLabel?: boolean;
  className?: string;
}

/**
 * A small ring that fills as sub-tasks finish, with an optional "5/7" label.
 * Track in the border colour; the arc turns success green when all are done.
 */
export function ProgressRing({ done, total, size = 18, showLabel = true, className }: ProgressRingProps) {
  const stroke = Math.max(2, Math.round(size / 8));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const complete = total > 0 && done >= total;
  return (
    <span
      data-slot="progress-ring"
      className={cn("inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground", className)}
      role="img"
      aria-label={`${done} of ${total} sub-tasks done`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-border" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          className={complete ? "stroke-status-success" : "stroke-status-running"}
        />
      </svg>
      {showLabel ? (
        <span aria-hidden="true">
          {done}/{total}
        </span>
      ) : null}
    </span>
  );
}
