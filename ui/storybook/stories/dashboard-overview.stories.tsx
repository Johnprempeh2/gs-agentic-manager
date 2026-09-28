import type { Meta, StoryObj } from "@storybook/react-vite";
import { DashboardOverview } from "@/components/DashboardOverview";
import { storybookAgents, storybookIssues } from "../fixtures/paperclipData";

const meta = {
  title: "Dashboard/Overview",
  component: DashboardOverview,
  parameters: { layout: "padded" },
} satisfies Meta<typeof DashboardOverview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: { agents: storybookAgents, openIssues: storybookIssues },
};

export const Empty: Story = {
  args: { agents: [], openIssues: [] },
};

export const Loading: Story = {
  args: { agents: undefined, openIssues: undefined, agentsLoading: true, issuesLoading: true },
};

export const ErrorState: Story = {
  args: {
    agents: undefined,
    openIssues: undefined,
    agentsError: new Error("Network request failed"),
    issuesError: new Error("Network request failed"),
  },
};
