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

export const TaskPageTabledBanner: Story = {
  render: () => (
    <div className="max-w-3xl">
      <TabledBanner issue={TABLED[0]!} />
    </div>
  ),
};
