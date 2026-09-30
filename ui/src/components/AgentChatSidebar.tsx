import { Star, SquarePen, MessageSquarePlus } from "lucide-react";
import { SidebarNavItem } from "@/components/SidebarNavItem";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/context/SidebarContext";
import type { Agent } from "@greatstone/shared";
import { agentRouteRef, cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { orderChatAgents } from "@/lib/recent-agent-chats";
export function AgentChatSidebar({
  activeId,
  starredIds,
  recentIds,
  onToggleStar,
  onOpenChat,
  agents,
  inline = false,
  href = (id: string) =>
    `/chats/${encodeURIComponent(agentRouteRef(agents.find((agent) => agent.id === id)!))}`,
}: {
  agents: Agent[];
  href?: (id: string) => string;
  activeId: string;
  starredIds: string[];
  recentIds: string[];
  onToggleStar: (id: string) => void;
  onOpenChat: () => void;
  /** Rows only, no "Chats" heading: the primary sidebar puts them straight under Search (GRE-259). */
  inline?: boolean;
}) {
  const { collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const ordered = orderChatAgents(agents, starredIds, recentIds);
  const row = (agent: Agent) => {
    const pinned = starredIds.includes(agent.id);
    return (
      <div key={agent.id} className="group/agent-chat relative">
        <SidebarNavItem
          to={href(agent.id)}
          label={agent.name}
          active={activeId === agent.id}
          iconNode={
            <AgentIcon icon={agent.icon} className="h-4 w-4 shrink-0" />
          }
          className={rail ? undefined : "pr-9"}
        />
        {!rail && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`${pinned ? "Unstar" : "Star"} ${agent.name}`}
            aria-pressed={pinned}
            title={pinned ? "Unstar agent" : "Star agent to pin"}
            onClick={(event) => {
              event.stopPropagation();
              onToggleStar(agent.id);
            }}
            className={cn("absolute right-2 top-(--pct-50) -translate-y-(--pct-50) text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/agent-chat:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100", pinned && "opacity-100")}
          >
            <Star
              aria-hidden="true"
              className={cn("size-3.5", pinned && "fill-current")}
            />
          </Button>
        )}
      </div>
    );
  };
  if (inline) {
    const newChatButton = (
      <button
        type="button"
        data-slot="icon-button"
        aria-label="Chat with an agent"
        onClick={onOpenChat}
        className="flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring"
      >
        <MessageSquarePlus aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>New chat</span>
      </button>
    );
    return (
      <section aria-label="Chats" className="flex flex-col gap-0.5">
        {ordered.map(row)}
        {rail ? (
          <Tooltip>
            <TooltipTrigger asChild>{newChatButton}</TooltipTrigger>
            <TooltipContent side="right">Chat with an agent</TooltipContent>
          </Tooltip>
        ) : (
          newChatButton
        )}
      </section>
    );
  }
  return (
    <section aria-label="Chats" className="group/chats flex flex-col gap-0.5">
      <div className="relative flex min-h-9 items-center px-4 py-1.5">
        <span className={cn("font-mono text-(length:--text-nano) font-medium uppercase tracking-widest text-subtle-foreground", rail && "sr-only")}>Chats</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Chat with an agent"
          title="Chat with an agent"
          onClick={onOpenChat}
          className="absolute right-2 top-(--pct-50) -translate-y-(--pct-50) text-muted-foreground opacity-0 group-hover/chats:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <SquarePen aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
      {ordered.map(row)}
    </section>
  );
}
