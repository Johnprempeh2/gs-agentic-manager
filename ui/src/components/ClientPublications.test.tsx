// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientPublication, ClientPublicationsResponse } from "@greatstone/shared";
import { ClientPublications, publicationNextStep, timelineEntries } from "./ClientPublications";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  list: vi.fn(),
  approve: vi.fn(),
  publish: vi.fn(),
  submit: vi.fn(),
  create: vi.fn(),
}));
const session = vi.hoisted(() => ({ userId: "approver-user" }));
vi.mock("../api/clientPublications", () => ({ clientPublicationsApi: api }));
vi.mock("../api/pipelines", () => ({ pipelinesApi: { getCaseJourney: vi.fn().mockResolvedValue({ stages: [] }) } }));
vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn(async () => ({ user: { id: session.userId }, session: { userId: session.userId } })) },
}));
vi.mock("../api/access", () => ({ accessApi: { listMembers: vi.fn().mockResolvedValue({ members: [] }) } }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

function publication(patch: Partial<ClientPublication>): ClientPublication {
  return {
    id: "pub-1",
    caseId: "case-1",
    stageLinkId: "link-1",
    deliverableIssueId: "issue-1",
    deliverableKey: "north-star",
    title: "North Star summary",
    status: "pending_approval",
    workProductId: "wp-1",
    version: 1,
    latestVersion: 1,
    fingerprint: "a".repeat(64),
    approverUserId: "approver-user",
    approverName: "Ada Approver",
    submittedAt: "2026-10-25T09:00:00.000Z",
    approvedAt: null,
    approvedByName: null,
    rejectedReason: null,
    publishedAt: null,
    acceptanceLink: null,
    acceptedAt: null,
    acceptedName: null,
    acceptedRole: null,
    acceptedEmail: null,
    receipt: { status: "not_sent", sentAt: null, error: null },
    withdrawnAt: null,
    withdrawnReason: null,
    contentPath: "/api/attachments/att-1/content",
    url: null,
    events: [],
    createdAt: "2026-10-25T08:00:00.000Z",
    updatedAt: "2026-10-25T09:00:00.000Z",
    ...patch,
  };
}

function response(publications: ClientPublication[], patch: Partial<ClientPublicationsResponse> = {}): ClientPublicationsResponse {
  return {
    caseId: "case-1",
    approvers: [{ id: "ap-1", userId: "approver-user", name: "Ada Approver", email: null, createdAt: "2026-10-25T08:00:00.000Z" }],
    publications,
    gates: [],
    receiptSenderConfigured: true,
    ...patch,
  };
}

describe("publicationNextStep", () => {
  it("lets only the named approver approve", () => {
    const waiting = publication({});
    expect(publicationNextStep(waiting, { currentUserId: "approver-user", gates: [] })).toEqual({ kind: "approve" });
    expect(publicationNextStep(waiting, { currentUserId: "someone-else", gates: [] }))
      .toEqual({ kind: "waiting_for_approver", approverName: "Ada Approver" });
  });

  it("holds publishing behind the NDA and engagement, and offers a receipt resend", () => {
    expect(publicationNextStep(publication({ status: "approved" }), { currentUserId: null, gates: ["nda_required"] }))
      .toEqual({ kind: "blocked", gates: ["nda_required"] });
    expect(publicationNextStep(publication({ status: "approved" }), { currentUserId: null, gates: [] })).toEqual({ kind: "publish" });
    expect(publicationNextStep(
      publication({ status: "accepted", receipt: { status: "failed", sentAt: null, error: "Domain not verified" } }),
      { currentUserId: null, gates: [] },
    )).toEqual({ kind: "resend_receipt" });
  });
});

describe("timelineEntries", () => {
  it("merges stage moves and milestones, oldest first", () => {
    const entries = timelineEntries({
      caseId: "case-1",
      stages: [
        { stageId: "s1", name: "Executive Discovery", kind: "working", enteredAt: "2026-10-01T09:00:00.000Z", leftAt: "2026-10-05T09:00:00.000Z", current: false },
        { stageId: "s2", name: "Deep Dive", kind: "working", enteredAt: "2026-10-05T09:00:00.000Z", leftAt: null, current: true },
      ],
      milestones: [{ kind: "nda_accepted", at: "2026-10-02T09:00:00.000Z", label: "NDA accepted" }],
    });
    expect(entries.map((entry) => entry.label)).toEqual(["Entered Executive Discovery", "NDA accepted", "Entered Deep Dive"]);
    expect(entries[2]!.current).toBe(true);
  });
});

describe("ClientPublications", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    session.userId = "approver-user";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={client}>
        <ClientPublications caseId="case-1" companyId="company-1" />
      </QueryClientProvider>,
    ));
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain("Loading deliverables");
    });
  }

  const buttons = () => [...container.querySelectorAll("button")].map((button) => button.textContent?.trim());

  it("shows the approver an Approve button and approves the frozen version", async () => {
    api.list.mockResolvedValue(response([publication({})]));
    api.approve.mockResolvedValue({ id: "pub-1" });
    await render();
    await vi.waitFor(() => expect(buttons()).toContain("Approve version 1"));
    const approve = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Approve version 1"))!;
    await act(async () => approve.click());
    expect(api.approve).toHaveBeenCalledWith("pub-1");
  });

  it("tells anyone else who must approve, and shows a receipt that was not sent", async () => {
    session.userId = "someone-else";
    api.list.mockResolvedValue(response([
      publication({}),
      publication({
        id: "pub-2",
        deliverableKey: "gita",
        title: "GITA report",
        status: "accepted",
        acceptedName: "Ada Mensah",
        acceptedEmail: "ada@example.com",
        acceptedAt: "2026-10-25T10:00:00.000Z",
        receipt: { status: "not_configured", sentAt: null, error: "No sending key" },
      }),
    ], { receiptSenderConfigured: false }));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Waiting for Ada Approver to approve."));
    expect(buttons()).not.toContain("Approve version 1");
    expect(container.textContent).toContain("Receipt not sent: No sending key");
    expect(buttons()).toContain("Send the receipt again");
    expect(container.textContent).toContain('the company secret "client-receipts-resend" needs a Resend sending-only key');
  });

  it("holds an approved deliverable until the NDA and engagement allow publishing", async () => {
    api.list.mockResolvedValue(response([publication({ status: "approved" })], { gates: ["engagement_not_accepted"] }));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("The client must accept the engagement pack"));
    expect(buttons()).not.toContain("Publish to the client");
  });
});
