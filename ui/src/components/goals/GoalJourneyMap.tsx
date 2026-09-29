import type { Agent, GoalMilestone } from "@greatstone/shared";
import type { KeyboardEvent } from "react";
import { Route } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, issueUrl, relativeTime } from "@/lib/utils";
import {
  buildJourney,
  JOURNEY_STOP_LABEL,
  type JourneyStop,
  type JourneyStopKind,
} from "@/lib/goal-journey";

type Point = { x: number; y: number };

interface RouteShape {
  width: number;
  height: number;
  at: (t: number) => Point;
  vertical: boolean;
}

const SAMPLES = 96;

/** A gentle wave from left to right (desktop) or top to bottom (phone). */
export function routeShape(stopCount: number, vertical: boolean): RouteShape {
  const n = stopCount + 1; // stops + flag
  if (!vertical) {
    const width = 1040;
    const height = 300;
    return {
      width,
      height,
      vertical,
      at: (t) => ({ x: 60 + t * (width - 140), y: height / 2 + 56 * Math.sin(2 * Math.PI * 1.1 * t - 0.6) }),
    };
  }
  const width = 360;
  const height = Math.max(360, n * 76 + 40);
  const waves = Math.max(1, n / 3);
  return {
    width,
    height,
    vertical,
    at: (t) => ({ x: width / 2 + 80 * Math.sin(2 * Math.PI * waves * t), y: 36 + t * (height - 72) }),
  };
}

export function routePath(shape: RouteShape, from = 0, to = 1): string {
  const steps = Math.max(2, Math.round(SAMPLES * (to - from)));
  let d = "";
  for (let i = 0; i <= steps; i += 1) {
    const p = shape.at(from + ((to - from) * i) / steps);
    d += `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  return d;
}

/** Where stop `index` sits along the route (0..1); the flag is index `count`. */
export function stopT(index: number, count: number): number {
  return (index + 0.5) / (count + 1);
}

const KIND_COLOR: Record<JourneyStopKind, string> = {
  done: "var(--goal-on-track)",
  here: "var(--goal-on-track)",
  active: "var(--goal-on-track)",
  blocked: "var(--goal-blocked)",
  ahead: "var(--goal-ahead)",
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function StopMark({ kind, p }: { kind: JourneyStopKind; p: Point }) {
  const color = KIND_COLOR[kind];
  if (kind === "here") {
    return (
      <>
        <circle cx={p.x} cy={p.y} r={16} fill={color} opacity={0.25} className="goal-here-pulse" />
        <circle cx={p.x} cy={p.y} r={10} className="fill-card" stroke={color} strokeWidth={4} />
      </>
    );
  }
  if (kind === "active") {
    return <circle cx={p.x} cy={p.y} r={8} className="fill-card" stroke={color} strokeWidth={3} />;
  }
  if (kind === "done") return <circle cx={p.x} cy={p.y} r={7} fill={color} />;
  if (kind === "blocked") {
    return (
      <>
        <circle cx={p.x} cy={p.y} r={9} fill={color} />
        <path
          d={`M${p.x - 3.5} ${p.y - 3.5}l7 7m0-7l-7 7`}
          className="stroke-card"
          strokeWidth={2}
          strokeLinecap="round"
        />
      </>
    );
  }
  return (
    <circle cx={p.x} cy={p.y} r={7} className="fill-card" stroke={color} strokeWidth={2} strokeDasharray="3 3" />
  );
}

function StopDetail({ stop, agentsById }: { stop: JourneyStop; agentsById: ReadonlyMap<string, Pick<Agent, "name">> }) {
  const m = stop.milestone;
  if (!m) {
    const shown = stop.titles.slice(0, 5);
    return (
      <div className="max-w-60 space-y-1 text-left">
        <p className="font-semibold">{stop.label}</p>
        <ul className="space-y-0.5">
          {shown.map((title, index) => (
            <li key={index} className="truncate">{title}</li>
          ))}
          {stop.titles.length > shown.length ? <li>and {stop.titles.length - shown.length} more</li> : null}
        </ul>
      </div>
    );
  }
  const assignee = m.assigneeAgentId ? agentsById.get(m.assigneeAgentId)?.name : null;
  const when = m.completedAt ? `done ${relativeTime(m.completedAt)}` : `added ${relativeTime(m.createdAt)}`;
  return (
    <div className="max-w-60 space-y-0.5 text-left">
      <p className="font-semibold">{m.title}</p>
      <p>
        {JOURNEY_STOP_LABEL[stop.kind]}
        {m.identifier ? ` · ${m.identifier}` : ""}
        {assignee ? ` · ${assignee}` : ""}
      </p>
      <p className="opacity-80">{when}</p>
    </div>
  );
}

function RouteSvg({
  stops,
  reachedIndex,
  vertical,
  agentsById,
  onOpen,
}: {
  stops: JourneyStop[];
  reachedIndex: number;
  vertical: boolean;
  agentsById: ReadonlyMap<string, Pick<Agent, "name">>;
  onOpen: (milestone: GoalMilestone) => void;
}) {
  const shape = routeShape(stops.length, vertical);
  const count = stops.length;
  const flag = shape.at(stopT(count, count));
  const reachedT = reachedIndex >= 0 ? stopT(reachedIndex, count) : 0;

  const onKey = (event: KeyboardEvent, milestone: GoalMilestone | null) => {
    if (!milestone) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(milestone);
    }
  };

  return (
    <svg
      viewBox={`0 0 ${shape.width} ${shape.height}`}
      className="block h-auto w-full overflow-visible"
      role="list"
      aria-label="Journey to the goal"
      data-orientation={vertical ? "vertical" : "horizontal"}
    >
      <path d={routePath(shape)} fill="none" strokeWidth={6} strokeLinecap="round" className="stroke-foreground/10" />
      <path
        d={routePath(shape)}
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray="2 8"
        stroke="var(--goal-ahead)"
      />
      {reachedT > 0 ? (
        <path
          d={routePath(shape, 0, reachedT)}
          pathLength={1}
          fill="none"
          strokeWidth={6}
          strokeLinecap="round"
          stroke="var(--goal-on-track)"
          className="goal-route-draw"
        />
      ) : null}

      {stops.map((stop, index) => {
        const p = shape.at(stopT(index, count));
        const bold = stop.kind === "here" || stop.kind === "blocked";
        const labelClass = cn(vertical ? "text-xs" : "text-sm", bold ? "fill-foreground font-semibold" : "fill-muted-foreground");
        const side = vertical ? (p.x < shape.width / 2 ? 1 : -1) : index % 2 === 0 ? 1 : -1;
        const label = truncate(stop.label, vertical ? 24 : 22);
        const labelProps: { x: number; y: number; textAnchor: "start" | "middle" | "end" } = vertical
          ? { x: p.x + side * 20, y: p.y + 4, textAnchor: side > 0 ? "start" : "end" }
          : { x: p.x, y: p.y + (side > 0 ? 34 : -24), textAnchor: "middle" };
        return (
          <Tooltip key={stop.key}>
            <TooltipTrigger asChild>
              <g
                role="listitem"
                tabIndex={0}
                aria-label={`${stop.label}: ${JOURNEY_STOP_LABEL[stop.kind]}`}
                data-stop-kind={stop.kind}
                className={cn(
                  "goal-stop-in outline-none focus-visible:[&>circle:first-child]:stroke-ring",
                  stop.milestone && "cursor-pointer",
                )}
                style={{ animationDelay: `${120 + index * 60}ms` }}
                onClick={() => stop.milestone && onOpen(stop.milestone)}
                onKeyDown={(event) => onKey(event, stop.milestone)}
              >
                {/* Larger invisible hit area so the small dots are easy to hover and tap. */}
                <circle cx={p.x} cy={p.y} r={18} fill="transparent" strokeWidth={2} className="stroke-transparent" />
                <StopMark kind={stop.kind} p={p} />
                <text {...labelProps} className={labelClass}>
                  {label}
                </text>
                {stop.kind === "here" ? (
                  <text
                    x={labelProps.x}
                    y={vertical ? p.y + 20 : p.y + (side > 0 ? 50 : -40)}
                    textAnchor={labelProps.textAnchor}
                    className={cn(vertical ? "text-xs" : "text-sm", "font-semibold")}
                    fill="var(--goal-on-track)"
                  >
                    we are here
                  </text>
                ) : null}
              </g>
            </TooltipTrigger>
            <TooltipContent side={vertical ? "right" : "top"} sideOffset={6}>
              <StopDetail stop={stop} agentsById={agentsById} />
            </TooltipContent>
          </Tooltip>
        );
      })}

      <g role="listitem" aria-label="Goal reached" className="goal-stop-in" style={{ animationDelay: `${120 + count * 60}ms` }}>
        <path
          d={`M${flag.x} ${flag.y + 10}V${flag.y - 26}l18 7-18 7`}
          className="fill-primary stroke-foreground"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        <text
          x={vertical ? flag.x - 12 : flag.x}
          y={vertical ? flag.y + 4 : flag.y + 30}
          textAnchor={vertical ? "end" : "middle"}
          className="fill-foreground text-xs font-semibold"
        >
          Goal
        </text>
      </g>
    </svg>
  );
}

export function GoalJourneyEmpty() {
  return (
    <div
      className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground"
      data-testid="journey-empty"
    >
      <span className="mx-auto grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
        <Route className="size-5" aria-hidden />
      </span>
      <p className="mb-1 mt-3 text-sm font-semibold text-foreground">No stops on the route yet</p>
      <p className="mx-auto max-w-sm">Link tasks to this goal and they appear here as stops on the way.</p>
    </div>
  );
}

export function GoalJourneyMap({
  milestones,
  agentsById,
}: {
  milestones: readonly GoalMilestone[];
  agentsById: ReadonlyMap<string, Pick<Agent, "name">>;
}) {
  const navigate = useNavigate();
  const { stops, reachedIndex } = buildJourney(milestones);
  if (stops.length === 0) return <GoalJourneyEmpty />;
  const open = (milestone: GoalMilestone) => navigate(issueUrl(milestone));

  return (
    <TooltipProvider delayDuration={80}>
      <div className="gs-glass-card rounded-lg border px-4 py-2 lg:px-2" data-testid="goal-journey-map">
        <div className="hidden lg:block">
          <RouteSvg stops={stops} reachedIndex={reachedIndex} vertical={false} agentsById={agentsById} onOpen={open} />
        </div>
        <div className="mx-auto max-w-md lg:hidden">
          <RouteSvg stops={stops} reachedIndex={reachedIndex} vertical agentsById={agentsById} onOpen={open} />
        </div>
      </div>
    </TooltipProvider>
  );
}
