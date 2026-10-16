import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, KeyRound } from "lucide-react";
import type { AgentAccessItem, AgentAccessItemState } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { toolsApi } from "../api/tools";
import { queryKeys } from "../lib/queryKeys";
import { agentRouteRef, relativeTime } from "../lib/utils";
import { agentDetailHref } from "./agent-detail-navigation";
import { LoadingState, ErrorState } from "./tools/shared";

type AgentRef = { id: string; name: string; urlKey?: string | null };

/** Badge colour key (from the shared status tokens) and plain label per state. */
const STATE_BADGE: Record<AgentAccessItemState, { status: string; label: string }> = {
  failing: { status: "error", label: "Not working" },
  missing: { status: "error", label: "Missing" },
  expiring: { status: "warning", label: "Expiring soon" },
  unchecked: { status: "draft", label: "Not checked" },
  ok: { status: "ok", label: "Working" },
};

const KIND_LABEL: Record<AgentAccessItem["kind"], string> = {
  connection: "App",
  mcp_token: "Gateway key",
  secret: "Secret",
  channel: "Channel",
};

export const ATTENTION_STATES: ReadonlySet<AgentAccessItemState> = new Set(["failing", "missing", "expiring"]);

/** Where a row sends the user to fix or look at the thing it describes. */
export function agentAccessItemHref(item: AgentAccessItem, agent: AgentRef): { to: string; label: string } {
  const agentRef = agentRouteRef(agent);
  switch (item.kind) {
    case "connection":
      return { to: `/apps/${item.connectionId ?? item.id}`, label: "Open app" };
    case "secret":
      return { to: agentDetailHref(agentRef, "secrets"), label: "Open secrets" };
    case "channel":
      return { to: agentDetailHref(agentRef, "channels"), label: "Open channels" };
    case "mcp_token":
      return { to: "/apps/gateways", label: "Open gateways" };
  }
}

/** One plain sentence that sums up the agent's access. */
export function agentAccessHeadline(items: AgentAccessItem[]): string {
  const needsAttention = items.filter((item) => ATTENTION_STATES.has(item.state)).length;
  if (needsAttention === 0) return "Everything this agent needs is working";
  return needsAttention === 1 ? "1 thing needs attention" : `${needsAttention} things need attention`;
}

export function AccessRow({ item, agent }: { item: AgentAccessItem; agent: AgentRef }) {
  const badge = STATE_BADGE[item.state];
  const link = agentAccessItemHref(item, agent);
  const detail = item.reason
    ?? (item.lastUsedAt ? `Last used ${relativeTime(item.lastUsedAt)}` : null);
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-3" data-testid="agent-access-row" data-state={item.state}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{item.label}</span>
          <span className="text-xs text-muted-foreground">{KIND_LABEL[item.kind]}</span>
        </div>
        {detail ? <p className="mt-1 text-sm text-muted-foreground">{detail}</p> : null}
      </div>
      <StatusBadge status={badge.status} label={badge.label} />
      <Link to={link.to} className="text-sm font-medium text-primary hover:underline">
        {link.label}
      </Link>
    </li>
  );
}

export function AgentAccessTab({ agent, companyId }: { agent: AgentRef; companyId: string }) {
  const [showWorking, setShowWorking] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.tools.agentAccess(companyId),
    queryFn: () => toolsApi.listAgentAccess(companyId),
  });

  if (query.isLoading) return <LoadingState label="Loading access" />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const summary = query.data?.agents.find((entry) => entry.agentId === agent.id);
  const items = summary?.items ?? [];
  if (items.length === 0) {
    return (
      <EmptyState
        icon={KeyRound}
        message="This agent has no apps, keys or channels yet."
      />
    );
  }

  const attention = items.filter((item) => ATTENTION_STATES.has(item.state));
  const working = items.filter((item) => !ATTENTION_STATES.has(item.state));

  return (
    <div className="space-y-4">
      <p className="text-base font-medium" data-testid="agent-access-headline">
        {agentAccessHeadline(items)}
      </p>

      {attention.length > 0 ? (
        <section aria-label="Needs attention" className="rounded-lg border border-border bg-card">
          <ul className="divide-y divide-border">
            {attention.map((item) => (
              <AccessRow key={`${item.kind}:${item.id}`} item={item} agent={agent} />
            ))}
          </ul>
        </section>
      ) : null}

      {working.length > 0 ? (
        <section className="rounded-lg border border-border bg-card">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-3 text-left text-sm font-medium"
            aria-expanded={showWorking}
            onClick={() => setShowWorking((value) => !value)}
          >
            {showWorking
              ? <ChevronDown className="h-4 w-4" aria-hidden="true" />
              : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
            Working ({working.length})
          </button>
          {showWorking ? (
            <ul className="divide-y divide-border border-t border-border">
              {working.map((item) => (
                <AccessRow key={`${item.kind}:${item.id}`} item={item} agent={agent} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
