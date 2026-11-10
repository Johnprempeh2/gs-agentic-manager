import { useEffect, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { FeatureTour } from "@/components/FeatureTour";
import { WEBSITE_SITEMAP_TOUR } from "@/lib/website-tours";
import { queryKeys } from "@/lib/queryKeys";
import { Tutorials } from "@/pages/Tutorials";
import { SitemapAndPagesDisagree } from "./website-sitemap-now.stories";

// The Tutorials page and one tour running over a real page, with the Website switch on.
// The person here has taken three tours, so their rows say Replay.

const SEEN = ["welcome", "decisions", "tasks"].map((tourKey) => ({ tourKey, tourVersion: 1, seenAt: "2026-11-10T08:00:00.000Z" }));

function Seeded({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    queryClient.setQueryData(queryKeys.instance.experimentalSettings, { enableWebsiteView: true });
    // The session loads a moment after the page, so seed both names it can go by.
    for (const userId of ["user-board", "local"]) queryClient.setQueryData(queryKeys.tourDismissals(userId), SEEN);
    setReady(true);
  }, [queryClient]);
  return ready ? <div className="p-4 sm:p-6">{children}</div> : null;
}

const meta = { title: "Help/Tours", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const TutorialsByArea: Story = {
  render: () => <Seeded><Tutorials /></Seeded>,
};

/** Select Show me around. The view switch is not on this page, so its stop is left out. */
export const SitemapTour: Story = {
  render: (args, context) => (
    <Seeded>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Website</h1>
        <FeatureTour tour={WEBSITE_SITEMAP_TOUR} />
      </div>
      {SitemapAndPagesDisagree.render?.(args as never, context as never)}
    </Seeded>
  ),
};
