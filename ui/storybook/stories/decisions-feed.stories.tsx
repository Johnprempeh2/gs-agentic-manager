import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { DecisionCard } from "@greatstone/shared";
import { WhatNeedsMe } from "@/pages/WhatNeedsMe";
import { DecisionFeedCard } from "@/components/decisions-feed/DecisionFeedCard";
import { TabledBanner } from "@/components/decisions-feed/TabledBanner";
import { queryKeys } from "@/lib/queryKeys";
import { DECISIONS_VIEW_KEY } from "@/lib/focus-prefs";
import { focusSessionKey } from "@/lib/focus-queue";
import {
  approvalCard,
  atDeskCard,
  blockedCard,
  connectionAlertCard,
  failedRunCard,
  fixtureAgents,
  fixtureFeed,
  humanReviewCard,
  mergedCard,
  questionCard,
  reviewCard,
  setupCard,
  tabledIssue,
} from "@/fixtures/decisionsFeedFixtures";
import { storybookAgents } from "../fixtures/paperclipData";

/**
 * Decisions after GRE-264: one feed, one card per task, actions in place, Ask
 * for clarity, Not now and Tabled. Before/after screenshots for John come from
 * these stories in light and dark mode.
 */
const COMPANY_ID = "company-storybook";

const CARDS: DecisionCard[] = [
  connectionAlertCard(),
  mergedCard(),
  blockedCard(),
  failedRunCard(),
  questionCard("int-1", "issue-44", "GRE-44"),
  approvalCard(),
  reviewCard(),
];

const TABLED = [
  tabledIssue("issue-5", "GRE-5", "Renew the company domain", "2026-10-12T07:00:00.000Z"),
  tabledIssue("issue-6", "GRE-6", "Tidy the shared drive", null),
];

const QUESTION = {
  id: "int-1",
  companyId: COMPANY_ID,
  issueId: "issue-44",
  kind: "ask_user_questions",
  status: "pending",
  title: null,
  summary: "Two runs stopped last night. A restart is safe for most tasks.",
  createdByAgentId: "agent-ridge",
  createdAt: "2026-09-29T21:00:00.000Z",
  updatedAt: "2026-09-29T21:00:00.000Z",
  payload: {
    version: 1,
    questions: [
      {
        id: "q1",
        prompt: "When a run is stuck, should I restart it?",
        selectionMode: "single",
        options: [
          { id: "own", label: "Restart on its own" },
          { id: "except", label: "Restart, except email and code tasks" },
          { id: "ask", label: "Always ask me first" },
        ],
      },
    ],
  },
};

/** The WSL ask as a plain confirmation: what the card showed before GRE-450. */
const DESK_CONFIRMATION = {
  id: "int-wsl",
  companyId: COMPANY_ID,
  issueId: "issue-407",
  kind: "request_confirmation",
  status: "pending",
  title: null,
  summary: null,
  createdByAgentId: "agent-ridge",
  createdAt: "2026-09-29T21:00:00.000Z",
  updatedAt: "2026-09-29T21:00:00.000Z",
  payload: { version: 1, prompt: "WSL is stuck. Restart it on the host (wsl --shutdown), then accept.", atDesk: { command: "wsl --shutdown" } },
};

function Seeded({ children, view, cards = CARDS }: { children: ReactNode; view: "list" | "focus"; cards?: DecisionCard[] }) {
  const queryClient = useQueryClient();
  useState(() => {
    try {
      localStorage.setItem(DECISIONS_VIEW_KEY, view);
      sessionStorage.removeItem(focusSessionKey(COMPANY_ID));
    } catch {
      // Storybook without storage still renders the list.
    }
    queryClient.setQueryData(queryKeys.decisionsFeed.feed(COMPANY_ID), fixtureFeed(cards));
    queryClient.setQueryData(queryKeys.tabledIssues(COMPANY_ID), TABLED);
    queryClient.setQueryData([...queryKeys.attention(COMPANY_ID), "with-dismissed"], {
      companyId: COMPANY_ID,
      generatedAt: "2026-09-29T22:00:00.000Z",
      items: [],
    });
    queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), storybookAgents);
    queryClient.setQueryData(queryKeys.issues.interactions("issue-44"), [QUESTION]);
    queryClient.setQueryData(queryKeys.issues.interactions("issue-407"), [DESK_CONFIRMATION]);
    queryClient.setQueryData(queryKeys.decisionQueues.list(COMPANY_ID), []);
    return true;
  });
  return <>{children}</>;
}

const meta = {
  title: "Pages/Decisions feed (GRE-264)",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = {
  render: () => (
    <Seeded view="list">
      <WhatNeedsMe />
    </Seeded>
  ),
};

export const Focus: Story = {
  render: () => (
    <Seeded view="focus">
      <WhatNeedsMe />
    </Seeded>
  ),
};

/** GRE-450: Ridge needs John at the computer to restart WSL. */
const DESK_CARDS: DecisionCard[] = [atDeskCard(), questionCard("int-1", "issue-44", "GRE-44"), approvalCard(), reviewCard()];
/** Before GRE-450: the same ask, mixed in with the phone decisions and counted. */
const MIXED_CARDS: DecisionCard[] = [
  { ...atDeskCard(), atDesk: null, actions: atDeskCard().actions.filter((action) => action.id !== "done") },
  questionCard("int-1", "issue-44", "GRE-44"),
  approvalCard(),
  reviewCard(),
];

export const AtYourDeskList: Story = {
  render: () => (
    <Seeded view="list" cards={DESK_CARDS}>
      <WhatNeedsMe />
    </Seeded>
  ),
};

export const AtYourDeskFocus: Story = {
  render: () => (
    <Seeded view="focus" cards={DESK_CARDS}>
      <WhatNeedsMe />
    </Seeded>
  ),
};

export const AtYourDeskBefore: Story = {
  render: () => (
    <Seeded view="list" cards={MIXED_CARDS}>
      <WhatNeedsMe />
    </Seeded>
  ),
};

function CardFrame({ card }: { card: DecisionCard }) {
  return (
    <Seeded view="list">
      <div className="max-w-3xl">
        <DecisionFeedCard card={card} companyId={COMPANY_ID} assignableAgents={fixtureAgents} />
      </div>
    </Seeded>
  );
}

/** GRE-138 style: three sources on one task, merged into one card, with a clarity answer. */
export const MergedCard: Story = { render: () => <CardFrame card={mergedCard()} /> };
export const BlockedCard: Story = { render: () => <CardFrame card={blockedCard()} /> };
export const QuestionCard: Story = { render: () => <CardFrame card={questionCard("int-1", "issue-44", "GRE-44")} /> };
export const ApprovalCard: Story = { render: () => <CardFrame card={approvalCard()} /> };
export const FailedRunCard: Story = { render: () => <CardFrame card={failedRunCard()} /> };
export const ReviewCard: Story = { render: () => <CardFrame card={reviewCard()} /> };
export const ConnectionCard: Story = { render: () => <CardFrame card={connectionAlertCard()} /> };

/** GRE-870 before: a task on your own review had no Approve and said no agent owns it. */
function humanReviewCardBefore(): DecisionCard {
  const base = humanReviewCard();
  return {
    ...base,
    waiting: null,
    reviewer: null,
    actions: base.actions.filter((action) => action.id !== "approve" && action.id !== "request_changes"),
  };
}
export const HumanReviewCardBefore: Story = { render: () => <CardFrame card={humanReviewCardBefore()} /> };
export const HumanReviewCardAfter: Story = { render: () => <CardFrame card={humanReviewCard()} /> };

/** GRE-504 before: one stopped card per task, for the same setup gap of the same agent. */
function setupTaskCard(issueId: string, identifier: string, title: string): DecisionCard {
  const base = setupCard();
  return {
    ...base,
    id: `task:${issueId}`,
    task: { kind: "issue", id: issueId, companyId: COMPANY_ID, title, identifier, status: "blocked", href: `/issues/${identifier}`, metadata: {} } as DecisionCard["task"],
    title: `${identifier} ${title}`,
    reason: "The run stopped before it started: setup is not complete.",
    nextStep: "The task stays stopped until you retry, reassign, resolve or cancel it.",
    setup: null,
    actions: base.actions.filter((action) => action.id === "retry").map((action) => ({ ...action, label: "Retry", requests: action.requests.slice(0, 1) })),
  };
}

export const SetupFailuresBefore: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <CardFrame card={setupTaskCard("issue-601", "GRE-601", "Weekly brief")} />
      <CardFrame card={setupTaskCard("issue-602", "GRE-602", "Board pack")} />
    </div>
  ),
};
export const SetupFailuresAfter: Story = { render: () => <CardFrame card={setupCard()} /> };

/** Two mock screens standing in for the screenshots an agent attaches to a design choice. */
function mockScreen(label: string, accent: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#121212"/><rect x="32" y="32" width="576" height="56" rx="14" fill="#1c1f1d"/><rect x="56" y="54" width="140" height="12" rx="6" fill="${accent}"/><rect x="32" y="112" width="360" height="256" rx="18" fill="#1a1d1b"/><rect x="416" y="112" width="192" height="120" rx="18" fill="#1a1d1b"/><rect x="416" y="248" width="192" height="120" rx="18" fill="#1a1d1b"/><text x="212" y="250" font-family="Montserrat, sans-serif" font-size="28" font-weight="700" fill="${accent}" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function designChoiceCard(): DecisionCard {
  const card = questionCard("int-1", "issue-44", "GRE-44");
  const images = [
    { assetId: mockScreen("Option A", "#c8ff00"), alt: "option-a.png" },
    { assetId: mockScreen("Option B", "#4ecdc4"), alt: "option-b.png" },
  ];
  return {
    ...card,
    title: "GRE-44 Choose the Releases page layout",
    reason: "Two layouts are ready. Pick one and I will ship it.",
    items: card.items.map((item) => ({ ...item, detail: { kind: "generic", summaryExcerpt: "", images } })),
  };
}

export const DesignChoiceWithScreenshots: Story = { render: () => <CardFrame card={designChoiceCard()} /> };

/** A UI change shipped as a named before/after pair: the gallery offers a compare slider. */
function beforeAfterCard(): DecisionCard {
  const card = designChoiceCard();
  const images = [
    { assetId: mockScreen("After", "#c8ff00"), alt: "after-releases-dark.png" },
    { assetId: mockScreen("Before", "#8a8f8b"), alt: "before-releases-dark.png" },
  ];
  return {
    ...card,
    title: "GRE-44 Approve the new Releases page",
    reason: "Before and after are attached. Approve and I will merge it.",
    items: card.items.map((item) => ({ ...item, detail: { kind: "generic", summaryExcerpt: "", images } })),
  };
}

export const UiChangeBeforeAndAfter: Story = { render: () => <CardFrame card={beforeAfterCard()} /> };

/** A one-page deck standing in for an agent's HTML deliverable. */
function mockDeck(title: string, accent: string) {
  const html = `<!doctype html><html><body style="margin:0;font-family:Montserrat,sans-serif;background:#121212;color:#f5f5f0"><div style="padding:56px 64px"><p style="margin:0;color:${accent};font-size:14px;letter-spacing:.12em;text-transform:uppercase">Greatstone</p><h1 style="margin:16px 0 8px;font-size:44px">${title}</h1><p style="margin:0 0 32px;font-size:18px;color:#b8bdb9">Three editions, one price page.</p><div style="display:flex;gap:16px">${["Starter", "Team", "Business"].map((name) => `<div style="flex:1;border:1px solid #2a2e2b;border-radius:16px;padding:24px"><p style="margin:0;font-weight:700">${name}</p><p style="margin:12px 0 0;font-size:32px;color:${accent}">£</p></div>`).join("")}</div></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** GRE-451: an approval card that carries the real thing, open on the card. */
function deliverableApprovalCard(withDeliverables = true): DecisionCard {
  const card = questionCard("int-1", "issue-44", "GRE-44");
  const deliverables = withDeliverables
    ? [
        { id: "deck-v2", title: "Pricing deck", contentType: "text/html", contentPath: mockDeck("Pricing deck", "#c8ff00"), originalFilename: "pricing-deck.html" },
        { id: "brief-v1", title: "Pricing brief", contentType: "text/html", contentPath: mockDeck("Pricing brief", "#4ecdc4"), originalFilename: "pricing-brief.html" },
      ]
    : [];
  return {
    ...card,
    title: "GRE-44 Approve the pricing deck",
    reason: "The deck is ready. Approve it and I will send it to the client.",
    items: card.items.map((item) => ({
      ...item,
      detail: { kind: "confirmation", promptExcerpt: "Approve the pricing deck?", isPlanTarget: false, images: [], deliverables },
    })),
  };
}

export const ApprovalWithDeliverable: Story = { render: () => <CardFrame card={deliverableApprovalCard()} /> };
/** Before GRE-451: the same ask, with only the words on the card. */
export const ApprovalWithDeliverableBefore: Story = { render: () => <CardFrame card={deliverableApprovalCard(false)} /> };

export const TaskPageTabledBanner: Story = {
  render: () => (
    <div className="max-w-3xl">
      <TabledBanner issue={TABLED[0]!} />
    </div>
  ),
};
