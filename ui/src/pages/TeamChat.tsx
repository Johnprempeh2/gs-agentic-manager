import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Bot, User, UserPlus, X } from "lucide-react";
import type { IssueComment, TeamChatSummary } from "@greatstone/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { issuesApi } from "@/api/issues";
import { teamChatsApi } from "@/api/teamChats";
import { FeatureTour } from "@/components/FeatureTour";
import { NewTeamChatDialog, type NewTeamChatInput } from "@/components/NewTeamChatDialog";
import { desktopAlertsPermission } from "@/components/team-chat/TeamChatAlerts";
import { scrollTeamChatToLatest, TeamChatThread } from "@/components/team-chat/TeamChatThread";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useConfirm } from "@/context/ConfirmContext";
import { useToastActions } from "@/context/ToastContext";
import { ErrorState } from "@/components/ErrorState";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useTeamChatEnabled } from "@/hooks/useTeamChatEnabled";
import { buildCompanyUserLabelMap, isAgentTaskTarget } from "@/lib/company-members";
import { TEAM_CHAT_TOUR } from "@/lib/feature-tours";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "@/lib/instance-settings";
import { usePageVisibility } from "@/lib/page-visibility";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useParams } from "@/lib/router";
import { teamChatLabel, teamChatMentionOptions } from "@/lib/team-chats";

const THREAD_LIMIT = 200;
const ALERTS_ASKED_KEY = "team-chat-desktop-alerts-asked";

/** One direct message or group chat (enableTeamChat). Messages are the chat issue's comments. */
export function TeamChat() {
  const { chatId = "" } = useParams<{ chatId: string }>();
  const { selectedCompanyId } = useCompany();
  const { enabled, loaded } = useTeamChatEnabled();
  const { setBreadcrumbs } = useBreadcrumbs();
  const client = useQueryClient();
  const confirm = useConfirm();
  const { pushToast } = useToastActions();
  const [adding, setAdding] = useState(false);
  const [alertsPermission, setAlertsPermission] = useState(desktopAlertsPermission);
  const [alertsAsked, setAlertsAsked] = useState(() => localStorage.getItem(ALERTS_ASKED_KEY) === "1");
  const { visible } = usePageVisibility();
  const push = usePushNotifications(selectedCompanyId);
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? "local-board";
  const chat = useQuery({
    queryKey: queryKeys.teamChats.detail(chatId),
    queryFn: () => teamChatsApi.get(chatId),
    enabled: !!chatId,
  });
  const commentsKey = [...queryKeys.issues.comments(chatId), "team-chat"] as const;
  const comments = useQuery({
    queryKey: commentsKey,
    queryFn: async () => (await issuesApi.listComments(chatId, { order: "desc", limit: THREAD_LIMIT })).reverse(),
    enabled: !!chat.data,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const directory = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId ?? ""),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId && adding,
  });

  const summary = chat.data;
  const label = summary ? teamChatLabel(summary, userId) : "Chat";
  useEffect(() => {
    setBreadcrumbs([{ label: "Chats" }, { label }]);
  }, [label, setBreadcrumbs]);

  // Reading the chat clears its unread count; a chat left open in a hidden tab is not being read.
  const lastCommentId = comments.data?.at(-1)?.id;
  useEffect(() => {
    if (!summary || !lastCommentId || !visible) return;
    void issuesApi.markRead(summary.id).then(() => client.invalidateQueries({ queryKey: queryKeys.teamChats.all }));
  }, [summary?.id, lastCommentId, visible, client]);

  const agentMap = useMemo(() => new Map((agents.data ?? []).map((agent) => [agent.id, agent])), [agents.data]);
  const names = useMemo(() => new Map((summary?.members ?? []).map((member) => [member.id, member.name])), [summary?.members]);
  const senderName = useCallback(
    (comment: IssueComment) =>
      comment.authorAgentId
        ? names.get(comment.authorAgentId) ?? agentMap.get(comment.authorAgentId)?.name ?? "Agent"
        : comment.authorType === "system" && !comment.authorUserId
          ? "System"
          : comment.authorUserId === userId
            ? "You"
            : names.get(comment.authorUserId ?? "") ?? "Former member",
    [agentMap, names, userId],
  );
  const mentions = useMemo(() => teamChatMentionOptions(summary?.members ?? [], userId), [summary?.members, userId]);

  const updateSummary = (next: TeamChatSummary) => {
    client.setQueryData(queryKeys.teamChats.detail(next.id), next);
    void client.invalidateQueries({ queryKey: queryKeys.teamChats.all });
  };
  const closeAlertsPrompt = () => {
    localStorage.setItem(ALERTS_ASKED_KEY, "1");
    setAlertsAsked(true);
  };
  // Web Push reaches a hidden or closed tab; without it, alerts show only while the app is open.
  const turnOnAlerts = async () => {
    if (push.state === "off") await push.enable();
    else await window.Notification.requestPermission();
    setAlertsPermission(desktopAlertsPermission());
    closeAlertsPrompt();
  };

  if (!loaded || chat.isPending) return <p className="text-sm text-muted-foreground">Loading chat…</p>;
  if (!enabled && !summary) {
    return (
      <p className="text-sm text-muted-foreground">
        Team Chat is off. Turn it on in{" "}
        <Link to={`${INSTANCE_SETTINGS_PATH_PREFIX}/experimental`} className="font-medium text-foreground underline underline-offset-4">
          Experimental settings
        </Link>
        .
      </p>
    );
  }
  if (chat.error) return <ErrorState error={chat.error} title="We could not open this chat" onRetry={() => void chat.refetch()} />;
  if (!summary) return <p className="text-sm text-muted-foreground">This chat no longer exists, or you are not a member of it.</p>;

  const group = summary.kind === "group";
  const memberIds = new Set(summary.members.map((member) => `${member.type}:${member.id}`));
  const labels = buildCompanyUserLabelMap(directory.data?.users);
  const people = (directory.data?.users ?? [])
    .filter((entry) => entry.status === "active" && !memberIds.has(`user:${entry.principalId}`))
    .map((entry) => ({ id: entry.principalId, name: labels.get(entry.principalId) ?? entry.principalId }));
  const addableAgents = (agents.data ?? [])
    .filter((agent) => isAgentTaskTarget(agent) && !memberIds.has(`agent:${agent.id}`))
    .map((agent) => ({ id: agent.id, name: agent.name }));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {/* Desktop: the header also covers the page's top padding so messages never show above it. */}
      <header className="sticky top-0 z-sticky -mx-4 -mt-2 flex flex-col gap-2 border-b border-border bg-background px-4 pb-3 pt-2 md:-mx-1 md:px-1 md:-top-6 md:-mt-6 md:pt-6">
        <div className="flex items-center justify-between gap-2">
          <h1 className="min-w-0 truncate text-xl font-bold">{label}</h1>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={summary.muted}
              title={summary.muted ? "Muted: you hear only @mentions" : "Mute: alert only when you are @mentioned"}
              className="gap-1.5 text-muted-foreground"
              onClick={() =>
                void teamChatsApi.setMuted(summary.id, !summary.muted).then(updateSummary).catch(() =>
                  pushToast({ title: summary.muted ? "Could not turn alerts back on" : "Could not mute this chat", body: "Try again in a moment.", tone: "error" }),
                )
              }
            >
              {summary.muted ? <BellOff aria-hidden="true" className="size-4" /> : <Bell aria-hidden="true" className="size-4" />}
              {summary.muted ? "Muted" : "Mute"}
            </Button>
            <FeatureTour tour={TEAM_CHAT_TOUR} onClose={scrollTeamChatToLatest} />
          </div>
        </div>
        <ul aria-label="Members" data-tour="team-chat-members" className="flex flex-wrap items-center gap-1.5">
          {summary.members.map((member) => (
            <li
              key={`${member.type}:${member.id}`}
              className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
            >
              {member.type === "agent" ? <Bot aria-hidden="true" className="size-3" /> : <User aria-hidden="true" className="size-3" />}
              <span>{member.id === userId ? "You" : member.name}</span>
              {group && member.id !== userId && (
                <button
                  type="button"
                  aria-label={`Remove ${member.name}`}
                  className="-mr-1 rounded-full p-0.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring"
                  onClick={async () => {
                    const confirmed = await confirm({
                      title: `Remove ${member.name} from this chat?`,
                      description: "They stop seeing new messages here. You can add them back later.",
                      confirmLabel: "Remove",
                      tone: "destructive",
                    });
                    if (!confirmed) return;
                    void teamChatsApi.removeMember(summary.id, member.type, member.id).then(updateSummary).catch(() =>
                      pushToast({ title: `Could not remove ${member.name}`, body: "Try again in a moment.", tone: "error" }),
                    );
                  }}
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              )}
            </li>
          ))}
          {group && (
            <li>
              <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={() => setAdding(true)}>
                <UserPlus aria-hidden="true" className="size-3" />
                Add
              </Button>
            </li>
          )}
        </ul>
        {group && <p className="text-xs text-muted-foreground">Agents here reply only when you @mention them.</p>}
        {alertsPermission === "default" && !alertsAsked && (
          <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Bell aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {summary.muted ? "Alert me here when @mentioned" : "Alert me here for new messages"}
            </span>
            <Button type="button" variant="outline" size="sm" className="ml-auto h-6 shrink-0 px-2 text-xs" onClick={() => void turnOnAlerts()}>
              Turn on
            </Button>
            <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label="Not now" title="Not now" onClick={closeAlertsPrompt}>
              <X aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        )}
      </header>
      {comments.error ? (
        <ErrorState
          error={comments.error}
          title="Messages did not load"
          onRetry={() => void comments.refetch()}
          retrying={comments.isFetching}
          compact
        />
      ) : null}
      <div data-tour="team-chat-thread">
        <TeamChatThread
          comments={comments.data ?? []}
          currentUserId={userId}
          agentMap={agentMap}
          senderName={senderName}
          companyId={selectedCompanyId}
          mentions={mentions}
          draftKey={`team-chat-draft:${summary.id}`}
          composerDisabledReason={enabled ? null : "Team Chat is off, so new messages cannot be sent."}
          imageUploadHandler={
            selectedCompanyId
              ? async (file) => (await issuesApi.uploadAttachment(selectedCompanyId, summary.id, file)).contentPath
              : undefined
          }
          onSend={async (body) => {
            await issuesApi.addComment(summary.id, body);
            await client.invalidateQueries({ queryKey: queryKeys.issues.comments(summary.id) });
          }}
        />
      </div>
      <NewTeamChatDialog
        mode="add"
        open={adding}
        onOpenChange={setAdding}
        people={people}
        agents={addableAgents}
        onSubmit={async (input: NewTeamChatInput) => {
          if (input.mode !== "add") return;
          updateSummary(await teamChatsApi.addMembers(summary.id, { userIds: input.userIds, agentIds: input.agentIds }));
        }}
      />
    </div>
  );
}
