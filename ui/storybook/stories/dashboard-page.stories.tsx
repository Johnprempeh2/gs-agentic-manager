import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { AttentionFeed, AttentionItem, DashboardRunActivityDay } from "@greatstone/shared";
import { Dashboard } from "@/pages/Dashboard";
import { DASHBOARD_OPEN_TASK_STATUSES } from "@/components/DashboardOverview";
import { queryKeys } from "@/lib/queryKeys";
import {
  storybookActivityEvents,
  storybookAgents,
  storybookDashboardSummary,
  storybookIssues,
  storybookLiveRuns,
} from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";

function decision(id: string, rank: number, title: string): AttentionItem {
  return {
    id,
    companyId: COMPANY_ID,
    sourceKind: "approval",
    subject: { kind: "approval", id: `${id}-subject`, companyId: COMPANY_ID, title, identifier: null, status: null, href: null },
    rank,
    severity: "medium",
  } as unknown as AttentionItem;
}

const attentionFeed = {
  companyId: COMPANY_ID,
  generatedAt: new Date().toISOString(),
  totalCount: 3,
  deskBadgeCount: 1,
  items: [
    decision("decision-1", 1, "Approve hiring a QA engineer"),
    decision("decision-2", 2, "Raise the monthly budget"),
  ],
} as unknown as AttentionFeed;

/** Answers the live-runs request the agents panel makes, so running agents show as live. */
function installLiveRunsFixture() {
  const current = window as typeof window & { __dashboardLiveRunsFixture?: boolean };
  if (current.__dashboardLiveRunsFixture) return;
  current.__dashboardLiveRunsFixture = true;
  const previousFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    if (/^\/api\/companies\/[^/]+\/live-runs$/.test(url.pathname)) return Response.json(storybookLiveRuns);
    return previousFetch(input, init);
  };
}

/** A company four days old: runs only on the last four days of the 14-day window, ending today. */
function firstWeekRunActivity(): DashboardRunActivityDay[] {
  return Array.from({ length: 14 }, (_, i) => {
    const daysAgo = 13 - i;
    const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const empty: DashboardRunActivityDay = { date, succeeded: 0, failed: 0, recovered: 0, other: 0, total: 0, failedByErrorCode: {} };
    if (daysAgo > 3) return empty;
    const failed = daysAgo === 1 ? 4 : 1;
    const recovered = daysAgo === 0 ? 2 : 0;
    const succeeded = 6 - daysAgo;
    return { ...empty, succeeded, failed, recovered, total: succeeded + failed + recovered, failedByErrorCode: { process_lost: failed } };
  });
}

/** Seeds the page's queries once; the Storybook client never refetches them. */
function SeededDashboard({ children, runActivity }: { children: ReactNode; runActivity?: DashboardRunActivityDay[] }) {
  const queryClient = useQueryClient();
  useState(() => {
    installLiveRunsFixture();
    const openStatuses = new Set<string>(DASHBOARD_OPEN_TASK_STATUSES);
    queryClient.setQueryData(
      queryKeys.dashboard(COMPANY_ID),
      runActivity ? { ...storybookDashboardSummary, runActivity } : storybookDashboardSummary,
    );
    queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), storybookAgents);
    queryClient.setQueryData(queryKeys.issues.list(COMPANY_ID), storybookIssues);
    queryClient.setQueryData(
      [...queryKeys.issues.list(COMPANY_ID), "dashboard-open"],
      storybookIssues.filter((issue) => openStatuses.has(issue.status)),
    );
    queryClient.setQueryData([...queryKeys.activity(COMPANY_ID), { limit: 10 }], storybookActivityEvents);
    queryClient.setQueryData(queryKeys.attention(COMPANY_ID), attentionFeed);
    return true;
  });
  return <>{children}</>;
}

const meta = {
  title: "Dashboard/Page",
  component: Dashboard,
  parameters: { layout: "padded" },
  decorators: [
    (Story, context) => (
      <SeededDashboard runActivity={context.parameters.runActivity as DashboardRunActivityDay[] | undefined}>
        <Story />
      </SeededDashboard>
    ),
  ],
} satisfies Meta<typeof Dashboard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Decisions line on top, then agents, live runs, metric cards, charts and recent activity. */
export const Populated: Story = {};

/** A young company: the run charts start at the first run instead of showing ten empty days. */
export const FirstWeek: Story = { parameters: { runActivity: firstWeekRunActivity() } };
