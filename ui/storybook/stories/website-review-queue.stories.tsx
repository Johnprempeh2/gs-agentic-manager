import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { websiteEntrySummary, type WebsiteEntry, type WebsitePage, type WebsiteReviewQueue as Queue } from "@greatstone/shared";
import { WebsiteReviewQueue } from "@/components/website/WebsiteReviewQueue";
import { queryKeys } from "@/lib/queryKeys";
import publicCatalogue from "../../../server/src/services/website/public-import-v1.json?raw";

// Synthetic pages for layout review only (GRE-4078); no client names. The entries are the public website's own
// catalogue as it was captured, keyed and summarised the way the server sends them.
const pages = [
  ["/", "Home"],
  ["/about", "About us"],
  ["/consultancy", "Consultancy"],
  ["/consultancy/deep-dive", "Deep Dive"],
  ["/contact", "Contact"],
].map(([slug, title], index) => ({ id: `page-${index}`, slug, title, status: "review", latestRevisionNumber: 2, updatedAt: "2026-11-08T09:00:00Z" }) as WebsitePage);
const catalogue = JSON.parse(publicCatalogue) as Record<"products" | "categories" | "vendors", { id: string }[]>;
const entry = (collection: string) => (item: { id: string }) =>
  ({ id: item.id, entryKey: item.id, collection, status: "review", latestRevisionNumber: 1, updatedAt: "2026-11-09T09:00:00Z", summary: websiteEntrySummary({ data: item }) }) as unknown as WebsiteEntry;
const entries = [
  ...catalogue.products.slice(0, 6).map(entry("product")),
  ...catalogue.categories.slice(0, 1).map(entry("category")),
  ...catalogue.vendors.slice(0, 1).map(entry("vendor")),
];
const queue: Queue = { pages, entries };

function withData(publish: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(queryKeys.website.review("co-1", "site-1"), queue);
  client.setQueryData(queryKeys.website.access("co-1", "site-1"), { view: true, edit: true, publish });
  return (
    <QueryClientProvider client={client}>
      <WebsiteReviewQueue companyId="co-1" siteId="site-1" />
    </QueryClientProvider>
  );
}

const meta = {
  title: "Website/Review queue",
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="mx-auto max-w-7xl p-4 sm:p-6"><Story /></div>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithPublishRights: Story = { render: () => withData(true) };
export const WithoutPublishRights: Story = { render: () => withData(false) };
