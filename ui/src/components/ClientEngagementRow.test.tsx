// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientEngagement } from "@greatstone/shared";
import { fireFiles } from "../fixtures/fileEvents";
import { ClientEngagementRow, engagementSummary, onlineLinkSummary } from "./ClientEngagementRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  setCaseEngagement: vi.fn(),
  uploadEngagementFile: vi.fn(),
  createEngagementLink: vi.fn(),
  revokeEngagementLink: vi.fn(),
}));
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/pipelines", () => ({ pipelinesApi: api }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));

const notSent: ClientEngagement = {
  status: "not_sent",
  sentAt: null,
  acceptedAt: null,
  changedBy: null,
  changedAt: null,
  pack: null,
  acceptance: null,
};

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ClientEngagementRow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(engagement: ClientEngagement | undefined, ndaCleared: boolean) {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={client}>
        <ClientEngagementRow caseId="case-1" engagement={engagement} ndaCleared={ndaCleared} />
      </QueryClientProvider>,
    ));
  }
  const radio = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("[role='radio']")].find((entry) => entry.textContent === label)!;
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === label);

  it("waits for the NDA before the pack can go out", () => {
    render(undefined, false);
    expect(radio("Not sent").getAttribute("aria-checked")).toBe("true");
    expect(radio("Sent").disabled).toBe(true);
    expect(radio("Accepted").disabled).toBe(true);
    expect(container.textContent).toContain("Waiting for the NDA");
    expect(button("Upload the pack")).toBeUndefined();
  });

  it("uploads the pack once the NDA clears, and marks it accepted", async () => {
    api.uploadEngagementFile.mockResolvedValue({ engagement: notSent });
    api.setCaseEngagement.mockResolvedValue({ engagement: notSent });
    render(notSent, true);
    expect(container.textContent).toContain("Ready to send");

    const input = container.querySelector<HTMLInputElement>("input[aria-label='Upload the engagement pack']")!;
    const file = new File(["%PDF"], "pack.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(api.uploadEngagementFile).toHaveBeenCalledWith("case-1", "pack", file);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Engagement pack saved and marked sent" }));

    act(() => radio("Accepted").click());
    await flush();
    expect(api.setCaseEngagement).toHaveBeenCalledWith("case-1", "accepted");
  });

  it("files a dropped document as the pack before it is sent, and as the acceptance after", async () => {
    api.uploadEngagementFile.mockResolvedValue({ engagement: notSent });
    render(notSent, true);
    const pack = new File(["%PDF"], "pack.pdf", { type: "application/pdf" });
    fireFiles(container.querySelector("[aria-label='Drop or paste the engagement pack here']")!, "drop", [pack]);
    await flush();
    expect(api.uploadEngagementFile).toHaveBeenLastCalledWith("case-1", "pack", pack);

    render({ ...notSent, status: "sent", sentAt: "2026-10-14T09:00:00.000Z" }, true);
    const signed = new File(["%PDF"], "signed.pdf", { type: "application/pdf" });
    fireFiles(container.querySelector("[aria-label='Drop or paste the signed acceptance here']")!, "drop", [signed]);
    await flush();
    expect(api.uploadEngagementFile).toHaveBeenLastCalledWith("case-1", "acceptance", signed);
  });

  it("shows the pack and the signed acceptance with their dates", () => {
    const accepted: ClientEngagement = {
      ...notSent,
      status: "accepted",
      sentAt: "2026-10-14T09:00:00.000Z",
      acceptedAt: "2026-10-15T09:00:00.000Z",
      pack: { evidenceId: "ev-1", title: "Engagement pack (Pack.pdf)", contentPath: "/api/cases/case-1/evidence/ev-1/content", uploadedAt: "2026-10-14T09:00:00.000Z" },
      acceptance: { evidenceId: "ev-2", title: "Signed engagement acceptance (Signed.pdf)", contentPath: "/api/cases/case-1/evidence/ev-2/content", uploadedAt: "2026-10-15T09:00:00.000Z" },
    };
    render(accepted, true);
    expect(container.querySelector("a[href='/api/cases/case-1/evidence/ev-2/content']")?.textContent).toBe(
      "Signed engagement acceptance (Signed.pdf)",
    );
    expect(button("Upload the pack")).toBeUndefined();
    expect(button("Replace the signed acceptance")).toBeDefined();
    expect(engagementSummary(accepted, true)).toMatch(/^Accepted .+, sent .+\.$/);
  });

  const sentWithPack: ClientEngagement = {
    ...notSent,
    status: "sent",
    sentAt: "2026-10-10T09:00:00.000Z",
    pack: { evidenceId: "ev-1", title: "Pack.pdf", contentPath: "/api/x", uploadedAt: "2026-10-10T09:00:00.000Z" },
  };

  it("makes an online acceptance link and shows it once to copy", async () => {
    api.createEngagementLink.mockResolvedValue({
      url: "https://gsam.example.com/accept/gsa_accept_abc",
      path: "/accept/gsa_accept_abc",
      link: { id: "l1", createdAt: "2026-10-16T09:00:00.000Z", expiresAt: "2026-11-15T09:00:00.000Z", expired: false, acceptedAt: null, acceptedName: null, acceptedRole: null, acceptedEmail: null },
    });
    render(sentWithPack, true);
    const online = container.querySelector("[data-testid='journey-engagement-online']")!;
    expect(online.textContent).toContain("accept it without signing in");
    const make = [...online.querySelectorAll("button")].find((button) => button.textContent?.includes("Make an acceptance link"))!;
    await act(async () => make.click());
    await flush();
    expect(api.createEngagementLink).toHaveBeenCalledWith("case-1");
    const url = container.querySelector<HTMLInputElement>("[data-testid='journey-engagement-online-url']")!;
    expect(url.value).toBe("https://gsam.example.com/accept/gsa_accept_abc");
  });

  it("hides the online link until the pack is uploaded and the NDA cleared", () => {
    render(notSent, true);
    expect(container.querySelector("[data-testid='journey-engagement-online']")).toBeNull();
    render(sentWithPack, false);
    expect(container.querySelector("[data-testid='journey-engagement-online']")).toBeNull();
  });

  it("says who accepted online", () => {
    const link = {
      id: "l1",
      createdAt: "2026-10-16T09:00:00.000Z",
      expiresAt: "2026-11-15T09:00:00.000Z",
      expired: false,
      acceptedAt: "2026-10-17T09:00:00.000Z",
      acceptedName: "Ada Mensah",
      acceptedRole: "Chief Executive",
      acceptedEmail: "ada@omni.com",
    };
    expect(onlineLinkSummary(link)).toMatch(/^Accepted online by Ada Mensah, Chief Executive \(ada@omni\.com\) on /);
    render({ ...sentWithPack, status: "accepted", acceptedAt: link.acceptedAt, onlineLink: link }, true);
    expect(container.querySelector("[data-testid='journey-engagement-online']")!.textContent).toContain("Ada Mensah");
    expect(onlineLinkSummary({ ...link, acceptedAt: null, expired: true })).toContain("expired");
  });
});
