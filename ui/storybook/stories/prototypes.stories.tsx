import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { Prototype } from "@greatstone/shared";
import { PrototypeList } from "@/components/prototypes/PrototypeList";
import { queryKeys } from "@/lib/queryKeys";

// Prototypes (14 Nov) with made-up clients only: every status, a client not yet
// linked to the website, one that needs sharing again, and a missing screenshot.

const COMPANY = "demo-company";

function shot(label: string, hue: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="hsl(${hue} 30% 18%)"/><rect x="32" y="32" width="576" height="40" rx="8" fill="hsl(${hue} 30% 28%)"/><rect x="32" y="96" width="360" height="200" rx="12" fill="hsl(${hue} 40% 34%)"/><rect x="416" y="96" width="192" height="92" rx="12" fill="hsl(${hue} 30% 26%)"/><rect x="416" y="204" width="192" height="92" rx="12" fill="hsl(${hue} 30% 26%)"/><text x="48" y="60" font-family="sans-serif" font-size="18" fill="white">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function demo(id: string, overrides: Partial<Prototype>): Prototype {
  return {
    id, companyId: COMPANY, key: id, version: 1, versionCount: 1, title: "Prototype", summary: null, kind: "prototype",
    brand: "Greatstone", status: "final", stage: "in_review", confidentiality: "internal", attachmentId: null, external: true,
    url: `https://${id}.example.invalid`, screenshotPath: null, screenshotCapturedAt: null, linkCheck: null, restricted: false,
    contentType: "text/uri-list", byteSize: 0, originalFilename: null, contentPath: "", openPath: "", downloadPath: "",
    issue: { id: `${id}-task`, identifier: "DEMO-1", title: "Build it" }, project: null, projectMoved: false, clientCase: null,
    createdByAgent: null, createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:00:00.000Z", lastOpenedAt: null,
    href: "", appPath: "", prototypeStatus: "draft", client: null,
    portal: { visible: false, sharedAt: null, sharedByUserId: null, needsReshare: false }, owner: null,
    ...overrides,
  };
}

const northwind = { id: "org-northwind", name: "Northwind Traders (demo)", websiteLinked: true };
const contoso = { id: "org-contoso", name: "Contoso Health (demo)", websiteLinked: true };
const fabrikam = { id: "org-fabrikam", name: "Fabrikam Logistics (demo)", websiteLinked: false };

export const DEMO_PROTOTYPES: Prototype[] = [
  demo("northwind-portal", {
    title: "Supplier portal", summary: "Clickable first cut of the supplier onboarding journey.", version: 3, versionCount: 3,
    client: northwind, project: { id: "p1", name: "Supplier onboarding" }, prototypeStatus: "shared",
    portal: { visible: true, sharedAt: "2026-11-14T09:00:00.000Z", sharedByUserId: "u1", needsReshare: false },
    owner: { type: "agent", id: "a1", name: "Lintel" }, screenshotPath: shot("Supplier portal", 150),
  }),
  demo("contoso-triage", {
    title: "Patient triage app", summary: "Nurse triage screens with the queue and handover note.", version: 2, versionCount: 2,
    client: contoso, project: { id: "p2", name: "Triage pilot" }, prototypeStatus: "in_review",
    owner: { type: "user", id: "u2", name: "John" }, screenshotPath: shot("Patient triage", 200),
  }),
  demo("contoso-dashboard", {
    title: "Ward dashboard", summary: "Bed occupancy and discharge forecast.", client: contoso, project: { id: "p2", name: "Triage pilot" },
    prototypeStatus: "draft", owner: { type: "agent", id: "a2", name: "Mica" },
    portal: { visible: false, sharedAt: null, sharedByUserId: null, needsReshare: true }, screenshotPath: shot("Ward dashboard", 260),
  }),
  demo("fabrikam-tracker", {
    title: "Fleet tracker", summary: "Live map of vans with delay alerts.", client: fabrikam, project: { id: "p3", name: "Fleet visibility" },
    prototypeStatus: "draft", owner: { type: "agent", id: "a1", name: "Lintel" },
  }),
  demo("northwind-old", {
    title: "Catalogue concept", summary: "Early concept, replaced by the supplier portal.", client: northwind,
    project: { id: "p1", name: "Supplier onboarding" }, prototypeStatus: "retired", screenshotPath: shot("Catalogue concept", 30),
  }),
];

function Seed({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  client.setQueryData(queryKeys.prototypes.list(COMPANY, { organisationId: undefined, projectId: undefined }), { prototypes: DEMO_PROTOTYPES });
  return <>{children}</>;
}

const meta = {
  title: "Clients/Prototypes",
  component: PrototypeList,
  args: { companyId: COMPANY, filters: true },
  decorators: [(Story) => <Seed><div className="mx-auto w-full max-w-6xl p-4"><Story /></div></Seed>],
} satisfies Meta<typeof PrototypeList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = { globals: { theme: "dark" } };
export const Light: Story = { globals: { theme: "light" } };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } } };
