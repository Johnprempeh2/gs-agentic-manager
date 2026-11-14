import { useEffect } from "react";
import { MessageCircle } from "lucide-react";
import { MessagesPane } from "@/components/MessagesPane";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useSidebar } from "@/context/SidebarContext";
import { useConversations } from "@/hooks/useConversations";
import { Link } from "@/lib/router";

/**
 * /messages. Phones: the conversation list, WhatsApp style (a thread opens
 * full screen and its back arrow returns here). Desktop: the list sits beside
 * this pane (Layout), so this is the "pick a conversation" state; when the hub
 * is too narrow for two panes, the list shows here instead (gs-hub-* in
 * greatstone-glass.css).
 */
export function Messages() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { isMobile } = useSidebar();
  const { rows, lead } = useConversations();
  useEffect(() => setBreadcrumbs([{ label: "Messages" }]), [setBreadcrumbs]);
  if (isMobile) return <MessagesPane heading={false} className="-mx-4 -mt-2 flex flex-col" />;
  const everest = lead ? rows.find((row) => row.agent?.id === lead.id) : null;
  return (
    <>
    <MessagesPane heading={false} className="gs-hub-inline-list mx-auto h-full w-full max-w-xl flex-col" />
    <div className="gs-hub-empty h-full flex-col items-center justify-center gap-3 text-center">
      <span className="gs-convo-avatar flex size-14 items-center justify-center rounded-full">
        <MessageCircle aria-hidden="true" className="size-6 text-foreground" />
      </span>
      <h1 className="text-xl font-bold">Your messages</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Pick a conversation on the left, or start a new one with an agent, a person or a group.
      </p>
      {everest ? (
        <Link to={everest.href} className="text-sm font-semibold text-foreground underline underline-offset-4">
          Open {everest.name}
        </Link>
      ) : null}
    </div>
    </>
  );
}
