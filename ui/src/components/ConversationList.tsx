import type { ReactNode } from "react";
import { BellOff, Pin, Search, Users } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { deriveInitials } from "@/components/Identity";
import { Input } from "@/components/ui/input";
import { formatConversationTime, matchesConversation, type Conversation } from "@/lib/conversations";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

/** Three bouncing dots: someone is replying. Still under reduced motion. */
export function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cn("gs-typing", className)} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

/** A conversation's face: the agent's avatar, a person's initials, or a group mark. */
const AVATAR = { 24: { box: "size-6 text-(length:--text-nano)", inner: 20 }, 32: { box: "size-8 text-xs", inner: 24 }, 40: { box: "size-10 text-xs", inner: 32 } } as const;

export function ConversationAvatar({ row, size = 40 }: { row: Pick<Conversation, "kind" | "name" | "agent">; size?: 24 | 32 | 40 }) {
  const { box, inner } = AVATAR[size];
  return (
    <span className={cn("gs-convo-avatar flex shrink-0 items-center justify-center rounded-full font-semibold text-foreground", box)}>
      {row.kind === "agent" ? (
        <AgentAvatar agent={row.agent} name={row.name} size={inner} />
      ) : row.kind === "group" ? (
        <Users aria-hidden="true" className="size-1/2" />
      ) : (
        deriveInitials(row.name)
      )}
    </span>
  );
}

function preview(row: Conversation): string {
  if (row.lastMessagePreview) return `${row.lastMessageFromMe ? "You: " : ""}${row.lastMessagePreview}`;
  return row.kind === "agent" ? `Say hello to ${row.name}` : "No messages yet";
}

export interface ConversationListProps {
  rows: readonly Conversation[];
  activeKey?: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  isPinned?: (row: Conversation) => boolean;
  /** The "New message" control, floated at the bottom of the list. */
  newMessage?: ReactNode;
  /** Shown above the rows (a load error with a retry). */
  notice?: ReactNode;
  onOpen?: (row: Conversation) => void;
  className?: string;
}

/**
 * The left pane of Messages, like every messenger: search on top, then one
 * row per conversation (avatar, name, time, a one-line preview, unread count),
 * and a floating New message button. Ordering is the caller's
 * (lib/conversations orderConversations); search filters names and previews.
 */
export function ConversationList({
  rows,
  activeKey,
  query,
  onQueryChange,
  isPinned,
  newMessage,
  notice,
  onOpen,
  className,
}: ConversationListProps) {
  const shown = rows.filter((row) => matchesConversation(row, query));
  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)} data-testid="conversation-list">
      <div className="px-3 pb-2 pt-1">
        <label className="relative block">
          <span className="sr-only">Search messages</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search names and messages"
            className="h-10 rounded-full pl-9"
          />
        </label>
      </div>
      {notice}
      <ul aria-label="Conversations" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-24">
        {shown.length === 0 ? (
          <li className="px-3 py-8 text-center text-sm text-muted-foreground">
            {query.trim() ? "No conversations match." : "No conversations yet. Start one below."}
          </li>
        ) : null}
        {shown.map((row) => {
          const active = row.key === activeKey;
          const unread = row.unreadCount > 0 && !active;
          const pinned = isPinned?.(row) ?? false;
          const time = row.lastMessageAt ? formatConversationTime(row.lastMessageAt) : null;
          return (
            <li key={row.key}>
              <Link
                to={row.href}
                onClick={() => onOpen?.(row)}
                aria-current={active ? "page" : undefined}
                data-conversation={row.key}
                data-selected={active ? "true" : undefined}
                className={cn(
                  "gs-row relative flex min-h-16 items-center gap-3 rounded-xl px-3 py-2 outline-none transition-colors hover:bg-accent focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
                  active && "bg-accent",
                )}
              >
                <span className="relative shrink-0">
                  <ConversationAvatar row={row} />
                  {row.typing || row.workingOn > 0 ? (
                    <span
                      aria-hidden="true"
                      data-testid="conversation-live-dot"
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-background",
                        row.typing ? "animate-pulse bg-status-running" : "bg-status-success",
                      )}
                    />
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-baseline gap-2">
                    <span className={cn("min-w-0 flex-1 truncate text-sm text-foreground", unread ? "font-bold" : "font-semibold")}>{row.name}</span>
                    {time ? (
                      <time dateTime={row.lastMessageAt!} className={cn("shrink-0 text-xs", unread ? "font-semibold text-foreground" : "text-muted-foreground")}>
                        {time}
                      </time>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    {row.typing ? (
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-foreground">
                        <TypingDots />
                        <span className="truncate">Typing</span>
                      </span>
                    ) : (
                      <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-medium text-foreground" : "text-muted-foreground")}>
                        {preview(row)}
                      </span>
                    )}
                    {row.muted ? <BellOff aria-label="Muted" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                    {pinned ? <Pin aria-label="Pinned" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                    {unread ? (
                      <span
                        className="min-w-5 shrink-0 rounded-full bg-primary px-1.5 text-center text-xs font-bold leading-5 text-primary-foreground"
                        aria-label={`${row.unreadCount} unread`}
                      >
                        {row.unreadCount > 99 ? "99+" : row.unreadCount}
                      </span>
                    ) : null}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {newMessage ? <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end p-4 max-md:fixed max-md:bottom-(--mobile-nav-content-inset) [&>*]:pointer-events-auto">{newMessage}</div> : null}
    </div>
  );
}
