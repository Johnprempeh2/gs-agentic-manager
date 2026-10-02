import type {
  AgentWorkDigest,
  AgentWorkDigestAgent,
  AgentWorkDigestCounts,
  AgentWorkDigestItem,
  AgentWorkDigestItemKind,
} from "@greatstone/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, CircleAlert, CirclePlay, MessageCircleQuestion, type LucideIcon } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { agentWorkDigestApi } from "../api/agentWorkDigest";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn, issueUrl } from "../lib/utils";

export const SINCE_LAST_VISIT_PATH = "/since-last-visit";
/** Agents named on the home card; the full view has the rest. */
export const DASHBOARD_DIGEST_AGENT_LIMIT = 3;

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "2 tasks finished, 1 started, 1 failed run": only the kinds that happened. */
export function digestCountsSentence(counts: AgentWorkDigestCounts): string {
  const parts: string[] = [];
  if (counts.tasksFinished) parts.push(`${plural(counts.tasksFinished, "task", "tasks")} finished`);
  if (counts.tasksStarted) parts.push(parts.length ? `${counts.tasksStarted} started` : `${plural(counts.tasksStarted, "task", "tasks")} started`);
  if (counts.decisionsRaised) parts.push(plural(counts.decisionsRaised, "decision for you", "decisions for you"));
  if (counts.failures) parts.push(plural(counts.failures, "failed run", "failed runs"));
  return parts.length ? parts.join(", ") : "No agent work";
}

/** Where the digest window starts, in words. */
export function digestSinceLabel(digest: Pick<AgentWorkDigest, "since" | "sinceSource">): string {
  if (digest.sinceSource === "default_window") return "In the last 24 hours";
  if (digest.sinceSource === "last_visit") return `Since your last visit, ${timeAgo(digest.since)}`;
  return `Since ${new Date(digest.since).toLocaleString()}`;
}

export function useAgentWorkDigest(companyId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.agentWorkDigest(companyId!),
    queryFn: () => agentWorkDigestApi.get(companyId!),
    enabled: !!companyId,
  });
}

/**
 * Home card: what the agents did since the user last read the digest, in one
 * line per agent, with one tap to the full view (GRE-357). Replaces reading
 * the raw Audit log for "what happened overnight".
 */
export function DashboardDigestCardView({
  digest,
  loading = false,
  error = null,
}: {
  digest: AgentWorkDigest | null | undefined;
  loading?: boolean;
  error?: Error | null;
}) {
  const agents = digest?.agents ?? [];
  const shown = agents.slice(0, DASHBOARD_DIGEST_AGENT_LIMIT);
  const hidden = agents.length - shown.length;

  return (
    <Card className="flex min-w-0 flex-col gap-2 px-4 py-3" aria-label="Since you were last here" data-testid="dashboard-digest" role="region">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Since you were last here</h3>
          {digest ? <p className="truncate text-xs text-muted-foreground">{digestSinceLabel(digest)}</p> : null}
        </div>
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link to={SINCE_LAST_VISIT_PATH}>
            See what happened
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>

      {loading && !digest ? (
        <Skeleton className="h-5 w-full max-w-xs" aria-busy="true" aria-label="Loading agent work" />
      ) : error && !digest ? (
        <p className="truncate text-sm text-destructive">Could not load agent work: {error.message}</p>
      ) : shown.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          No new agent work.
        </p>
      ) : (
        <ul className="space-y-1 text-sm" aria-label="Agent work by agent">
          {shown.map((agent) => (
            <li key={agent.agentId} className="flex min-w-0 gap-1.5">
              <span className="shrink-0 font-medium">{agent.agentName}:</span>
              <span className="truncate text-muted-foreground">{digestCountsSentence(agent.counts)}</span>
            </li>
          ))}
          {hidden > 0 ? (
            <li className="text-xs text-muted-foreground">and {plural(hidden, "more agent", "more agents")}</li>
          ) : null}
        </ul>
      )}
    </Card>
  );
}

export function DashboardDigestCard({ companyId }: { companyId: string }) {
  const { data, isLoading, error } = useAgentWorkDigest(companyId);
  return <DashboardDigestCardView digest={data} loading={isLoading} error={error} />;
}

const KIND_ICON: Record<AgentWorkDigestItemKind, { icon: LucideIcon; label: string; className?: string }> = {
  task_finished: { icon: CheckCircle2, label: "Finished" },
  task_started: { icon: CirclePlay, label: "Started" },
  decision_raised: { icon: MessageCircleQuestion, label: "Needs you" },
  run_failed: { icon: CircleAlert, label: "Failed", className: "text-destructive" },
};

function DigestItemRow({ item }: { item: AgentWorkDigestItem }) {
  const kind = KIND_ICON[item.kind];
  const Icon = kind.icon;
  const href = item.issueId ? issueUrl({ id: item.issueId, identifier: item.issueIdentifier }) : null;
  return (
    <li className="flex min-w-0 items-start gap-2 px-4 py-2.5 text-sm">
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground", kind.className)} aria-label={kind.label} />
      {href ? (
        <Link to={href} className="min-w-0 flex-1 break-words text-inherit no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
          {item.label}
        </Link>
      ) : (
        <span className="min-w-0 flex-1 break-words">{item.label}</span>
      )}
      <time dateTime={item.at} className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {timeAgo(item.at)}
      </time>
    </li>
  );
}

/** One agent's work since the last visit, newest first, each line linking to its task. */
export function DigestAgentSection({ agent }: { agent: AgentWorkDigestAgent }) {
  const headingId = `digest-agent-${agent.agentId}`;
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <div className="mb-2 flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h2 id={headingId} className="text-sm font-semibold">{agent.agentName}</h2>
        <span className="text-xs text-muted-foreground">{digestCountsSentence(agent.counts)}</span>
      </div>
      <Card className="block py-0 overflow-hidden">
        <ul className="divide-y divide-border" aria-label={`${agent.agentName} work`}>
          {agent.items.map((item, index) => (
            <DigestItemRow key={`${item.kind}:${item.issueId ?? item.runId ?? ""}:${item.at}:${index}`} item={item} />
          ))}
        </ul>
      </Card>
    </section>
  );
}
