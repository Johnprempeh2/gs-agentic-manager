// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineCaseDetail, PipelineStage } from "../api/pipelines";
import { ClientCaseOverview } from "./ClientCaseOverview";
import { PipelineCaseContacts } from "./PipelineCaseContacts";

const mockPipelinesApi = vi.hoisted(() => ({
  listCaseContacts: vi.fn(),
  createCaseContact: vi.fn(),
  updateCaseContact: vi.fn(),
  deleteCaseContact: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/pipelines", () => ({ pipelinesApi: mockPipelinesApi }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

const stageNames = [
  "Lead",
  "Introduction",
  "Executive Discovery",
  "GITA",
  "Commercial commitment",
  "Deep Dive",
  "GDXP",
  "Implementation",
  "Live and expansion",
];
const stages: PipelineStage[] = [
  ...stageNames.map((name, index) => ({
    id: `stage-${index + 1}`,
    pipelineId: "pipe-1",
    key: name.toLowerCase().replace(/\s+/g, "_"),
    name,
    kind: index === 8 ? "done" : "working",
    position: index,
  })),
  { id: "stage-paused", pipelineId: "pipe-1", key: "paused", name: "Paused", kind: "cancelled", position: 9 },
  { id: "stage-lost", pipelineId: "pipe-1", key: "lost", name: "Lost", kind: "cancelled", position: 10 },
];

const contact = {
  id: "contact-1",
  companyId: "co-1",
  caseId: "case-1",
  name: "Ama Mensah",
  role: "CEO",
  phone: "+233 20 000 0000",
  email: "ama@example.com",
  position: 0,
  createdAt: "",
  updatedAt: "",
};

function caseDetail(fields: Record<string, unknown>, stageId = "stage-3"): PipelineCaseDetail {
  return {
    case: { id: "case-1", companyId: "co-1", pipelineId: "pipe-1", stageId, title: "Client A", fields },
    caseType: "client",
    stageEnteredAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
  } as PipelineCaseDetail;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(element: Element | null) {
  expect(element).not.toBeNull();
  flushSync(() => (element as HTMLElement).click());
}

describe("client case page", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render(node: ReactNode) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
    await flushReact();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("shows stage, record, contacts, open tasks and stage history on one page", async () => {
    mockPipelinesApi.listCaseContacts.mockResolvedValue([contact]);

    await render(
      <ClientCaseOverview
        detail={caseDetail({
          country: "Ghana",
          ownerPerson: "John",
          nextAction: "Kick-off with the CEO",
          nextActionDate: "2026-10-13",
          lastContact: "2026-10-05",
        })}
        stages={stages}
        events={[
          { id: "e1", companyId: "co-1", caseId: "case-1", type: "ingested", actorType: "user", toStageId: "stage-2", createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-01T10:00:00Z" },
          { id: "e2", companyId: "co-1", caseId: "case-1", type: "transitioned", actorType: "user", toStageId: "stage-3", createdAt: "2026-09-27T10:00:00Z", updatedAt: "2026-09-27T10:00:00Z" },
          { id: "e3", companyId: "co-1", caseId: "case-1", type: "updated", actorType: "user", createdAt: "2026-09-28T10:00:00Z", updatedAt: "2026-09-28T10:00:00Z" },
        ]}
        issueLinks={[
          { link: { id: "l1" }, issue: { id: "i1", identifier: "GRE-1", title: "Send the proposal", status: "todo" } },
          { link: { id: "l2" }, issue: { id: "i2", identifier: "GRE-2", title: "Old finished task", status: "done" } },
        ] as never}
      />,
    );

    const strip = container.querySelector('ol[aria-label="Client journey"]')!;
    // Nine journey stages; Paused and Lost stay off the strip.
    expect(strip.querySelectorAll("li")).toHaveLength(9);
    expect(strip.querySelector('[aria-current="step"]')?.textContent).toContain("Executive Discovery");
    expect(container.textContent).toContain("Stage 3 of 9");
    expect(container.textContent).toContain("12 days in stage");

    expect(container.textContent).toContain("Ghana");
    expect(container.textContent).toContain("John");
    expect(container.textContent).toContain("Kick-off with the CEO");

    expect(container.textContent).toContain("Ama Mensah");
    expect(container.querySelector('a[href="tel:+233200000000"]')).not.toBeNull();

    expect(container.textContent).toContain("Send the proposal");
    expect(container.textContent).not.toContain("Old finished task");

    const history = [...container.querySelectorAll("section")].find((section) => section.textContent?.startsWith("Stage history"));
    expect(history?.querySelectorAll("li")).toHaveLength(2);
  });

  it("shows Paused beside the strip instead of lighting a journey stage", async () => {
    mockPipelinesApi.listCaseContacts.mockResolvedValue([]);

    await render(<ClientCaseOverview detail={caseDetail({}, "stage-paused")} stages={stages} events={[]} issueLinks={[]} />);

    expect(container.querySelector('[aria-current="step"]')).toBeNull();
    expect(container.textContent).not.toContain("Stage 3 of 9");
    expect(container.textContent).toContain("Paused");
    expect(container.textContent).toContain("Not set");
  });

  it("puts linked projects with the client overview, before stage history", async () => {
    mockPipelinesApi.listCaseContacts.mockResolvedValue([]);

    await render(
      <ClientCaseOverview
        detail={caseDetail({})}
        stages={stages}
        events={[]}
        issueLinks={[]}
        projects={<p>Website rebuild</p>}
      />,
    );

    const titles = [...container.querySelectorAll("section > h2")].map((heading) => heading.textContent);
    expect(titles).toEqual(["Client record", "Contacts", "Open tasks", "Projects", "Stage history"]);
    expect(container.textContent).toContain("Website rebuild");
  });

  it("adds, edits and removes a contact", async () => {
    mockPipelinesApi.listCaseContacts.mockResolvedValue([contact]);
    mockPipelinesApi.createCaseContact.mockResolvedValue({});
    mockPipelinesApi.updateCaseContact.mockResolvedValue({});
    mockPipelinesApi.deleteCaseContact.mockResolvedValue({ deleted: true });

    await render(<PipelineCaseContacts caseId="case-1" />);

    click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add contact")) ?? null);
    typeInto(container.querySelector('input[aria-label="Name"]') as HTMLInputElement, "Kofi Owusu");
    typeInto(container.querySelector('input[aria-label="Phone"]') as HTMLInputElement, "+233 24 111 1111");
    click(container.querySelector('button[type="submit"]'));
    await flushReact();
    expect(mockPipelinesApi.createCaseContact).toHaveBeenCalledWith("case-1", {
      name: "Kofi Owusu",
      role: "",
      phone: "+233 24 111 1111",
      email: "",
    });

    click(container.querySelector('button[aria-label="Edit Ama Mensah"]'));
    typeInto(container.querySelector('input[aria-label="Role"]') as HTMLInputElement, "Chair");
    click(container.querySelector('button[type="submit"]'));
    await flushReact();
    expect(mockPipelinesApi.updateCaseContact).toHaveBeenCalledWith("case-1", "contact-1", expect.objectContaining({
      name: "Ama Mensah",
      role: "Chair",
    }));

    click(container.querySelector('button[aria-label="Remove Ama Mensah"]'));
    await flushReact();
    expect(mockPipelinesApi.deleteCaseContact).toHaveBeenCalledWith("case-1", "contact-1");
  });

  it("offers to copy contacts named in the case record into the list", async () => {
    mockPipelinesApi.listCaseContacts.mockResolvedValue([]);
    mockPipelinesApi.createCaseContact.mockResolvedValue({});

    await render(
      <PipelineCaseContacts
        caseId="case-1"
        recordFields={{ contacts: [{ name: "Ama Mensah", role: "CEO", phone: "", email: "" }, { role: "no name" }] }}
      />,
    );

    expect(container.textContent).toContain("The case record names 1 contact: Ama Mensah.");
    expect(mockPipelinesApi.createCaseContact).not.toHaveBeenCalled();
    click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Copy into the contact list")) ?? null);
    await flushReact();
    expect(mockPipelinesApi.createCaseContact).toHaveBeenCalledWith("case-1", {
      name: "Ama Mensah",
      role: "CEO",
      phone: null,
      email: null,
    });
  });
});
