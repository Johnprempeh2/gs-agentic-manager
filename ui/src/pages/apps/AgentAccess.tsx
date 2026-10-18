import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, KeyRound } from "lucide-react";
import type { AgentAccessAgentSummary } from "@greatstone/shared";
import { Link, useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { EmptyState } from "@/components/EmptyState";
import { toolsApi } from "../../api/tools";
import { queryKeys } from "../../lib/queryKeys";
import { agentUrl } from "../../lib/utils";
import { AccessRow, ATTENTION_STATES, agentAccessHeadline } from "../AgentAccessTab";
import { ErrorState, LoadingState } from "../tools/shared";

function attentionCount(agent: AgentAccessAgentSummary): number {
  return agent.items.filter((item) => ATTENTION_STATES.has(item.state)).length;
}

/** One plain sentence for the whole company, for example "2 agents need attention". */
export function companyAccessHeadline(agents: readonly AgentAccessAgentSummary[]): string {
  const needing = agents.filter((agent) => attentionCount(agent) > 0).length;
  if (needing === 0) return "Every agent has what it needs";
  return needing === 1 ? "1 agent needs attention" : `${needing} agents need attention`;
}

/**
 * Agents with something missing, failing or expiring come first, most
 * problems first; agents where everything works follow, by name.
 */
export function sortAgentsForAccess(agents: readonly AgentAccessAgentSummary[]): AgentAccessAgentSummary[] {
  return [...agents].sort(
    (a, b) => attentionCount(b) - attentionCount(a) || a.name.localeCompare(b.name),
  );
}

function AgentAccessCard({ agent }: { agent: AgentAccessAgentSummary }) {
  const ref = { id: agent.agentId, name: agent.name };
  const attention = agent.items.filter((item) => ATTENTION_STATES.has(item.state));
  return (
    <section
      className="rounded-lg border border-border bg-card"
      aria-label={agent.name}
      data-testid="company-access-agent"
    >
      <header className="flex flex-wrap items-center gap-2 px-3 py-3">
        <Link to={agentUrl(ref)} className="text-sm font-semibold text-foreground hover:underline">
          {agent.name}
        </Link>
        <span className="text-sm text-muted-foreground">{agentAccessHeadline(agent.items)}</span>
      </header>
      {attention.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border">
          {attention.map((item) => (
            <AccessRow key={`${item.kind}:${item.id}`} item={item} agent={ref} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Apps > Agent access: what every agent can reach, and what is missing or expiring. */
export function AgentAccess() {
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [showWorking, setShowWorking] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Connectors", href: "/apps" }, { label: "Agent access" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const query = useQuery({
    queryKey: queryKeys.tools.agentAccess(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listAgentAccess(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (query.isLoading) return <LoadingState label="Loading agent access" />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const agents = sortAgentsForAccess((query.data?.agents ?? []).filter((agent) => agent.items.length > 0));
  if (agents.length === 0) {
    return (
      <EmptyState
        icon={KeyRound}
        message="No agent has apps, keys or channels yet. Connect an app to give agents access."
        action="Browse connectors"
        onAction={() => navigate("/apps")}
        hideActionIcon
      />
    );
  }

  const needing = agents.filter((agent) => attentionCount(agent) > 0);
  const working = agents.filter((agent) => attentionCount(agent) === 0);

  return (
    <div className="max-w-5xl space-y-4 pb-12">
      <div className="space-y-1">
        <p className="text-base font-medium" data-testid="company-access-headline">
          {companyAccessHeadline(agents)}
        </p>
        <p className="text-sm text-muted-foreground">
          Apps, keys and channels each agent relies on. Fix anything missing or expiring before a run fails on it.
        </p>
      </div>

      {needing.map((agent) => (
        <AgentAccessCard key={agent.agentId} agent={agent} />
      ))}

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
            Everything working ({working.length})
          </button>
          {showWorking ? (
            <ul className="divide-y divide-border border-t border-border">
              {working.map((agent) => (
                <li key={agent.agentId} className="flex flex-wrap items-center gap-2 px-3 py-3">
                  <Link
                    to={agentUrl({ id: agent.agentId, name: agent.name })}
                    className="text-sm font-medium text-foreground hover:underline"
                  >
                    {agent.name}
                  </Link>
                  <span className="text-sm text-muted-foreground">
                    {agent.items.length === 1 ? "1 thing working" : `${agent.items.length} things working`}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
