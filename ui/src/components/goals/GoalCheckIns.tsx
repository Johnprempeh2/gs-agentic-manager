import type { Agent, GoalCheckIn } from "@greatstone/shared";
import { PenLine } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatDateTime, formatShortDate, relativeTime } from "@/lib/utils";
import { AgentAvatar } from "../AgentAvatar";
import { MarkdownBody } from "../MarkdownBody";

type AgentsById = ReadonlyMap<string, Pick<Agent, "id" | "name" | "appearance">>;

/** One-line preview text: drops the markdown marks a history row cannot render. */
export function plainPreview(body: string): string {
  return body
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+])\s+/gm, "");
}

function authorName(checkIn: GoalCheckIn, agentsById: AgentsById): string {
  if (checkIn.authorAgentId) return agentsById.get(checkIn.authorAgentId)?.name ?? "An agent";
  return "Board";
}

export function GoalCheckInsEmpty({ ownerName }: { ownerName: string | null }) {
  return (
    <div
      className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground"
      data-testid="check-ins-empty"
    >
      <span className="mx-auto grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
        <PenLine className="size-5" aria-hidden />
      </span>
      <p className="mb-1 mt-3 text-sm font-semibold text-foreground">No check-ins yet</p>
      <p className="mx-auto max-w-sm">
        {ownerName ?? "The owner"} writes the first check-in on the next routine run. Progress above is live from
        linked tasks.
      </p>
    </div>
  );
}

export function GoalCheckIns({
  checkIns,
  agentsById,
  ownerName,
}: {
  /** Newest first. */
  checkIns: readonly GoalCheckIn[];
  agentsById: AgentsById;
  ownerName: string | null;
}) {
  const [latest, ...older] = checkIns;
  if (!latest) return <GoalCheckInsEmpty ownerName={ownerName} />;
  const author = latest.authorAgentId ? agentsById.get(latest.authorAgentId) : undefined;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1.5fr_1fr]">
      <Card className="gap-3 p-6" role="region" aria-label="Latest check-in" data-testid="goal-recap">
        <div className="flex items-center gap-2.5">
          {author ? <AgentAvatar agent={author} name={author.name} size={32} /> : null}
          <div className="min-w-0">
            <p className="text-sm font-semibold">Latest check-in</p>
            <p className="text-xs text-muted-foreground" title={formatDateTime(latest.createdAt)}>
              {authorName(latest, agentsById)} · {relativeTime(latest.createdAt)}
            </p>
          </div>
          {latest.progressPercent != null ? (
            <span className="ml-auto text-2xl font-bold tabular-nums">{latest.progressPercent}%</span>
          ) : null}
        </div>
        <MarkdownBody className="text-base leading-relaxed" softBreaks>
          {latest.body}
        </MarkdownBody>
        {latest.blockers.length > 0 ? (
          <div className="space-y-1 border-l-2 border-[var(--goal-blocked)] pl-3 text-sm">
            <p className="font-semibold">Blockers</p>
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
              {latest.blockers.map((blocker, index) => (
                <li key={index}>{blocker}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <section aria-label="Earlier check-ins">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Earlier check-ins</p>
        {older.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">This is the first check-in.</p>
        ) : (
          <ol className="divide-y divide-border" data-testid="check-in-history">
            {older.map((checkIn) => (
              <li key={checkIn.id} className="grid grid-cols-[3.5rem_1fr] gap-3 py-3.5">
                <div>
                  <p className="font-bold tabular-nums">
                    {checkIn.progressPercent != null ? `${checkIn.progressPercent}%` : "–"}
                  </p>
                  <p className="text-xs text-subtle-foreground" title={formatDateTime(checkIn.createdAt)}>
                    {formatShortDate(checkIn.createdAt)}
                  </p>
                </div>
                <div className="min-w-0 text-sm">
                  <p className="line-clamp-3 whitespace-pre-line">{plainPreview(checkIn.body)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{authorName(checkIn, agentsById)}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
