// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/lib/conversations";
import { SidebarChats } from "./SidebarChats";

const row = (key: string, name: string, extra: Partial<Conversation> = {}): Conversation => ({
  key, name, kind: key.startsWith("agent:") ? "agent" : "group", href: `/x/${name}`, issueId: null,
  lastMessageAt: null, lastMessagePreview: null, lastMessageFromMe: false, unreadCount: 0, muted: false,
  workingOn: 0, typing: false, ...extra,
});
const state = vi.hoisted(() => ({ rows: [] as Conversation[], pinned: [] as string[], unread: 0 }));

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    rows: state.rows,
    leadKey: "agent:everest",
    isPinned: (r: Conversation) => state.pinned.includes(r.key),
    unread: state.unread,
  }),
}));
vi.mock("@/components/SidebarNavItem", () => ({
  SidebarNavItem: ({ label, to, badge }: { label: string; to: string; badge?: number }) => (
    <a href={to} data-badge={badge ?? ""}>{label}</a>
  ),
}));

describe("SidebarChats", () => {
  let container: HTMLDivElement | null = null;
  afterEach(() => container?.remove());

  it("keeps only Everest and pinned conversations, then All messages with every unread", () => {
    state.rows = [
      row("agent:everest", "Everest", { unreadCount: 1 }),
      row("agent:mica", "Mica"),
      row("chat:ops", "Ops room", { unreadCount: 4 }),
      row("agent:flint", "Flint", { unreadCount: 2 }),
    ];
    state.pinned = ["chat:ops"];
    state.unread = 7;
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(<SidebarChats />));

    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => link.textContent)).toEqual(["Everest", "Ops room", "All messages"]);
    expect(links.map((link) => link.getAttribute("data-badge"))).toEqual(["1", "4", "7"]);
    expect(links.at(-1)?.getAttribute("href")).toBe("/messages");
    flushSync(() => root.unmount());
  });
});
