import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { websiteEntrySummary, type WebsiteEntry, type WebsiteProperty } from "@greatstone/shared";
import { WebsiteCollectionsTab } from "@/components/website/WebsiteCollections";
import { queryKeys } from "@/lib/queryKeys";
import publicCatalogue from "../../../server/src/services/website/public-import-v1.json?raw";

// The Collections tab's product list, with the public website's own catalogue as it was captured (names, descriptions
// and prices are the site's, gaps included), keyed and summarised the way the server sends it. No client names.
const products = (JSON.parse(publicCatalogue) as { products: { id: string }[] }).products.map(
  (item, index) =>
    ({
      id: item.id,
      entryKey: item.id,
      collection: "product",
      status: index % 5 === 0 ? "review" : "draft",
      latestRevisionNumber: 1,
      updatedAt: "2026-11-09T09:00:00Z",
      summary: websiteEntrySummary({ data: item }),
    }) as unknown as WebsiteEntry,
);

function Collections() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(queryKeys.website.sites("co-1"), [{ id: "site-1", propertyId: "property-1", archivedAt: null }]);
  client.setQueryData(queryKeys.access.currentBoardAccess, { source: "local_implicit" });
  client.setQueryData(["website-entries", "co-1", "site-1", "product"], products);
  return (
    <QueryClientProvider client={client}>
      <WebsiteCollectionsTab companyId="co-1" property={{ id: "property-1" } as WebsiteProperty} />
    </QueryClientProvider>
  );
}

const meta = {
  title: "Website/Collections",
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="mx-auto max-w-7xl p-4 sm:p-6"><Story /></div>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Products: Story = { render: () => <Collections /> };
