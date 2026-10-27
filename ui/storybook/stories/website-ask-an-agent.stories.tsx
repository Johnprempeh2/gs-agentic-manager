import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WebsitePage } from "@greatstone/shared";
import { EditorDrawer } from "@/components/website/WebsiteEditorWorkspace";
import { WebsiteChangeRequestPanel, websiteScreenshotFile, type WebsiteScreenshot } from "@/components/website/WebsiteChangeRequest";
import { queryKeys } from "@/lib/queryKeys";

// Ask an agent, slices 1 and 2 (GRE-2518, GRE-2527), in the editor's shell:
// the canvas with the drawing host and the one drawer beside it (a bottom sheet
// on a phone). The screenshot and the media are drawn here; no site, no API.
// Synthetic content for layout review only.

const COMPANY_ID = "storybook-company";
const SITE_ID = "storybook-site";

const page = {
  id: "page-home",
  title: "Home",
  slug: "/",
  latestRevisionId: "revision-1",
} as unknown as WebsitePage;

/** A plain page drawn on a canvas: a nav, a hero and three cards. */
function fakePage(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const unit = width / 40;
  ctx.fillStyle = "#f6f3ee";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#1d2b3a";
  ctx.fillRect(0, 0, width, unit * 3);
  ctx.fillStyle = "#c8a24a";
  ctx.fillRect(unit * 2, unit, unit * 6, unit);
  ctx.fillStyle = "#1d2b3a";
  ctx.font = `600 ${unit * 2.2}px Georgia, serif`;
  ctx.fillText("Calm advice for", unit * 2, unit * 9);
  ctx.fillText("growing firms", unit * 2, unit * 12);
  ctx.fillStyle = "#5b6672";
  ctx.fillRect(unit * 2, unit * 14, unit * 22, unit * 0.7);
  ctx.fillRect(unit * 2, unit * 15.5, unit * 18, unit * 0.7);
  ctx.fillStyle = "#1d2b3a";
  ctx.fillRect(unit * 2, unit * 18, unit * 9, unit * 2.5);
  const cards = width > 600 ? 3 : 1;
  const cardWidth = (width - unit * 4 - unit * (cards - 1)) / cards;
  for (let row = 0; row < (cards === 1 ? 3 : 1); row += 1) {
    for (let index = 0; index < cards; index += 1) {
      const x = unit * 2 + index * (cardWidth + unit);
      const y = unit * 24 + row * unit * 14;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, y, cardWidth, unit * 12);
      ctx.fillStyle = "#d9d2c5";
      ctx.fillRect(x, y, cardWidth, unit * 5);
      ctx.fillStyle = "#5b6672";
      ctx.fillRect(x + unit, y + unit * 7, cardWidth - unit * 4, unit * 0.6);
      ctx.fillRect(x + unit, y + unit * 8.5, cardWidth - unit * 6, unit * 0.6);
    }
  }
  return canvas.toDataURL("image/png");
}

function swatch(hue: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 320, 180);
  gradient.addColorStop(0, `hsl(${hue} 45% 35%)`);
  gradient.addColorStop(1, `hsl(${(hue + 40) % 360} 55% 70%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 320, 180);
  return canvas.toDataURL("image/png");
}

// The first two are long and differ only at the end, to check that names are not cut off.
const MEDIA_LABELS = [
  "Greatstone office front entrance in the morning light",
  "Greatstone office front entrance in the evening light",
  "Office front", "Team at work", "Harbour view", "Client meeting", "Desk detail", "City at dusk", "Notebook", "Coffee table", "Stairwell", "Garden",
];

const EFFECTS = [
  { id: "aurora", label: "Aurora background", description: "Slow colour bands that drift behind the block." },
  { id: "grain", label: "Film grain", description: "A light grain over the whole block, for a printed feel." },
  { id: "parallax", label: "Parallax image", description: "The image moves a little slower than the page as it scrolls." },
  { id: "fade-up", label: "Fade up on scroll", description: "Each item fades in and rises as it comes into view." },
  { id: "marquee", label: "Logo marquee", description: "A row of logos that scrolls sideways without end." },
  { id: "spotlight", label: "Cursor spotlight", description: "A soft light follows the pointer across the block." },
  { id: "tilt", label: "Card tilt", description: "Cards tilt toward the pointer when it is over them." },
];

function seededClient() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(
    queryKeys.website.media(COMPANY_ID, SITE_ID),
    MEDIA_LABELS.map((label, index) => ({
      entryId: `entry-${index}`,
      entryKey: `media-${index}`,
      assetId: `asset-${index}`,
      alt: label,
      contentType: "image/png",
      contentPath: swatch(index * 36),
    })),
  );
  client.setQueryData(
    queryKeys.website.studioMedia(COMPANY_ID, "studio"),
    MEDIA_LABELS.slice(0, 5).map((label, index) => ({
      source: "studio",
      id: `studio-${index}`,
      assetId: `studio-asset-${index}`,
      label: `A warm editorial photo: ${label.toLowerCase()}, soft morning light`,
      contentPath: swatch(200 + index * 25),
    })),
  );
  return client;
}

function AskAnAgentShell({ phone }: { phone: boolean }) {
  const [client] = useState(seededClient);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(true);
  const [shot] = useState(() => {
    const width = phone ? 780 : 1280;
    const url = fakePage(width, phone ? 2400 : 1100);
    return url;
  });
  const capture = async (): Promise<WebsiteScreenshot> => ({
    file: websiteScreenshotFile(shot, "page"),
    width: phone ? 390 : 1280,
    url: shot,
  });

  return (
    <QueryClientProvider client={client}>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 text-sm font-medium">Home · Editor</div>
        <div className="relative flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1 bg-background">
            <div className="absolute inset-0 overflow-auto">
              <img src={shot} alt="" className="block h-auto w-full" />
            </div>
            <div ref={setHost} data-testid="website-markup-host" />
          </div>
          {open && host ? (
            <EditorDrawer title="Ask an agent" onClose={() => setOpen(false)}>
              <WebsiteChangeRequestPanel
                companyId={COMPANY_ID}
                siteId={SITE_ID}
                page={page}
                target={{ kind: "block", blockId: "hero-1", blockType: "Hero", label: "Hero" }}
                width={phone ? "phone" : "laptop"}
                displayWidth={null}
                capture={capture}
                markupHost={host}
                effects={EFFECTS}
                onCancel={() => setOpen(false)}
              />
            </EditorDrawer>
          ) : null}
        </div>
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Website/Ask an agent",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Laptop: Story = { render: () => <AskAnAgentShell phone={false} /> };
export const Phone: Story = {
  render: () => <AskAnAgentShell phone />,
  globals: { viewport: { value: "mobile", isRotated: false } },
};
