// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedImage } from "@greatstone/shared";
import { CardCover, ImageCoverControls } from "./ImageCoverControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const imagesApiMock = vi.hoisted(() => ({ setCover: vi.fn(), covers: vi.fn() }));
vi.mock("../api/images", () => ({ imagesApi: imagesApiMock }));

function image(overrides: Partial<GeneratedImage> = {}): GeneratedImage {
  return {
    id: "image-1",
    companyId: "company-1",
    prompt: "Rocket on a launch pad",
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
    issue: { id: "issue-1", identifier: "GRE-12", title: "Launch deck" },
    organisation: { id: "org-1", name: "Acme" },
    altText: "Rocket on a launch pad",
    issueCover: false,
    organisationCover: true,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
}

function buttons() {
  return Array.from(container.querySelectorAll("button"));
}

describe("Use an image as a cover", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers the task and the client, and shows which is already the cover", async () => {
    imagesApiMock.setCover.mockResolvedValue(image({ issueCover: true }));
    await render(<ImageCoverControls image={image()} />);
    const [task, client] = buttons();
    expect(task!.textContent).toContain("Use as cover for GRE-12");
    expect(task!.getAttribute("aria-pressed")).toBe("false");
    expect(client!.textContent).toContain("Cover of Acme");
    expect(client!.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      task!.click();
    });
    expect(imagesApiMock.setCover).toHaveBeenCalledWith("image-1", { issueCover: true });
    await act(async () => {
      client!.click();
    });
    expect(imagesApiMock.setCover).toHaveBeenLastCalledWith("image-1", { organisationCover: false });
  });

  it("stays out of the way for images with no task or client, or not finished", async () => {
    await render(
      <>
        <ImageCoverControls image={image({ issue: null, organisation: null })} />
        <ImageCoverControls image={image({ status: "pending", contentPath: null })} />
      </>,
    );
    expect(container.querySelector("[data-testid='image-cover-controls']")).toBeNull();
  });

  it("draws the cover on a card as a decorative picture", async () => {
    await render(<CardCover cover={{ contentPath: "/api/assets/asset-1/content", altText: "Rocket" }} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/assets/asset-1/content");
    expect(img.getAttribute("alt")).toBe("");
  });
});
