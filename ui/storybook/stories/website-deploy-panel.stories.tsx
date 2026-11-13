import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PUBLIC_NETLIFY_SITE_ID, type WebsiteProductionStatus, type WebsiteSite } from "@greatstone/shared";
import { WebsiteDeployPanel } from "@/components/website/WebsiteDeployPanel";
import { queryKeys } from "@/lib/queryKeys";

// Staging and live side by side, and Deploy straight to live (John, 13 Nov). Synthetic commits for layout review.
const site = { id: "site-1", companyId: "co-1", name: "Greatstone website", domain: "greatstoneint.com", netlifySiteId: PUBLIC_NETLIFY_SITE_ID } as WebsiteSite;

const base: WebsiteProductionStatus = {
  staging: { commit: "9c41e7a0d2b84f6e1a3c5d7e9f0b2a4c6e8d0f12", release: 14, changedAt: "2026-11-13T15:04:00Z", url: "https://gre3833-next-db-staging.netlify.app" },
  live: { commit: "4be20f13a9c7d5e3b1f0a2c4e6d8b0a1c3e5f7d9", release: 12, deployId: "6735f0a1b2c3d4e5f6a7b8c9", publishedAt: "2026-11-11T09:12:00Z", url: "https://greatstoneint.com" },
  commits: [
    { sha: "9c41e7a0d2b84f6e1a3c5d7e9f0b2a4c6e8d0f12", title: "Shop: filter by category" },
    { sha: "71d0c3e5a7b9d1f3e5a7c9b1d3f5a7c9e1b3d5f7", title: "Footer links in British English" },
  ],
  blockers: [],
  rollback: { deployId: "6731aa00bb11cc22dd33ee44", commit: "1f2e3d4c5b6a7980a1b2c3d4e5f6a7b8c9d0e1f2", publishedAt: "2026-11-08T10:00:00Z" },
  runs: [],
  canDeploy: true,
  workflowReady: true,
  publicKey: "Qm9vdHN0cmFwLXB1YmxpYy1rZXktZm9yLWxheW91dC0",
  problems: [],
  direct: {
    supported: true,
    main: { sha: "b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5", title: "Consultancy page: new hero copy" },
    commits: [
      { sha: "b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5", title: "Consultancy page: new hero copy" },
      { sha: "9c41e7a0d2b84f6e1a3c5d7e9f0b2a4c6e8d0f12", title: "Shop: filter by category" },
      { sha: "71d0c3e5a7b9d1f3e5a7c9b1d3f5a7c9e1b3d5f7", title: "Footer links in British English" },
    ],
    approved: { pages: ["About us (/about)", "Contact (/contact)"], entries: ["product: deep-dive-diagnostic"] },
  },
};

function withStatus(status: WebsiteProductionStatus) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchInterval: false } } });
  client.setQueryData(queryKeys.website.production("co-1", "site-1"), status);
  return (
    <QueryClientProvider client={client}>
      <WebsiteDeployPanel companyId="co-1" site={site} />
    </QueryClientProvider>
  );
}

const meta = {
  title: "Website/Deploy panel",
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="mx-auto max-w-4xl p-4 sm:p-6"><Story /></div>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const StagingAndLive: Story = { render: () => withStatus(base) };
export const CouldNotRead: Story = {
  render: () => withStatus({ ...base, staging: { ...base.staging, commit: null, changedAt: null }, problems: ["GSAM could not read staging's deploys (The operation was aborted due to timeout)."] }),
};
export const WaitingForWebsiteUpdate: Story = { render: () => withStatus({ ...base, direct: { ...base.direct, supported: false } }) };
export const NotJohn: Story = { render: () => withStatus({ ...base, canDeploy: false, publicKey: null }) };
