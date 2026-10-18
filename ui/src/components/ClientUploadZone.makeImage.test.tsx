// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedImage } from "@greatstone/shared";
import { ClientUploadZone } from "./PipelineCaseFiles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const imagesApiMock = vi.hoisted(() => ({ status: vi.fn(), list: vi.fn(), create: vi.fn(), get: vi.fn(), remove: vi.fn() }));
const pipelinesApiMock = vi.hoisted(() => ({ uploadCaseEvidence: vi.fn() }));
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("../api/images", () => ({ imagesApi: imagesApiMock }));
vi.mock("../api/pipelines", () => ({ pipelinesApi: pipelinesApiMock }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));
vi.mock("../context/CompanyContext", () => ({ useOptionalCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/lib/router", () => ({ Link: () => null }));

const image: GeneratedImage = {
  id: "image-1",
  companyId: "company-1",
  prompt: "Proposal cover with a skyline",
  aspectRatio: "16:9",
  style: "client-proposal",
  camera: null,
  provider: "mock",
  model: "practice",
  status: "completed",
  error: null,
  assetId: "asset-1",
  contentPath: "/api/assets/asset-1/content",
  createdByAgentId: null,
  createdByUserId: "user-1",
  issue: null,
  organisation: { id: "org-1", name: "Acme" },
  altText: "Proposal cover with a skyline",
  issueCover: false,
  organisationCover: false,
  favourite: false,
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
};

let container: HTMLDivElement;
let root: Root;

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function byTestId<T extends HTMLElement>(id: string) {
  return document.body.querySelector(`[data-testid="${id}"]`) as T | null;
}

async function click(element: HTMLElement | null) {
  await act(async () => {
    element?.click();
  });
  await settle();
}

describe("Make an image from a client's files", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("links the image to the client and files it with their documents", async () => {
    imagesApiMock.status.mockResolvedValue({ configured: true, provider: "mock", providerLabel: "Practice mode", model: "practice" });
    imagesApiMock.create.mockResolvedValue(image);
    imagesApiMock.get.mockResolvedValue(image);
    pipelinesApiMock.uploadCaseEvidence.mockResolvedValue({ id: "evidence-1" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) })));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ClientUploadZone caseId="case-1" stageId="stage-1" organisationId="org-1" />
        </QueryClientProvider>,
      );
    });
    await settle();

    await click(byTestId("make-image-button"));
    const prompt = byTestId<HTMLTextAreaElement>("image-prompt")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Proposal cover with a skyline");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(byTestId("make-image-dialog-submit"));
    expect(imagesApiMock.create).toHaveBeenCalledWith("company-1", {
      prompt: "Proposal cover with a skyline",
      aspectRatio: "16:9",
      organisationId: "org-1",
    });

    await click(byTestId("make-image-dialog-attach"));
    expect(pipelinesApiMock.uploadCaseEvidence).toHaveBeenCalledTimes(1);
    const [caseId, file, options] = pipelinesApiMock.uploadCaseEvidence.mock.calls[0] as [string, File, { stageId: string }];
    expect(caseId).toBe("case-1");
    expect(file.name).toBe("proposal-cover-with-a-skyline.png");
    expect(options).toEqual({ stageId: "stage-1" });
    expect(document.body.textContent).toContain("Added to this client's files");
  });

  it("says so when the client upload is refused", async () => {
    imagesApiMock.status.mockResolvedValue({ configured: true, provider: "mock", providerLabel: "Practice mode", model: "practice" });
    imagesApiMock.create.mockResolvedValue(image);
    imagesApiMock.get.mockResolvedValue(image);
    pipelinesApiMock.uploadCaseEvidence.mockRejectedValue(new Error("Too large"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) })));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ClientUploadZone caseId="case-1" />
        </QueryClientProvider>,
      );
    });
    await settle();
    await click(byTestId("make-image-button"));
    const prompt = byTestId<HTMLTextAreaElement>("image-prompt")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Proposal cover");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(byTestId("make-image-dialog-submit"));
    await click(byTestId("make-image-dialog-attach"));
    expect(document.body.textContent).toContain("could not be added to this client");
    expect(document.body.textContent).not.toContain("Added to this client's files");
  });
});
