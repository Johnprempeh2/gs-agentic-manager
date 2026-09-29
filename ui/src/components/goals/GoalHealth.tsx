import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { GOAL_HEALTH_COLOR, GOAL_HEALTH_LABEL, type GoalHealth } from "@/lib/goal-journey";

/** Seeds `--sc` (see `.status-chip` in index.css) with the health hue. */
export function healthStyle(health: GoalHealth): CSSProperties {
  return { "--sc": GOAL_HEALTH_COLOR[health] } as CSSProperties;
}

export function GoalHealthPill({ health, className }: { health: GoalHealth; className?: string }) {
  return (
    <span
      className={cn(
        "status-chip inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        className,
      )}
      style={healthStyle(health)}
      data-health={health}
    >
      {GOAL_HEALTH_LABEL[health]}
    </span>
  );
}

const RING_RADIUS = 28;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function GoalProgressRing({
  percent,
  health,
  className,
}: {
  percent: number | null;
  health: GoalHealth;
  className?: string;
}) {
  const filled = ((percent ?? 0) / 100) * RING_CIRCUMFERENCE;
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("size-16 shrink-0", className)}
      style={healthStyle(health)}
      aria-hidden
    >
      <circle cx="32" cy="32" r={RING_RADIUS} fill="none" strokeWidth="5" className="stroke-muted" />
      {filled > 0 ? (
        <circle
          cx="32"
          cy="32"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          stroke="var(--sc)"
          strokeDasharray={`${filled} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 32 32)"
          className="transition-[stroke-dasharray] duration-700 ease-out motion-reduce:transition-none"
        />
      ) : null}
    </svg>
  );
}

export function GoalProgressBar({ percent, health }: { percent: number | null; health: GoalHealth }) {
  return (
    <div className="h-1 overflow-hidden rounded-full bg-muted" style={healthStyle(health)} aria-hidden>
      <div
        className="status-fill h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none"
        style={{ width: `${percent ?? 0}%` }}
      />
    </div>
  );
}

/** The one number per goal: "62%", or a dash when there is nothing to measure. */
export function GoalPercent({ percent, className }: { percent: number | null; className?: string }) {
  return (
    <span className={cn("text-4xl font-bold leading-none tracking-tight tabular-nums", className)}>
      {percent == null ? "–" : percent}
      {percent == null ? null : <span className="text-lg font-semibold text-muted-foreground">%</span>}
    </span>
  );
}

const LEGEND: GoalHealth[] = ["done", "on_track", "at_risk", "blocked"];

export function GoalHealthLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Status colours">
      {LEGEND.map((health) => (
        <li key={health} className="flex items-center gap-1.5">
          <span className="status-fill size-2 rounded-full" style={healthStyle(health)} aria-hidden />
          {GOAL_HEALTH_LABEL[health]}
        </li>
      ))}
    </ul>
  );
}
