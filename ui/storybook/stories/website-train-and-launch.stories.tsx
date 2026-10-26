import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WebsiteHomeLaunch, WebsiteHomeTrain } from "@greatstone/shared";
import { TrainAndLaunch } from "@/components/website/WebsiteTrainAndLaunch";

// GRE-2662: the weekly release train and the launch countdown on the Website Home.

const issue = (identifier: string, status: string, title = identifier) => ({ id: identifier, identifier, title, status });

/** The real state on 25 Oct 2026: no train yet, the date proposed, the gates as they stand. */
const launch: WebsiteHomeLaunch = {
  targetDate: "2026-11-03",
  agreement: "proposed",
  daysLeft: 9,
  cardIssue: issue("GRE-2641", "blocked"),
  gates: [
    { label: "Database cut-over", identifier: "GRE-2567", issue: issue("GRE-2567", "blocked") },
    { label: "Sign-in", identifier: "GRE-1991", issue: issue("GRE-1991", "blocked") },
    { label: "25 Oct page changes", identifier: "GRE-2565", issue: issue("GRE-2565", "blocked") },
    { label: "Client hub", identifier: "GRE-2613", issue: issue("GRE-2613", "blocked") },
    { label: "Domain and DNS", identifier: "GRE-2663", issue: issue("GRE-2663", "in_progress") },
  ],
};
const noTrain: WebsiteHomeTrain = { issue: null, tag: null, state: "none", card: null, nextRunAt: "2026-10-26T06:00:00.000Z" };

const meta = {
  title: "Website/Train and launch",
  component: TrainAndLaunch,
  decorators: [(Story) => <div className="mx-auto max-w-[1400px] p-4 sm:p-6"><Story /></div>],
} satisfies Meta<typeof TrainAndLaunch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Today: Story = { args: { train: noTrain, launch } };

export const WaitingForApproval: Story = {
  args: {
    train: {
      issue: issue("GRE-2700", "in_progress", "Weekly website release train"),
      tag: "web-rc-2026-10-26",
      state: "waiting_for_approval",
      card: { id: "c-1", status: "pending", resolvedByName: null, resolvedAt: null },
      nextRunAt: "2026-11-02T06:00:00.000Z",
    },
    launch,
  },
};

export const ApprovedAndAgreed: Story = {
  args: {
    train: {
      issue: issue("GRE-2700", "in_progress", "Weekly website release train"),
      tag: "web-rc-2026-10-26",
      state: "approved",
      card: { id: "c-1", status: "accepted", resolvedByName: "Ben", resolvedAt: "2026-10-26T15:10:00.000Z" },
      nextRunAt: "2026-11-02T06:00:00.000Z",
    },
    launch: { ...launch, agreement: "agreed" },
  },
};

export const Empty: Story = {
  args: { train: { ...noTrain, nextRunAt: null }, launch: { ...launch, targetDate: null, daysLeft: null } },
};
