// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineCaseDetail, PipelineStage } from "../api/pipelines";
import { fireFiles } from "../fixtures/fileEvents";
import { ClientCaseOverview } from "./ClientCaseOverview";
import { ClientJourneyStages, ClientPortalPreview } from "./ClientJourneyStages";
import { PipelineCaseContacts } from "./PipelineCaseContacts";
import { PipelineCaseDeliverables, PipelineCaseEvidence } from "./PipelineCaseFiles";

const mockPipelinesApi = vi.hoisted(() => ({
  listCaseContacts: vi.fn(),
  createCaseContact: vi.fn(),
  updateCaseContact: vi.fn(),
  deleteCaseContact: vi.fn(),
  getCaseCrmSyncStatus: vi.fn(),
  getCaseFiles: vi.fn(),
  listCaseEvidenceCandidates: vi.fn(),
  addCaseEvidence: vi.fn(),
  uploadCaseEvidence: vi.fn(),
  removeCaseEvidence: vi.fn(),
  getCaseJourney: vi.fn(),
  getCasePortal: vi.fn(),
  fileCaseJourneyDeliverable: vi.fn(),
  updateCaseJourneyDeliverable: vi.fn(),
  removeCaseJourneyDeliverable: vi.fn(),
  uploadSignedNda: vi.fn(),
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
    mockPipelinesApi.getCaseCrmSyncStatus.mockResolvedValue({ caseId: "case-1", sources: [] });
    mockPipelinesApi.getCaseFiles.mockResolvedValue({ clients: [], evidence: [], deliverables: [] });
    mockPipelinesApi.getCaseJourney.mockResolvedValue({ caseId: "case-1", ndaAcceptedAt: null, stages: [], unfiled: [] });
    mockPipelinesApi.getCasePortal.mockResolvedValue({ caseId: "case-1", title: "Client", stages: [] });
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
    expect(titles).toEqual([
      "Client record",
      "Contacts",
      "Evidence",
      "Journey by stage",
      "What the client sees on the portal",
      "Open tasks",
      "Projects",
      "Stage history",
    ]);
    expect(container.textContent).toContain("Website rebuild");
  });

  it("lists each stage with its templates and deliverables, and files, flags and moves them", async () => {
    const deliverable = (id: string, title: string, status: "draft" | "final" = "final") => ({
      id,
      key: id,
      title,
      kind: "report",
      status,
      version: 1,
      updatedAt: "2026-10-10T10:00:00Z",
      openPath: `/GRE/issues/GRE-${id}#deliverable`,
      issue: { id: `issue-${id}`, identifier: `GRE-${id}`, title: `Task ${id}` },
    });
    mockPipelinesApi.getCaseJourney.mockResolvedValue({
      caseId: "case-1",
      stages: [
        {
          id: "stage-3",
          key: "executive_discovery",
          name: "Executive Discovery",
          kind: "working",
          position: 2,
          state: "done",
          templates: [{ title: "Pre-read template", url: "https://example.com/pre-read", note: null }],
          deliverables: [{ linkId: "link-1", stageId: "stage-3", clientFacing: true, deliverable: deliverable("1", "North Star summary") }],
          expected: [],
        },
        {
          id: "stage-4",
          key: "gita",
          name: "GITA",
          kind: "working",
          position: 3,
          state: "current",
          templates: [],
          deliverables: [],
          expected: [],
        },
      ],
      unfiled: [deliverable("2", "GITA draft", "draft")],
    });
    mockPipelinesApi.fileCaseJourneyDeliverable.mockResolvedValue({ id: "link-2" });
    mockPipelinesApi.updateCaseJourneyDeliverable.mockResolvedValue({ id: "link-1" });

    await render(<ClientJourneyStages caseId="case-1" />);

    const discovery = container.querySelector('section[aria-labelledby="journey-stage-stage-3"]')!;
    expect(discovery.textContent).toContain("Complete");
    expect(discovery.querySelector('a[href="https://example.com/pre-read"]')?.textContent).toBe("Pre-read template");
    expect(discovery.textContent).toContain("North Star summary");
    const gita = container.querySelector('section[aria-labelledby="journey-stage-stage-4"]')!;
    expect(gita.textContent).toContain("Now");
    expect(gita.textContent).toContain("Nothing in this stage yet.");
    expect(gita.querySelector('[data-testid="client-upload-zone"]')?.textContent).toContain("Upload to this stage");

    click(container.querySelector('button[aria-label="Client can see North Star summary"]'));
    await flushReact();
    expect(mockPipelinesApi.updateCaseJourneyDeliverable).toHaveBeenCalledWith("case-1", "link-1", { clientFacing: false });

    const stageSelect = container.querySelector('select[aria-label="Stage for North Star summary"]') as HTMLSelectElement;
    stageSelect.value = "stage-4";
    stageSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await flushReact();
    expect(mockPipelinesApi.updateCaseJourneyDeliverable).toHaveBeenCalledWith("case-1", "link-1", { stageId: "stage-4" });

    click([...container.querySelectorAll("button")].find((button) => button.textContent === "1 deliverable is not in a stage") ?? null);
    await flushReact();
    expect(container.textContent).toContain("Draft");
    const fileSelect = container.querySelector('select[aria-label="File GITA draft under a stage"]') as HTMLSelectElement;
    fileSelect.value = "stage-4";
    fileSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await flushReact();
    expect(mockPipelinesApi.fileCaseJourneyDeliverable).toHaveBeenCalledWith("case-1", { stageId: "stage-4", deliverableId: "2" });
  });

  it("shows a stage's uploaded files and uploads straight to the stage", async () => {
    mockPipelinesApi.getCaseJourney.mockResolvedValue({
      caseId: "case-1",
      ndaAcceptedAt: null,
      stages: [
        { id: "stage-2", key: "document_request", name: "Document request", kind: "working", position: 2, state: "current", templates: [], deliverables: [], expected: [] },
        { id: "stage-5", key: "playback", name: "Playback", kind: "working", position: 5, state: "next", templates: [], deliverables: [], expected: [] },
      ],
      unfiled: [],
    });
    mockPipelinesApi.getCaseFiles.mockResolvedValue({
      clients: [],
      deliverables: [],
      evidence: [
        {
          id: "ev-9", caseId: "case-1", kind: "upload", title: "Org chart.pdf", typeLabel: "PDF", note: null,
          contentType: "application/pdf", byteSize: 51_200, originalFilename: "Org chart.pdf",
          attachmentId: null, documentId: null, documentKey: null, assetId: "asset-9",
          stageId: "stage-2", stageName: "Document request", url: null,
          contentPath: "/api/cases/case-1/evidence/ev-9/content", downloadPath: null,
          openPath: "/api/cases/case-1/evidence/ev-9/content", sourceIssue: null, addedBy: null,
          createdAt: "2026-10-15T09:00:00Z",
        },
      ],
    });
    mockPipelinesApi.uploadCaseEvidence.mockResolvedValue({ id: "ev-10" });

    await render(<ClientJourneyStages caseId="case-1" />);
    const request = container.querySelector('section[aria-labelledby="journey-stage-stage-2"]')!;
    expect(request.querySelector('a[href="/api/cases/case-1/evidence/ev-9/content"]')?.textContent).toBe("Org chart.pdf");
    expect(request.textContent).toContain("50 KB");
    // A stage not started yet stays quiet: no upload box until it has files.
    const playback = container.querySelector('section[aria-labelledby="journey-stage-stage-5"]')!;
    expect(playback.querySelector('[data-testid="client-upload-zone"]')).toBeNull();

    const input = request.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "Finance pack.xlsx", { type: "application/vnd.ms-excel" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    flushSync(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    await flushReact();
    expect(mockPipelinesApi.uploadCaseEvidence).toHaveBeenCalledWith("case-1", file, { stageId: "stage-2" });
  });

  it("takes the signed NDA as an upload and shows it", async () => {
    mockPipelinesApi.getCaseJourney.mockResolvedValue({
      caseId: "case-1",
      ndaAcceptedAt: "2026-10-15T10:00:00Z",
      nda: {
        status: "accepted",
        acceptedAt: "2026-10-15T10:00:00Z",
        suspendedReason: null,
        changedBy: "John",
        changedAt: "2026-10-15T10:00:00Z",
        signedDocument: {
          evidenceId: "ev-nda",
          title: "Signed NDA (Omni.pdf)",
          contentPath: "/api/cases/case-1/evidence/ev-nda/content",
          uploadedAt: "2026-10-15T10:00:00Z",
        },
      },
      stages: [],
      unfiled: [],
    });
    mockPipelinesApi.uploadSignedNda.mockResolvedValue({});

    await render(<ClientJourneyStages caseId="case-1" />);
    const signed = container.querySelector('[data-testid="journey-nda-signed"]')!;
    expect(signed.querySelector("a")?.getAttribute("href")).toBe("/api/cases/case-1/evidence/ev-nda/content");
    expect(container.textContent).toContain("Replace the signed NDA");

    const input = container.querySelector('input[aria-label="Upload the signed NDA"]') as HTMLInputElement;
    const file = new File(["%PDF"], "Omni v2.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    flushSync(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    expect(mockPipelinesApi.uploadSignedNda.mock.calls[0]?.[0]).toBe("case-1");
    expect(mockPipelinesApi.uploadSignedNda.mock.calls[0]?.[1]).toBe(file);
  });

  it("previews only what the portal returns, and says when the client sees nothing", async () => {
    await render(<ClientPortalPreview caseId="case-1" />);
    expect(container.textContent).toContain("The client sees nothing yet.");
    flushSync(() => root?.unmount());

    mockPipelinesApi.getCasePortal.mockResolvedValue({
      caseId: "case-1",
      title: "Client",
      stages: [
        { key: "executive_discovery", name: "Executive Discovery", deliverables: [{ title: "North Star summary", kind: "report", version: 2, summary: null, contentType: "text/html", updatedAt: "2026-10-10T10:00:00Z", contentPath: "/api/attachments/a/content" }] },
        { key: "gita", name: "GITA", deliverables: [] },
      ],
    });
    await render(<ClientPortalPreview caseId="case-1" />);
    expect(container.textContent).toContain("Executive Discovery");
    expect(container.textContent).toContain("North Star summary");
    expect(container.textContent).toContain("Version 2");
    // A completed stage with nothing client-facing is left out.
    expect(container.textContent).not.toContain("GITA");
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
  it("lists evidence with its type, date, who added it and the source task", async () => {
    mockPipelinesApi.getCaseFiles.mockResolvedValue({
      clients: [{ id: "case-1", title: "Client A", pipelineId: "pipe-1" }],
      evidence: [
        {
          id: "ev-1",
          caseId: "case-1",
          kind: "attachment",
          title: "ecaps-outline.pdf",
          note: null,
          typeLabel: "PDF",
          contentType: "application/pdf",
          byteSize: 10,
          originalFilename: "ecaps-outline.pdf",
          attachmentId: "att-1",
          documentId: null,
          documentKey: null,
          url: null,
          contentPath: "/api/attachments/att-1/content",
          downloadPath: "/api/attachments/att-1/content?download=1",
          openPath: "/api/attachments/att-1/content",
          sourceIssue: { id: "i1", identifier: "GRE-1128", title: "Kick-off", path: "/GRE/issues/GRE-1128" },
          addedBy: { type: "user", id: "u1", name: "John" },
          createdAt: "2026-10-11T10:00:00Z",
        },
      ],
      deliverables: [
        {
          id: "d1",
          title: "Market entry report",
          kind: "report",
          openPath: "/api/attachments/att-2/content",
          createdAt: "2026-10-11T10:00:00Z",
          createdByAgent: { id: "a1", name: "Everest" },
          issue: { id: "i2", identifier: "GRE-1259", title: "Report" },
        },
      ],
    });

    await render(
      <>
        <PipelineCaseEvidence caseId="case-1" />
        <PipelineCaseDeliverables caseId="case-1" />
      </>,
    );

    const file = container.querySelector('a[href="/api/attachments/att-1/content"]');
    expect(file?.textContent).toBe("ecaps-outline.pdf");
    expect(file?.getAttribute("target")).toBe("_blank");
    expect(container.textContent).toContain("PDF");
    expect(container.textContent).toContain("Added by John");
    expect(container.querySelector('a[href="/issues/GRE-1128"]')?.textContent).toBe("GRE-1128");
    expect(container.textContent).toContain("Market entry report");
    expect(container.textContent).toContain("Added by Everest");
    expect(container.querySelector('a[href="/issues/GRE-1259"]')).not.toBeNull();
  });

  it("adds a task file and a link to evidence", async () => {
    mockPipelinesApi.listCaseEvidenceCandidates.mockResolvedValue({
      candidates: [
        {
          kind: "attachment",
          attachmentId: "att-1",
          documentId: null,
          title: "ecaps-outline.pdf",
          typeLabel: "PDF",
          sourceIssue: { id: "i1", identifier: "GRE-1128", title: "Kick-off", path: "/GRE/issues/GRE-1128" },
          createdAt: "2026-10-11T10:00:00Z",
        },
      ],
    });
    mockPipelinesApi.addCaseEvidence.mockResolvedValue({});

    await render(<PipelineCaseEvidence caseId="case-1" />);
    expect(container.textContent).toContain("No files yet");

    click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add from tasks or a link")) ?? null);
    await flushReact();
    click([...container.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null);
    await flushReact();
    expect(mockPipelinesApi.addCaseEvidence).toHaveBeenCalledWith("case-1", { kind: "attachment", attachmentId: "att-1" });

    typeInto(container.querySelector('input[aria-label="Link name"]') as HTMLInputElement, "Notion brief");
    typeInto(container.querySelector('input[aria-label="Link address"]') as HTMLInputElement, "https://www.notion.so/brief");
    click(container.querySelector('button[type="submit"]'));
    await flushReact();
    expect(mockPipelinesApi.addCaseEvidence).toHaveBeenCalledWith("case-1", {
      kind: "link",
      title: "Notion brief",
      url: "https://www.notion.so/brief",
    });
  });

  it("asks before removing an item from evidence", async () => {
    mockPipelinesApi.getCaseFiles.mockResolvedValue({
      evidence: [
        {
          id: "ev-1",
          kind: "link",
          title: "Notion brief",
          typeLabel: "Link",
          note: null,
          attachmentId: null,
          documentId: null,
          documentKey: null,
          url: "https://www.notion.so/brief",
          contentPath: null,
          downloadPath: null,
          openPath: "https://www.notion.so/brief",
          sourceIssue: null,
          addedBy: null,
          createdAt: "2026-10-11T10:00:00Z",
        },
      ],
      deliverables: [],
    });
    mockPipelinesApi.removeCaseEvidence.mockResolvedValue({});

    await render(<PipelineCaseEvidence caseId="case-1" />);
    click(document.querySelector('button[aria-label="Remove Notion brief from evidence"]'));
    await flushReact();
    expect(mockPipelinesApi.removeCaseEvidence).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Remove from evidence?");

    click([...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === "Remove") ?? null);
    await flushReact();
    expect(mockPipelinesApi.removeCaseEvidence).toHaveBeenCalledWith("case-1", "ev-1");
  });
  it("uploads dropped or chosen files straight onto the client", async () => {
    mockPipelinesApi.getCaseFiles.mockResolvedValue({ evidence: [], deliverables: [] });
    mockPipelinesApi.uploadCaseEvidence.mockResolvedValue({ id: "ev-up" });

    await render(<PipelineCaseEvidence caseId="case-1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const nda = new File(["%PDF"], "Signed NDA.pdf", { type: "application/pdf" });
    const deck = new File(["deck"], "GITA.pptx", { type: "application/vnd.ms-powerpoint" });
    Object.defineProperty(input, "files", { value: [nda, deck], configurable: true });
    flushSync(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    await flushReact();
    expect(mockPipelinesApi.uploadCaseEvidence).toHaveBeenCalledTimes(2);
    expect(mockPipelinesApi.uploadCaseEvidence).toHaveBeenNthCalledWith(1, "case-1", nda, { stageId: undefined });
    expect(mockPipelinesApi.uploadCaseEvidence).toHaveBeenNthCalledWith(2, "case-1", deck, { stageId: undefined });
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 files uploaded" }));

    // A screenshot pasted on the box lands on the client with a readable name.
    const zone = container.querySelector('[data-testid="client-upload-zone"]')!;
    fireFiles(zone, "paste", [new File(["png"], "image.png", { type: "image/png" })]);
    await flushReact();
    await flushReact();
    expect(mockPipelinesApi.uploadCaseEvidence).toHaveBeenCalledTimes(3);
    expect((mockPipelinesApi.uploadCaseEvidence.mock.calls[2]?.[1] as File).name).toMatch(/^Pasted image .+\.png$/);
  });

  it("shows an upload's size and stage, and says it will be deleted", async () => {
    mockPipelinesApi.getCaseFiles.mockResolvedValue({
      evidence: [
        {
          id: "ev-2",
          caseId: "case-1",
          kind: "upload",
          title: "Executive discovery.pdf",
          typeLabel: "PDF",
          note: null,
          contentType: "application/pdf",
          byteSize: 2_516_582,
          originalFilename: "Executive discovery.pdf",
          attachmentId: null,
          documentId: null,
          documentKey: null,
          assetId: "asset-1",
          stageId: "stage-1",
          stageName: "Executive discovery",
          url: null,
          contentPath: "/api/cases/case-1/evidence/ev-2/content",
          downloadPath: "/api/cases/case-1/evidence/ev-2/content?download=1",
          openPath: "/api/cases/case-1/evidence/ev-2/content",
          sourceIssue: null,
          addedBy: null,
          createdAt: "2026-10-15T10:00:00Z",
        },
      ],
      deliverables: [],
    });
    mockPipelinesApi.removeCaseEvidence.mockResolvedValue({});

    await render(<PipelineCaseEvidence caseId="case-1" />);
    expect(container.textContent).toContain("2.4 MB");
    expect(container.textContent).toContain("Stage: Executive discovery");
    expect(container.querySelector('a[href="/api/cases/case-1/evidence/ev-2/content"]')).not.toBeNull();
    click(document.querySelector('button[aria-label="Remove Executive discovery.pdf from evidence"]'));
    await flushReact();
    expect(document.body.textContent).toContain("so it will be deleted");
    click([...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === "Delete") ?? null);
    await flushReact();
    expect(mockPipelinesApi.removeCaseEvidence).toHaveBeenCalledWith("case-1", "ev-2");
  });
});
