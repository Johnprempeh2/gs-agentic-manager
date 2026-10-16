// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientEngagement } from "@greatstone/shared";
import { fireFiles } from "../fixtures/fileEvents";
import { ClientEngagementRow, engagementSummary } from "./ClientEngagementRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ setCaseEngagement: vi.fn(), uploadEngagementFile: vi.fn() }));
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
});
