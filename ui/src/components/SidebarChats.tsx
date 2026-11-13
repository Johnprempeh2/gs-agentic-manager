import { MessagesSquare } from "lucide-react";
import { SidebarNavItem } from "@/components/SidebarNavItem";
import { useConversations } from "@/hooks/useConversations";
import type { Conversation } from "@/lib/conversations";
import { agentRouteRef } from "@/lib/utils";
import { ConversationAvatar } from "./ConversationList";

/** Which conversations the sidebar keeps: Everest, then the reader's pins. */
export function sidebarConversations(rows: readonly Conversation[], leadKey: string | null, isPinned: (row: Conversation) => boolean) {
  return rows.filter((row) => row.key === leadKey || isPinned(row));
}

/**
 * The sidebar's Chats: Everest and the conversations you pinned, then "All
 * messages" (the Messages hub, with every unread). Every other chat lives in
 * Messages, so the sidebar stays short.
 */
export function SidebarChats() {
  const { rows, leadKey, isPinned, unread } = useConversations();
  const shown = sidebarConversations(rows, leadKey, isPinned);
  return (
    <section aria-label="Chats" className="flex flex-col gap-0.5" data-tour="team-chats">
      {shown.map((row) => (
        <SidebarNavItem
          key={row.key}
          to={row.href}
          label={row.name}
          iconNode={<ConversationAvatar row={row} size={24} />}
          activeKey={row.agent ? [`chat:${row.agent.id}`, `chat:${agentRouteRef(row.agent)}`] : `chat:${row.issueId}`}
          badge={row.unreadCount > 0 && !row.muted ? row.unreadCount : undefined}
          badgeLabel="unread"
        />
      ))}
      <SidebarNavItem
        to="/messages"
        end
        label="All messages"
        icon={MessagesSquare}
        badge={unread > 0 ? unread : undefined}
        badgeLabel="unread"
        badgeTone="quiet"
        activeKey="item:messages"
        tourId="nav-messages"
      />
    </section>
  );
}
