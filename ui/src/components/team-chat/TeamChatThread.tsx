import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useLocation } from "react-router-dom";
import { ArrowDown, Bot, Loader2, PaperclipIcon, SendHorizontal } from "lucide-react";
import type { Agent, IssueComment } from "@greatstone/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { deriveInitials } from "@/components/Identity";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "@/components/MarkdownEditor";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/context/SidebarContext";
import { restoreSubmittedCommentDraft } from "@/lib/comment-submit-draft";
import { Link } from "@/lib/router";
import {
  buildTeamChatRows,
  formatTeamChatDay,
  formatTeamChatTime,
  type TeamChatSender,
} from "@/lib/team-chat-messages";
import { cn, formatDateTime } from "@/lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";

const DRAFT_DEBOUNCE_MS = 800;
/** Within this distance of the end, a reader counts as "at the newest message" and new replies are followed. */
const NEAR_BOTTOM_PX = 120;
const END_ID = "team-chat-end";

/** Desktop scrolls inside <main>; phones scroll the page. */
function chatScroller(): HTMLElement | null {
  const main = document.getElementById("main-content");
  if (main && main.scrollHeight > main.clientHeight) return main;
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

function isNearBottom() {
  const scroller = chatScroller();
  return !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM_PX;
}

/** Jump to the newest message. Desktop goes to the very end of <main> so the sticky composer clears the last message. */
export function scrollTeamChatToLatest() {
  const main = document.getElementById("main-content");
  if (main && main.scrollHeight > main.clientHeight) main.scrollTop = main.scrollHeight;
  else document.getElementById(END_ID)?.scrollIntoView?.({ block: "end" });
}

function readDraft(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, value: string) {
  try {
    if (value.trim()) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Ignore localStorage failures.
  }
}

export interface TeamChatThreadProps {
  comments: IssueComment[];
  currentUserId: string | null;
  agentMap?: Map<string, Agent>;
  /** Display name for a message's sender (members first, then "Former member"). */
  senderName: (comment: IssueComment) => string;
  companyId?: string | null;
  mentions?: MentionOption[];
  draftKey?: string;
  composerDisabledReason?: string | null;
  imageUploadHandler?: (file: File) => Promise<string>;
  onSend: (body: string) => Promise<void>;
}

/**
 * Messenger-style thread for a team chat: own messages on the right, others on
 * the left with avatar and name, runs from one sender grouped, a date line at
 * each new day, and a composer pinned to the bottom (Enter sends).
 */
export function TeamChatThread({
  comments,
  currentUserId,
  agentMap,
  senderName,
  companyId,
  mentions,
  draftKey,
  composerDisabledReason = null,
  imageUploadHandler,
  onSend,
}: TeamChatThreadProps) {
  const rows = useMemo(() => buildTeamChatRows(comments, currentUserId), [comments, currentUserId]);
  const { isMobile } = useSidebar();
  const location = useLocation();
  const last = comments.at(-1);
  const lastId = last?.id;
  const lastIsOwn = Boolean(last && !last.authorAgentId && last.authorUserId === currentUserId);
  const chatId = comments[0]?.issueId ?? null;
  const highlightId = location.hash.startsWith("#comment-") ? location.hash.slice("#comment-".length) : null;
  const openedChatRef = useRef<string | null>(null);
  const shownHighlightRef = useRef<string | null>(null);
  const nearBottomRef = useRef(true);
  const [nearBottom, setNearBottom] = useState(true);
  const [hasUnseen, setHasUnseen] = useState(false);

  // Remember whether the reader is at the newest message, measured before new messages make the page taller.
  useEffect(() => {
    const onScroll = () => {
      const near = isNearBottom();
      nearBottomRef.current = near;
      setNearBottom(near);
      if (near) setHasUnseen(false);
    };
    const main = document.getElementById("main-content");
    main?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      main?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Open at the newest message (or the one a link points at). After that, follow new
  // replies only for a reader already at the end, or after they send one themselves.
  // A link to a message (an alert, a search hit) also lands there when the chat is already open.
  useEffect(() => {
    if (!lastId) return;
    const firstOpen = openedChatRef.current !== chatId;
    openedChatRef.current = chatId;
    const linkTarget = highlightId && shownHighlightRef.current !== highlightId
      ? document.getElementById(`comment-${highlightId}`)
      : null;
    if (linkTarget) {
      shownHighlightRef.current = highlightId;
      linkTarget.scrollIntoView?.({ block: "center" });
      return;
    }
    if (firstOpen || lastIsOwn || nearBottomRef.current) {
      scrollTeamChatToLatest();
      setHasUnseen(false);
    } else {
      setHasUnseen(true);
    }
  }, [lastId, lastIsOwn, chatId, highlightId]);

  const jumpToLatest = () => {
    scrollTeamChatToLatest();
    setHasUnseen(false);
  };

  return (
    <div className="flex flex-col">
      <ol aria-label="Messages" className="flex flex-col gap-3 pb-4">
        {rows.length === 0 ? (
          <li className="py-10 text-center text-sm text-muted-foreground">No messages yet. Say hello.</li>
        ) : null}
        {rows.map((row) =>
          row.kind === "date" ? (
            <li key={row.key} role="separator" className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              <span className="rounded-full bg-muted px-2.5 py-0.5 font-medium">{formatTeamChatDay(row.date)}</span>
              <span className="h-px flex-1 bg-border" />
            </li>
          ) : (
            <MessageGroup
              key={row.key}
              sender={row.sender}
              messages={row.messages}
              name={senderName(row.messages[0]!)}
              agent={row.sender.agentId ? agentMap?.get(row.sender.agentId) : undefined}
              companyId={companyId}
              highlightId={highlightId}
            />
          ),
        )}
      </ol>
      <div
        data-testid="team-chat-composer-dock"
        className={cn(
          "sticky z-sticky -mx-4 border-t border-border bg-background px-4 pt-3 md:-mx-1 md:px-1",
          // Desktop: cover the page's bottom padding so messages never show below the composer.
          isMobile
            ? "tc-composer-dock-bottom pb-1"
            : "-bottom-6 -mb-6 pb-6",
        )}
      >
        {!nearBottom || hasUnseen ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={jumpToLatest}
            className="absolute bottom-full left-1/2 mb-3 -translate-x-1/2 rounded-full border border-border shadow-md"
          >
            <ArrowDown className="size-4" aria-hidden="true" />
            {hasUnseen ? "New messages" : "Jump to latest"}
          </Button>
        ) : null}
        {composerDisabledReason ? (
          <div className="rounded-md border border-status-warning/40 bg-status-warning-soft px-3 py-2 text-sm text-status-warning-foreground">
            {composerDisabledReason}
          </div>
        ) : (
          <TeamChatComposer
            mentions={mentions}
            draftKey={draftKey}
            imageUploadHandler={imageUploadHandler}
            onSend={onSend}
          />
        )}
      </div>
      <div id={END_ID} />
    </div>
  );
}

function SenderAvatar({ sender, name, agent }: { sender: TeamChatSender; name: string; agent?: Agent }) {
  if (sender.kind === "agent") {
    return (
      <AgentAvatar
        agent={agent ?? { id: sender.agentId ?? undefined, name }}
        name={name}
        size={32}
        className="rounded-full bg-accent"
      />
    );
  }
  return (
    <Avatar size="default" aria-hidden="true">
      <AvatarFallback className="bg-secondary text-xs font-medium text-secondary-foreground">{deriveInitials(name)}</AvatarFallback>
    </Avatar>
  );
}

function MessageGroup({
  sender,
  messages,
  name,
  agent,
  companyId,
  highlightId,
}: {
  sender: TeamChatSender;
  messages: IssueComment[];
  name: string;
  agent?: Agent;
  companyId?: string | null;
  highlightId: string | null;
}) {
  if (sender.kind === "system") {
    return (
      <li className="flex justify-center">
        {messages.map((message) => (
          <div
            key={message.id}
            id={`comment-${message.id}`}
            className="max-w-(--pct-85) rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground"
          >
            <MarkdownBody className="text-xs" softBreaks>{message.body}</MarkdownBody>
          </div>
        ))}
      </li>
    );
  }

  const own = sender.kind === "self";
  return (
    <li
      data-testid="team-chat-group"
      data-sender={own ? "self" : sender.kind}
      className={cn("flex items-start gap-2", own ? "justify-end" : "justify-start")}
    >
      {!own ? (
        <div className="mt-5 shrink-0">
          <SenderAvatar sender={sender} name={name} agent={agent} />
        </div>
      ) : null}
      <div className={cn("flex min-w-0 max-w-(--pct-85) flex-col gap-0.5", own ? "items-end" : "items-start")}>
        {!own ? (
          <div className="flex items-center gap-1.5 px-1 text-xs">
            {sender.kind === "agent" && sender.agentId ? (
              <Link to={`/agents/${sender.agentId}`} className="font-medium text-foreground hover:underline">
                {name}
              </Link>
            ) : (
              <span className="font-medium text-foreground">{name}</span>
            )}
            {sender.kind === "agent" ? (
              <Badge variant="secondary" className="gap-0.5 px-1.5 py-0">
                <Bot aria-hidden="true" />
                Agent
              </Badge>
            ) : null}
          </div>
        ) : null}
        {messages.map((message, index) => (
          <MessageBubble
            key={message.id}
            message={message}
            own={own}
            first={index === 0}
            companyId={companyId}
            highlighted={highlightId === message.id}
          />
        ))}
      </div>
    </li>
  );
}

function MessageBubble({
  message,
  own,
  first,
  companyId,
  highlighted,
}: {
  message: IssueComment;
  own: boolean;
  first: boolean;
  companyId?: string | null;
  highlighted: boolean;
}) {
  const deleted = Boolean(message.deletedAt);
  const createdAt = new Date(message.createdAt);
  return (
    <div
      id={`comment-${message.id}`}
      data-testid="team-chat-message"
      className={cn(
        "group/message min-w-0 max-w-full break-words rounded-2xl px-3.5 py-2 text-sm",
        own ? "gs-human-bubble" : "bg-muted text-foreground",
        first && (own ? "rounded-tr-sm" : "rounded-tl-sm"),
        deleted && "bg-muted/50 italic text-muted-foreground",
        highlighted && "ring-2 ring-ring",
      )}
    >
      {deleted ? (
        <span>Message deleted</span>
      ) : (
        <MarkdownBody className={cn("text-sm", own && "paperclip-markdown-on-accent")} softBreaks linkIssueReferences>
          {message.body}
        </MarkdownBody>
      )}
      {companyId && !deleted ? (
        <PluginSlotOutlet
          slotTypes={["commentAnnotation"]}
          entityType="comment"
          context={{ companyId, projectId: null, entityId: message.id, entityType: "comment", parentEntityId: message.issueId }}
          className="mt-2 space-y-2"
          itemClassName="rounded-md"
          missingBehavior="placeholder"
        />
      ) : null}
      <div className={cn("mt-0.5 flex items-center justify-end gap-2 text-(length:--text-nano)", own ? "opacity-75" : "text-muted-foreground")}>
        {message.createdByRunId && message.authorAgentId ? (
          <Link
            to={`/agents/${message.authorAgentId}/runs/${message.createdByRunId}`}
            className="opacity-0 transition-opacity hover:underline focus-visible:opacity-100 group-hover/message:opacity-100"
          >
            See the work
          </Link>
        ) : null}
        <time dateTime={createdAt.toISOString()} title={formatDateTime(message.createdAt)}>
          {formatTeamChatTime(createdAt)}
        </time>
      </div>
    </div>
  );
}

function TeamChatComposer({
  mentions,
  draftKey,
  imageUploadHandler,
  onSend,
}: {
  mentions?: MentionOption[];
  draftKey?: string;
  imageUploadHandler?: (file: File) => Promise<string>;
  onSend: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (draftKey) setBody(readDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => writeDraft(draftKey, body), DRAFT_DEBOUNCE_MS);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [body, draftKey]);

  async function send() {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setBody("");
    try {
      await onSend(trimmed);
      if (draftKey) writeDraft(draftKey, "");
    } catch {
      // The page surfaces the failure; put the text back so it can be retried.
      setBody((current) => restoreSubmittedCommentDraft({ currentBody: current, submittedBody: trimmed }));
    } finally {
      setSending(false);
      editorRef.current?.focus();
    }
  }

  async function attach(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !imageUploadHandler) return;
    setAttaching(true);
    try {
      const url = await imageUploadHandler(file);
      const markdown = `![${file.name.replace(/[[\]]/g, "\\$&")}](${url})`;
      setBody((prev) => (prev ? `${prev}\n\n${markdown}` : markdown));
    } finally {
      setAttaching(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="flex items-end gap-2">
      {imageUploadHandler ? (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={attach}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0 rounded-full"
            aria-label="Attach image"
            disabled={attaching}
            onClick={() => fileRef.current?.click()}
          >
            {attaching ? <Loader2 className="size-4 animate-spin" /> : <PaperclipIcon className="size-4" />}
          </Button>
        </>
      ) : null}
      <MarkdownEditor
        ref={editorRef}
        value={body}
        onChange={setBody}
        placeholder="Message"
        mentions={mentions}
        onSubmit={() => void send()}
        submitOnEnter
        imageUploadHandler={imageUploadHandler}
        className="min-w-0 flex-1 rounded-2xl bg-card"
        contentClassName="max-h-(--sz-12rem) overflow-y-auto px-3 py-2 text-sm"
      />
      <Button
        type="button"
        size="icon"
        className="shrink-0 rounded-full"
        aria-label="Send message"
        disabled={!body.trim() || sending}
        onClick={() => void send()}
      >
        {sending ? <Loader2 className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />}
      </Button>
    </div>
  );
}
