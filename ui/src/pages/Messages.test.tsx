// @vitest-environment jsdom
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/lib/conversations";
import { Messages } from "./Messages";

const state = vi.hoisted(() => ({ isMobile: true, crumbs: [] as unknown[], pathname: "/GRE/messages" }));
const everest: Conversation = {
  key: "agent:everest", kind: "agent", name: "Everest", href: "/chats/everest", agent: { id: "everest", name: "Everest" },
  issueId: "i1", lastMessageAt: "2026-11-13T09:00:00.000Z", lastMessagePreview: "Morning brief is ready",
  lastMessageFromMe: false, unreadCount: 2, muted: false, workingOn: 1, typing: false,
};
const ops: Conversation = {
  ...everest, key: "chat:ops", kind: "group", name: "Ops room", href: "/messages/ops", agent: undefined,
  lastMessagePreview: "Standup at ten", unreadCount: 0, workingOn: 0, typing: true,
};

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    rows: [everest, ops], agents: [], userId: "me", lead: { id: "everest" }, unread: 2,
    isPinned: () => false, error: null, refetch: vi.fn(), agentChatEnabled: true, teamChatEnabled: true,
  }),
}));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: state.isMobile }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: (c: unknown[]) => { state.crumbs = c; } }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: state.pathname }),
}));
vi.mock("@/components/AgentAvatar", () => ({ AgentAvatar: () => <span /> }));

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(<QueryClientProvider client={new QueryClient()}><Messages /></QueryClientProvider>));
  return { container, done: () => { flushSync(() => root.unmount()); container.remove(); } };
}

describe("Messages page", () => {
  afterEach(() => { state.isMobile = true; });

  it("on a phone is the conversation list: each row opens its thread full screen", () => {
    const { container, done } = render();
    expect(state.crumbs).toEqual([{ label: "Messages" }]);
    const rows = [...container.querySelectorAll<HTMLAnchorElement>("[data-testid='conversation-list'] li a")];
    expect(rows.map((row) => row.getAttribute("href"))).toEqual(["/chats/everest", "/messages/ops"]);
    expect(rows[0]!.textContent).toContain("Morning brief is ready");
    expect(rows[0]!.querySelector("[aria-label='2 unread']")).not.toBeNull();
    expect(rows[1]!.textContent).toContain("Typing");
    // The page bar already says Messages: no second heading in the list.
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector("[data-testid='new-message']")).not.toBeNull();
    done();
  });

  it("on desktop is the pick-a-conversation pane beside the list", () => {
    state.isMobile = false;
    const { container, done } = render();
    expect(container.querySelector("[data-testid='conversation-list']")).toBeNull();
    expect(container.textContent).toContain("Your messages");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/chats/everest");
    done();
  });
});
