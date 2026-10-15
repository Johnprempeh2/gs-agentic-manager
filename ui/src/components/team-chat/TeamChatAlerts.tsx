import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { issuesApi } from "@/api/issues";
import { teamChatsApi } from "@/api/teamChats";
import { useCompany } from "@/context/CompanyContext";
import { useCompanyLiveEvent } from "@/context/LiveUpdatesProvider";
import { useOptionalToastActions } from "@/context/ToastContext";
import { useTeamChatEnabled } from "@/hooks/useTeamChatEnabled";
import { getPageVisibility } from "@/lib/page-visibility";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import { buildTeamChatAlert, teamChatForLiveComment } from "@/lib/team-chats";

/** Desktop alerts work where the browser has the Notification API and the person allowed it. */
export function desktopAlertsPermission(): NotificationPermission | "unsupported" {
  return typeof window !== "undefined" && "Notification" in window ? window.Notification.permission : "unsupported";
}

/**
 * Alerts for new team chat messages (enableTeamChat). With the app in front, a
 * toast; with the tab in the background, a desktop notification (when allowed)
 * that opens the chat at the message. Nothing for the chat you are reading, your own messages,
 * or a muted chat unless you are @mentioned. Renders nothing.
 */
export function TeamChatAlerts() {
  const { selectedCompanyId } = useCompany();
  const { enabled } = useTeamChatEnabled();
  const toast = useOptionalToastActions();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? "local-board";
  const chats = useQuery({
    queryKey: queryKeys.teamChats.list(selectedCompanyId ?? ""),
    queryFn: () => teamChatsApi.list(selectedCompanyId!),
    enabled: enabled && !!selectedCompanyId,
  });

  useCompanyLiveEvent((event) => {
    if (!enabled || event.type !== "activity.logged") return;
    const hit = teamChatForLiveComment(event.payload, chats.data, userId);
    if (!hit) return;
    const page = getPageVisibility();
    const reading = location.pathname.endsWith(`/messages/${hit.chat.id}`);
    if (reading && page.visible) return;
    // The live event leaves the words out (it reaches the whole company); members fetch them.
    void issuesApi
      .getComment(hit.chat.id, hit.commentId)
      .then((comment) => {
        const alert = buildTeamChatAlert(hit.chat, comment, userId);
        if (!alert) return;
        // Open the chat at this message, which may not be the newest by the time it is clicked.
        const path = `/messages/${hit.chat.id}#comment-${hit.commentId}`;
        if (getPageVisibility().focused) {
          toast?.pushToast({
            title: alert.title,
            body: alert.body,
            tone: "info",
            action: { label: "Open chat", href: path },
            dedupeKey: `team-chat:${hit.commentId}`,
          });
          return;
        }
        if (desktopAlertsPermission() !== "granted") return;
        // Same tag as the phone push, so one chat shows one alert, not a pile.
        const note = new window.Notification(alert.title, { body: alert.body, tag: `chat:${hit.chat.id}` });
        note.onclick = () => {
          window.focus();
          navigate(path);
          note.close();
        };
      })
      .catch(() => {
        // The message was deleted or access changed; nothing to alert.
      });
  });

  return null;
}
