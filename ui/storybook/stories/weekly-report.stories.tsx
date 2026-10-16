import type { Meta, StoryObj } from "@storybook/react-vite";
import { WeeklyReportView } from "@/pages/WeeklyReport";
import { WEEKLY_REPORT_FIXTURE } from "@/lib/weekly-report.fixture";

/**
 * "This week at Greatstone": the weekly executive report. One page on what
 * the agents finished, what is stuck and for how long, how the client
 * pipeline moved, what needs you and what each agent cost.
 */
const meta = {
  title: "Product/Weekly report",
  component: WeeklyReportView,
  parameters: { layout: "padded" },
} satisfies Meta<typeof WeeklyReportView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FullWeek: Story = {
  args: { report: WEEKLY_REPORT_FIXTURE },
  render: (args) => (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-xl font-semibold">This week at Greatstone</h1>
      <WeeklyReportView {...args} />
    </div>
  ),
};

export const QuietWeek: Story = {
  args: {
    report: {
      ...WEEKLY_REPORT_FIXTURE,
      finished: { count: 0, agents: [] },
      stuck: { count: 0, items: [] },
      pipeline: { added: 0, moved: 0, won: 0, lost: 0, moves: [] },
      needsYou: { count: 0, items: [] },
      costs: { totalCents: 0, agents: [] },
    },
  },
};
