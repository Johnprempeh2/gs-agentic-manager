import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@/lib/router";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import type { Agent } from "@greatstone/shared";
import { MessageCircle } from "lucide-react";
import { agentRouteRef, cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
export function isChatWith(pathname: string, agent: { id: string; name?: string | null; urlKey?: string | null }): boolean {
  const match = /\/chats\/([^/?#]+)\/?$/.exec(pathname);
  if (!match) return false;
  const ref = decodeURIComponent(match[1]!);
  return ref === agent.id || ref === agentRouteRef(agent);
}

/** The company's lead agent (Everest), or null while loading or when there is none. */
export function useLeadAgent() {
  const { selectedCompanyId } = useCompany();
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  return agents ? resolveLeadAgent(agents) : null;
}

/** Where "Ask Everest" goes: the lead agent's chat. */
export function leadChatHref(lead: Pick<Agent, "id" | "name" | "urlKey">): string {
  return `/chats/${encodeURIComponent(agentRouteRef(lead))}`;
}

/**
 * "Ask Everest", in words, as the first thing in the sidebar (Ben, 13 Oct:
 * he had to be told "on the left, at the top, Everest"). Opens the lead
 * agent's chat; an icon with a tooltip on the collapsed rail.
 */
export function SidebarAskEverest({ rail = false }: { rail?: boolean }) {
  const lead = useLeadAgent();
  const { isMobile, setSidebarOpen } = useSidebar();
  if (!lead) return null;
  const label = `Ask ${lead.name}`;
  const link = (
    <Link
      to={leadChatHref(lead)}
      data-testid="sidebar-ask-everest"
      aria-label={rail ? label : undefined}
      onClick={() => { if (isMobile) setSidebarOpen(false); }}
      className={cn(
        "mx-2 flex items-center gap-2.5 rounded-lg bg-primary px-2 py-2 text-(length:--text-compact) font-semibold text-primary-foreground shadow-xs outline-none transition-colors hover:bg-primary/90 focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
        rail && "justify-center px-0",
      )}
    >
      <AgentAvatar agent={lead} size={20} />
      <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>{label}</span>
      {rail ? null : <MessageCircle className="ml-auto h-4 w-4 shrink-0" aria-hidden="true" />}
    </Link>
  );
  return rail ? (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  ) : link;
}

export function MobileEverestButton() {
  const { pathname } = useLocation();
  const lead = useLeadAgent();
  if (!lead) return null;
  // Already in the lead's chat: its header shows the agent, so no second face.
  if (isChatWith(pathname, lead)) return null;
  return (
    <Link
      to={leadChatHref(lead)}
      aria-label={`Ask ${lead.name}`}
      className="ml-2 flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-primary py-1 pl-1 pr-3 text-sm font-semibold text-primary-foreground transition-transform duration-(--motion-press) active:scale-95"
    >
      <AgentAvatar agent={lead} size={32} />
      <span aria-hidden="true">Ask {lead.name}</span>
    </Link>
  );
}
