import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AskEverestPanel } from "@/components/AskEverestPanel";
import { openAskEverest } from "@/lib/ask-everest-events";
import { storybookAgents, storybookIssues } from "../fixtures/paperclipData";

/**
 * Ask Everest from any screen (Ctrl/Cmd+J, the top bar or the command
 * palette). The instant answer is built from GSAM's data; Everest's own
 * reply shows underneath once it lands in the chat.
 */

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const agents = storybookAgents.map((agent) => {
  if (agent.id === "agent-cto") return { ...agent, name: "Everest", role: "ceo", urlKey: "everest" };
  if (agent.id === "agent-codex") return { ...agent, name: "Mason", urlKey: "mason" };
  return agent;
});

const indagoStuck = [
  {
    ...storybookIssues[1]!,
    id: "issue-indago-2",
    identifier: "GRE-1361",
    title: "Indago deep dive kick-off pack",
    status: "blocked",
    assigneeAgentId: "agent-codex",
    blockedBy: [{ id: "issue-fee", identifier: "GRE-1354", title: "Agree the Indago fee model", status: "in_review", priority: "high", assigneeAgentId: null, assigneeUserId: "user-board" }],
  },
  {
    ...storybookIssues[0]!,
    id: "issue-indago-4",
    identifier: "GRE-1372",
    title: "Indago data room access",
    status: "blocked",
    assigneeAgentId: "agent-qa",
    blockedBy: [],
  },
];

let askedAt: string | null = null;
const CHAT_ID = "11111111-1111-4111-8111-111111111111";

const responses: Array<[string, RegExp, (url: URL) => unknown]> = [
  ["GET", /\/api\/companies\/[^/]+\/agents$/, () => agents],
  ["GET", /\/api\/companies\/[^/]+\/issues$/, (url) => (url.searchParams.get("status") === "blocked" ? indagoStuck : [])],
  ["POST", /\/api\/companies\/[^/]+\/chats\/[^/]+$/, () => ({ ...storybookIssues[0]!, id: CHAT_ID })],
  ["POST", new RegExp(`/api/issues/${CHAT_ID}/comments$`), () => {
    askedAt = iso(0);
    return { id: "22222222-2222-4222-8222-222222222222", issueId: CHAT_ID, authorType: "user", authorUserId: "user-board", body: "", createdAt: askedAt };
  }],
  ["GET", new RegExp(`/api/issues/${CHAT_ID}/comments$`), () => (askedAt
    ? [{
      id: "33333333-3333-4333-8333-333333333333",
      issueId: CHAT_ID,
      authorType: "agent",
      authorAgentId: "agent-cto",
      body: "Both Indago tasks wait on one thing: **your call on the fee model** (GRE-1354). Once you pick fixed fee or day rate, Mason can send the kick-off pack the same day. Data room access is with QAChecker and needs a login from Indago, which I have chased.",
      createdAt: new Date(new Date(askedAt).getTime() + 1000).toISOString(),
    }]
    : [])],
];

function installAskFetch() {
  const marker = window as typeof window & { __askEverestStoryFetch?: boolean };
  if (marker.__askEverestStoryFetch) return;
  marker.__askEverestStoryFetch = true;
  const inner = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/api/instance/settings/experimental" && method === "GET") {
      const base = await (await inner(input, init)).json();
      return Response.json({ ...base, enableAgentChat: true });
    }
    for (const [verb, pattern, body] of responses) {
      if (verb === method && pattern.test(url.pathname)) return Response.json(body(url));
    }
    return inner(input, init);
  };
}

function OpenPanel({ question, askLive }: { question: string; askLive?: boolean }) {
  installAskFetch();
  useEffect(() => {
    const open = window.setTimeout(() => openAskEverest(question), 50);
    const live = askLive
      ? window.setInterval(() => {
        const button = document.querySelector<HTMLButtonElement>('[data-testid="ask-everest-live"]');
        if (button) {
          button.click();
          window.clearInterval(live);
        }
      }, 200)
      : undefined;
    return () => {
      window.clearTimeout(open);
      if (live) window.clearInterval(live);
    };
  }, [question, askLive]);
  return <AskEverestPanel />;
}

const meta: Meta<typeof OpenPanel> = {
  title: "Product/Ask Everest",
  component: OpenPanel,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof OpenPanel>;

export const StuckOnIndago: Story = { args: { question: "What is stuck on the Indago work?" } };

export const EverestReplies: Story = { args: { question: "What is stuck on the Indago work?", askLive: true } };
