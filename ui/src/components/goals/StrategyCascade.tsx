import { GOAL_KIND_LABELS, type GoalKind, type GoalWithProgress } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { goalHealth } from "@/lib/goal-journey";
import type { StrategyCascade } from "@/lib/goal-cascade";
import { GoalHealthPill } from "./GoalHealth";
import { GoalOwner, type UsersById } from "./GoalOwner";
import type { AgentsById } from "./GoalScoreboard";

/** Left padding per level: pillar, objective, KPI and initiative. */
const DEPTH_INDENT = ["pl-4", "pl-8 sm:pl-10", "pl-12 sm:pl-16", "pl-14 sm:pl-20"];

function KindBadge({ kind }: { kind: GoalKind }) {
  return (
    <Badge variant="outline" className="shrink-0 text-xs uppercase tracking-wide">
      {kind === "csf" ? "CSF" : GOAL_KIND_LABELS[kind]}
    </Badge>
  );
}

function BoardColumn({
  title,
  goals,
  agentsById,
  usersById,
}: {
  title: string;
  goals: GoalWithProgress[];
  agentsById: AgentsById;
  usersById: UsersById;
}) {
  return (
    <div className="grid content-start gap-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {goals.length === 0 ? <p className="text-sm text-muted-foreground">None yet</p> : null}
      {goals.map((goal) => (
        <Link
          key={goal.id}
          to={`/goals/${goal.id}`}
          className="grid gap-1 rounded-md border border-border p-3 text-inherit no-underline hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="cascade-board-goal"
        >
          <span className="text-sm font-semibold">{goal.title}</span>
          <GoalOwner goal={goal} agentsById={agentsById} usersById={usersById} />
        </Link>
      ))}
    </div>
  );
}

/**
 * The strategic plan, top down: what the board sets (vision, values, CSFs),
 * then each pillar with its objectives, KPIs and initiatives and their owners.
 */
export function StrategyCascadeView({
  cascade,
  agentsById,
  usersById,
}: {
  cascade: StrategyCascade<GoalWithProgress>;
  agentsById: AgentsById;
  usersById: UsersById;
}) {
  return (
    <section className="space-y-4" aria-labelledby="strategy-cascade-title" data-testid="strategy-cascade">
      <div>
        <h2 id="strategy-cascade-title" className="text-base font-semibold">Strategic plan</h2>
        <p className="text-sm text-muted-foreground">
          The board sets the vision, values and critical success factors. Exco owns the pillars and everything below.
        </p>
      </div>

      <Card className="grid gap-4 p-4 sm:grid-cols-3">
        <BoardColumn title="Vision" goals={cascade.vision} agentsById={agentsById} usersById={usersById} />
        <BoardColumn title="Values" goals={cascade.values} agentsById={agentsById} usersById={usersById} />
        <BoardColumn
          title="Critical success factors"
          goals={cascade.csfs}
          agentsById={agentsById}
          usersById={usersById}
        />
      </Card>

      <Card className="gap-0 p-0">
        {cascade.strategy.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No pillars yet. Add a pillar under the vision or a CSF.</p>
        ) : (
          <ul className="divide-y divide-border">
            {cascade.strategy.map(({ goal, depth }) => (
              <li key={goal.id} className={cn("py-3 pr-4", DEPTH_INDENT[Math.min(depth, DEPTH_INDENT.length - 1)])}>
                <Link
                  to={`/goals/${goal.id}`}
                  className="flex flex-col gap-1.5 text-inherit no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:gap-3"
                  data-testid="cascade-row"
                  data-kind={goal.kind ?? undefined}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {goal.kind ? <KindBadge kind={goal.kind} /> : null}
                    <span className={cn("min-w-0 text-sm", depth === 0 && "font-semibold")}>{goal.title}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <GoalOwner goal={goal} agentsById={agentsById} usersById={usersById} />
                    <span className="ml-auto w-10 text-right text-xs tabular-nums text-muted-foreground sm:ml-0">
                      {goal.progress.percent == null ? "–" : `${goal.progress.percent}%`}
                    </span>
                    <GoalHealthPill health={goalHealth(goal)} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
