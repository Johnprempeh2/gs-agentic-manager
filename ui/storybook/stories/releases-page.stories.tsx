import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReleasesView } from "@/pages/Releases";
import { releasesOverviewFixture } from "@/fixtures/releaseFixtures";

const meta: Meta = {
  title: "Pages/Releases",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

/** The board's Releases page: live version, the next release and history. */
export const Overview: Story = {
  render: () => (
    <div className="p-6">
      <ReleasesView companyId="company-storybook" overview={releasesOverviewFixture()} fetchError={null} />
    </div>
  ),
};
