import { useEffect, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { FeatureTour } from "@/components/FeatureTour";
import type { WebsiteSiteStyle } from "@greatstone/shared";
import { WebsiteStyleView } from "@/components/website/WebsiteStyle";
import { releasesOverviewFixture } from "@/fixtures/releaseFixtures";
import { GSAM_RELEASES_TOUR } from "@/lib/area-tours";
import { WEBSITE_SITEMAP_TOUR, WEBSITE_STYLE_TOUR } from "@/lib/website-tours";
import { ReleasesView } from "@/pages/Releases";
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

// Demo data only: an example site's stylesheet as the Style tab reads it.
const DEMO_STYLE: WebsiteSiteStyle = {
  siteId: "site-demo",
  siteUrl: "https://www.example.com/",
  readAt: "2026-11-10T08:00:00.000Z",
  stylesheets: ["https://www.example.com/site.css"],
  fontStylesheets: [],
  releaseTokenCount: 1,
  problem: null,
  colours: [
    { cssVar: "--bg", aliases: [], token: null, name: "Bg", value: "#121212", hex: "#121212", alpha: 1, role: "background", usedFor: ["background"], usedIn: ["body"], unused: false, source: "stylesheet" },
    { cssVar: "--text", aliases: [], token: null, name: "Text", value: "#f5f5f0", hex: "#f5f5f0", alpha: 1, role: "text", usedFor: ["text"], usedIn: ["body"], unused: false, source: "stylesheet" },
    { cssVar: "--accent", aliases: [], token: "site.accent", name: "Accent", value: "#c8ff00", hex: "#c8ff00", alpha: 1, role: "accent", usedFor: ["background"], usedIn: [".btn--primary"], unused: false, source: "release" },
  ],
  contrast: [
    { text: "#f5f5f0", textName: "Text", background: "#121212", backgroundName: "Bg", usedIn: ["body"], ratio: 17.4, rating: "AAA" },
  ],
  fonts: [{ family: "Georgia", stack: "Georgia, serif", weights: [400, 700], usedIn: ["h1"], loadedFrom: "system" }],
  textStyles: [],
  components: [
    { kind: "button", selector: ".btn--primary", className: "btn btn--primary", label: "Btn primary", declarations: { background: "#c8ff00", color: "#121212", "border-radius": "999px", padding: "12px 20px" }, inPage: true },
  ],
  tokens: [],
  surfaces: [],
};

/** Select Show me around: five stops over the Style tab, with demo data. */
export const StyleTour: Story = {
  render: () => (
    <Seeded>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Website</h1>
        <FeatureTour tour={WEBSITE_STYLE_TOUR} />
      </div>
      <WebsiteStyleView style={DEMO_STYLE} siteName="Example site" onAsk={() => {}} onReadAgain={() => {}} />
    </Seeded>
  ),
};

/** Select Show me around: the GSAM releases page, from the release fixture. */
export const GsamReleasesTour: Story = {
  render: () => (
    <Seeded>
      <div className="mx-auto mb-4 flex max-w-3xl justify-end">
        <FeatureTour tour={GSAM_RELEASES_TOUR} />
      </div>
      <ReleasesView companyId="company-storybook" overview={releasesOverviewFixture()} fetchError={null} />
    </Seeded>
  ),
};
