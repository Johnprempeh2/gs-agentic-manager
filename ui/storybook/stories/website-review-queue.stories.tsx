import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WebsiteEntry, WebsitePage, WebsiteReviewQueue as Queue } from "@greatstone/shared";
import { WebsiteReviewQueue } from "@/components/website/WebsiteReviewQueue";
import { queryKeys } from "@/lib/queryKeys";

// Synthetic records for layout review only (GRE-4078); no client names.
const pages = [
  ["/", "Home"],
  ["/about", "About us"],
  ["/consultancy", "Consultancy"],
  ["/consultancy/deep-dive", "Deep Dive"],
  ["/contact", "Contact"],
].map(([slug, title], index) => ({ id: `page-${index}`, slug, title, status: "review" }) as WebsitePage);
const entries = ["example-pdf-sdk", "example-barcode-sdk", "example-ocr-sdk"].map(
  (entryKey, index) => ({ id: `entry-${index}`, entryKey, collection: "product", status: "review" }) as WebsiteEntry,
);
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
