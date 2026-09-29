import type { Agent, GoalWithProgress } from "@greatstone/shared";
import { ArrowRight, Flag, Plus } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn, relativeTime } from "@/lib/utils";
import {
  blockerText,
  formatTargetDate,
  remainingLabel,
  type GoalHealth,
  type ScoreboardEntry,
} from "@/lib/goal-journey";
import { AgentAvatar } from "../AgentAvatar";
import {
  GoalHealthPill,
  GoalPercent,
  GoalProgressBar,
  GoalProgressRing,
  healthStyle,
} from "./GoalHealth";

export type AgentsById = ReadonlyMap<string, Pick<Agent, "id" | "name" | "appearance">>;

const LEVEL_LABEL: Record<string, string> = {
  company: "company goal",
  team: "team goal",
  agent: "agent goal",
  task: "task goal",
};

function goalHref(goal: Pick<GoalWithProgress, "id">) {
  return `/goals/${goal.id}`;
}

function MainBlocker({ goal, health }: { goal: GoalWithProgress; health: GoalHealth }) {
  const [first, ...rest] = goal.blockers;
  if (!first) return null;
  return (
    <p
      className="border-l-2 border-[var(--sc)] py-0.5 pl-2.5 text-sm text-muted-foreground"
      style={healthStyle(health === "blocked" ? "blocked" : "at_risk")}
      data-testid="goal-main-blocker"
    >
      <span className="font-semibold text-foreground">Main blocker:</span> {blockerText(first)}
      {rest.length > 0 ? <span className="text-subtle-foreground"> · +{rest.length} more</span> : null}
    </p>
  );
}

function SubGoalTile({
  goal,
  health,
  agentsById,
}: {
  goal: GoalWithProgress;
  health: GoalHealth;
  agentsById: AgentsById;
}) {
  const owner = goal.ownerAgentId ? agentsById.get(goal.ownerAgentId) : undefined;
  const left = remainingLabel(goal);
  const target = formatTargetDate(goal.targetDate);
  const detail = [
    goal.progress.percent == null ? null : `${goal.progress.percent}%`,
    owner?.name,
    left,
    target ? `target ${target}` : null,
  ].filter(Boolean);
  return (
    <Link
      to={goalHref(goal)}
      className="relative z-10 grid gap-2 rounded-md border border-border p-3 text-inherit no-underline transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="goal-sub-tile"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-semibold">{goal.title}</span>
        <GoalHealthPill health={health} className="ml-auto" />
      </span>
      <GoalProgressBar percent={goal.progress.percent} health={health} />
      <span className="truncate text-xs text-muted-foreground">{detail.join(" · ")}</span>
    </Link>
  );
}

export function GoalScoreCard({
  entry,
  agentsById,
}: {
  entry: ScoreboardEntry;
  agentsById: AgentsById;
}) {
  const { goal, health, subGoals } = entry;
  const owner = goal.ownerAgentId ? agentsById.get(goal.ownerAgentId) : undefined;
  const left = remainingLabel(goal);
  const target = formatTargetDate(goal.targetDate);
  const wide = subGoals.length > 0;

  const summary = (
    <div className="grid min-w-0 gap-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <AgentAvatar agent={owner} name={owner?.name} size={32} />
        <div className="min-w-0">
          <Link
            to={goalHref(goal)}
            className="block truncate text-sm font-semibold text-inherit no-underline after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            {goal.title}
          </Link>
          <p className="truncate text-xs text-muted-foreground">
            {owner?.name ?? "No owner"} · {LEVEL_LABEL[goal.level] ?? "goal"}
          </p>
        </div>
        <GoalHealthPill health={health} className="ml-auto" />
      </div>

      <div className="flex items-center gap-4">
        <GoalProgressRing percent={goal.progress.percent} health={health} />
        <div className="min-w-0">
          <GoalPercent percent={goal.progress.percent} />
          <p className="mt-1 text-sm text-muted-foreground">
            {left ? <span className="font-semibold text-foreground">{left}</span> : "No linked tasks yet"}
          </p>
        </div>
      </div>

      <MainBlocker goal={goal} health={health} />
    </div>
  );

  return (
    <Card
      className={cn("relative gap-4 p-5", wide && "md:col-span-full")}
      data-testid="goal-score-card"
      data-health={health}
    >
      {wide ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr] lg:items-start">
          {summary}
          <div className="grid gap-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sub-goals</p>
            <div className="grid gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]">
              {subGoals.map((sub) => (
                <SubGoalTile key={sub.goal.id} goal={sub.goal} health={sub.health} agentsById={agentsById} />
              ))}
            </div>
          </div>
        </div>
      ) : (
        summary
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-subtle-foreground">
        <span>{target ? `Target ${target}` : "No target date"}</span>
        <span>
          {goal.latestCheckIn ? `Last check-in ${relativeTime(goal.latestCheckIn.createdAt)}` : "No check-ins yet"}
        </span>
        <span className="ml-auto hidden items-center gap-1 sm:inline-flex" aria-hidden>
          Open journey <ArrowRight className="size-3" />
        </span>
      </div>
    </Card>
  );
}

export function GoalsEmptyState({ onNewGoal }: { onNewGoal: () => void }) {
  return (
    <div
      className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground"
      data-testid="goals-empty"
    >
      <span className="mx-auto grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
        <Flag className="size-5" aria-hidden />
      </span>
      <p className="mb-1 mt-3 text-sm font-semibold text-foreground">No goals yet</p>
      <p className="mx-auto max-w-sm">
        Set a goal and your lead agent will track it, check in on it and clear what blocks it.
      </p>
      <Button size="sm" className="mt-4" onClick={onNewGoal}>
        <Plus className="size-3.5" />
        New goal
      </Button>
    </div>
  );
}

export function GoalScoreboardView({
  entries,
  agentsById,
}: {
  entries: ScoreboardEntry[];
  agentsById: AgentsById;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-[repeat(auto-fill,minmax(20rem,1fr))]" data-testid="goal-scoreboard">
      {entries.map((entry) => (
        <GoalScoreCard key={entry.goal.id} entry={entry} agentsById={agentsById} />
      ))}
    </div>
  );
}
