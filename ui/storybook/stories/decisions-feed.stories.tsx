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
  blockedCard,
  connectionAlertCard,
  failedRunCard,
  fixtureAgents,
  fixtureFeed,
  mergedCard,
  questionCard,
  reviewCard,
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

function Seeded({ children, view }: { children: ReactNode; view: "list" | "focus" }) {
  const queryClient = useQueryClient();
  useState(() => {
    try {
      localStorage.setItem(DECISIONS_VIEW_KEY, view);
      sessionStorage.removeItem(focusSessionKey(COMPANY_ID));
    } catch {
      // Storybook without storage still renders the list.
    }
    queryClient.setQueryData(queryKeys.decisionsFeed.feed(COMPANY_ID), fixtureFeed(CARDS));
    queryClient.setQueryData(queryKeys.tabledIssues(COMPANY_ID), TABLED);
    queryClient.setQueryData([...queryKeys.attention(COMPANY_ID), "with-dismissed"], {
      companyId: COMPANY_ID,
      generatedAt: "2026-09-29T22:00:00.000Z",
      items: [],
    });
    queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), storybookAgents);
    queryClient.setQueryData(queryKeys.issues.interactions("issue-44"), [QUESTION]);
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

export const TaskPageTabledBanner: Story = {
  render: () => (
    <div className="max-w-3xl">
      <TabledBanner issue={TABLED[0]!} />
    </div>
  ),
};
