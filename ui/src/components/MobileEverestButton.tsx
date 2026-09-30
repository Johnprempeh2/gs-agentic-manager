import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { agentRouteRef } from "../lib/utils";
import { AgentAvatar } from "./AgentAvatar";

type LeadCandidate = { id: string; role?: string | null; status?: string | null; reportsTo?: string | null };

/**
 * The team's lead: a `ceo` agent if there is one, else the top of the org
 * chart (no manager) with the most direct reports. Everest in Greatstone's
 * team; whoever leads on a client install.
 */
export function resolveLeadAgent<T extends LeadCandidate>(agents: readonly T[]): T | null {
  const active = agents.filter((agent) => agent.status !== "terminated");
  const ceo = active.find((agent) => agent.role === "ceo");
  if (ceo) return ceo;
  const reports = new Map<string, number>();
  for (const agent of active) {
    if (agent.reportsTo) reports.set(agent.reportsTo, (reports.get(agent.reportsTo) ?? 0) + 1);
  }
  const roots = active
    .filter((agent) => !agent.reportsTo && (reports.get(agent.id) ?? 0) > 0)
    .sort((a, b) => (reports.get(b.id) ?? 0) - (reports.get(a.id) ?? 0));
  return roots[0] ?? null;
}

/**
 * Phone header shortcut to the lead agent's chat (Everest): one tap from any
 * main tab. Hidden when the team has no lead.
 */
export function MobileEverestButton() {
  const { selectedCompanyId } = useCompany();
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const lead = agents ? resolveLeadAgent(agents) : null;
  if (!lead) return null;
  return (
    <Link
      to={`/chats/${encodeURIComponent(agentRouteRef(lead))}`}
      aria-label={`Chat with ${lead.name}`}
      className="ml-2 flex size-10 shrink-0 items-center justify-center rounded-full transition-transform duration-(--motion-press) active:scale-95"
    >
      <span className="rounded-full p-0.5 ring-2 ring-primary/60">
        <AgentAvatar agent={lead} size={32} />
      </span>
    </Link>
  );
}
