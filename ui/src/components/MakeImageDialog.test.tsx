// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedImage } from "@greatstone/shared";
import { MakeImageButton, generatedImageToFile } from "./MakeImageDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const imagesApiMock = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../api/images", () => ({ imagesApi: imagesApiMock }));

function image(overrides: Partial<GeneratedImage>): GeneratedImage {
  return {
    id: "image-1",
    companyId: "company-1",
    prompt: "A lighthouse at dawn",
    aspectRatio: "16:9",
    style: null,
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
    organisation: null,
    altText: "A test image",
    issueCover: false,
    organisationCover: false,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(onAttach: (file: File) => Promise<unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MakeImageButton companyId="company-1" issueId="issue-1" onAttach={onAttach} />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function setTextarea(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("Make an image from a task", () => {
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

  it("stays hidden while image making is switched off", async () => {
    imagesApiMock.status.mockResolvedValue({ configured: false, provider: null, providerLabel: null, model: null });
    await render(vi.fn());
    expect(byTestId("make-image-button")).toBeNull();
  });

  it("makes the image and adds it to the task as a file", async () => {
    imagesApiMock.status.mockResolvedValue({ configured: true, provider: "mock", providerLabel: "Practice mode", model: "practice" });
    imagesApiMock.create.mockResolvedValue(image({}));
    imagesApiMock.get.mockResolvedValue(image({}));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(["png-bytes"], { type: "image/png" }) })),
    );
    const onAttach = vi.fn(async () => ({ id: "attachment-1" }));
    await render(onAttach);

    await click(byTestId("make-image-button"));
    expect(byTestId("make-image-dialog")).not.toBeNull();
    const submit = byTestId<HTMLButtonElement>("make-image-dialog-submit")!;
    expect(submit.disabled).toBe(true);

    await act(async () => setTextarea(byTestId<HTMLTextAreaElement>("image-prompt")!, "A lighthouse at dawn"));
    await click(byTestId("make-image-dialog-submit"));
    expect(imagesApiMock.create).toHaveBeenCalledWith("company-1", {
      prompt: "A lighthouse at dawn",
      aspectRatio: "16:9",
      issueId: "issue-1",
    });

    await click(byTestId("make-image-dialog-attach"));
    expect(onAttach).toHaveBeenCalledTimes(1);
    const file = (onAttach.mock.calls[0] as unknown as [File])[0];
    expect(file.name).toBe("a-lighthouse-at-dawn.png");
    expect(file.type).toBe("image/png");
    expect(document.body.textContent).toContain("Added to this task");
  });

  it("says why an image failed and lets the person change the description", async () => {
    imagesApiMock.status.mockResolvedValue({ configured: true, provider: "higgsfield", providerLabel: "Higgsfield", model: "m" });
    const failed = image({ status: "failed", error: "The image service turned this description down.", contentPath: null, assetId: null });
    imagesApiMock.create.mockResolvedValue(failed);
    imagesApiMock.get.mockResolvedValue(failed);
    await render(vi.fn());

    await click(byTestId("make-image-button"));
    await act(async () => setTextarea(byTestId<HTMLTextAreaElement>("image-prompt")!, "Something refused"));
    await click(byTestId("make-image-dialog-submit"));

    expect(document.body.textContent).toContain("turned this description down");
    expect(byTestId<HTMLButtonElement>("make-image-dialog-attach")!.disabled).toBe(true);
    const retry = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Change and try again"),
    );
    await click(retry ?? null);
    expect(byTestId<HTMLTextAreaElement>("image-prompt")!.value).toBe("Something refused");
  });

  it("refuses to fetch an image that is not ready", async () => {
    await expect(generatedImageToFile(image({ status: "pending", contentPath: null }))).rejects.toThrow("not ready");
  });
});
