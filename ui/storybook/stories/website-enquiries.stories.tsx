import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WebsiteEnquiryLead } from "@greatstone/shared";
import { WebsiteEnquiriesView } from "@/components/website/WebsiteEnquiries";

// Synthetic records for layout review only; no client names or claims.
const leads: WebsiteEnquiryLead[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    pipelineId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Jo Example — website enquiry",
    organisationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    contactEmail: "jo@example.test",
    source: "contact-form",
    page: "/contact",
    submittedAt: "2026-10-24T12:00:00Z",
    createdAt: "2026-10-24T12:03:00Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    pipelineId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Sam Example — website enquiry",
    organisationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    contactEmail: "sam@example.test",
    source: "executive-discovery",
    page: "/consultancy/executive-discovery",
    submittedAt: "2026-10-23T09:00:00Z",
    createdAt: "2026-10-23T09:02:00Z",
  },
];

const meta = {
  title: "Website/Front door and enquiries",
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="mx-auto max-w-7xl p-4 sm:p-6"><Story /></div>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithLeads: Story = { render: () => <WebsiteEnquiriesView leads={leads} onCheck={() => {}} /> };
export const Empty: Story = { render: () => <WebsiteEnquiriesView leads={[]} onCheck={() => {}} /> };
