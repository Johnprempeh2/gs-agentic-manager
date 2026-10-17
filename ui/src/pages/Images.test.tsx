// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedImage } from "@greatstone/shared";
import { Images, IMAGE_IDEA_STARTERS } from "./Images";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const imagesApiMock = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../api/images", () => ({ imagesApi: imagesApiMock }));
vi.mock("../api/organisations", () => ({
  organisationsApi: { list: vi.fn(async () => [{ id: "org-1", name: "Ethical Quest" }]) },
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, title, className }: { to: string; children: ReactNode; title?: string; className?: string }) =>
    createElement("a", { href: to, title, className }, children),
}));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(async () => [{ id: "agent-1", name: "Everest" }]) } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: vi.fn(async () => ({ user: { id: "user-1" } })) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useOptionalToastActions: () => ({ pushToast: vi.fn() }) }));

function image(overrides: Partial<GeneratedImage>): GeneratedImage {
  return {
    id: "image-1",
    companyId: "company-1",
    prompt: "A lighthouse at dawn",
    aspectRatio: "16:9",
    style: null,
    camera: null,
    provider: "higgsfield",
    model: "higgsfield-ai/soul/standard",
    status: "completed",
    error: null,
    assetId: "asset-1",
    contentPath: "/api/assets/asset-1/content",
    createdByAgentId: "agent-1",
    createdByUserId: null,
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

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Images />
      </QueryClientProvider>,
    );
  });
  // Let the queries settle.
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function setTextarea(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Images page", () => {
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

  it("explains in plain words when image making is off", async () => {
    imagesApiMock.status.mockResolvedValue({ configured: false, provider: null, providerLabel: null, model: null });
    imagesApiMock.list.mockResolvedValue({ images: [], total: 0, nextOffset: null });
    await render();

    expect(container.querySelector('[data-testid="images-not-set-up"]')?.textContent).toContain("not switched on yet");
    expect(container.querySelector('[data-testid="images-get-key-link"]')?.getAttribute("href")).toBe("https://console.higgsfield.ai");
    expect((container.querySelector('[data-testid="image-prompt"]') as HTMLTextAreaElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="make-image"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain("No images yet");
  });

  it("fills the description from an idea and makes the image in the chosen shape", async () => {
    imagesApiMock.status.mockResolvedValue({ configured: true, provider: "higgsfield", providerLabel: "Higgsfield", model: "m" });
    imagesApiMock.list.mockResolvedValue({ images: [], total: 0, nextOffset: null });
    imagesApiMock.create.mockResolvedValue(image({ id: "image-2", status: "pending", contentPath: null, assetId: null }));
    await render();

    expect(container.textContent).toContain("Using Higgsfield");
    const starter = IMAGE_IDEA_STARTERS.find((item) => item.label === "Event poster")!;
    const starterButton = [...container.querySelectorAll("button")].find((button) => button.textContent === starter.label)!;
    await act(async () => starterButton.click());
    const textarea = container.querySelector('[data-testid="image-prompt"]') as HTMLTextAreaElement;
    expect(textarea.value).toBe(starter.prompt);
    expect(container.querySelector('[aria-label="Shape"] [role="radio"][aria-checked="true"]')?.textContent).toContain("Portrait");

    await act(async () => setTextarea(textarea, "  A red bicycle by a canal  "));
    const wide = [...container.querySelectorAll('[role="radio"]')].find((button) => button.textContent?.startsWith("Wide")) as HTMLButtonElement;
    await act(async () => wide.click());
    await act(async () => (container.querySelector('[data-testid="make-image"]') as HTMLButtonElement).click());

    expect(imagesApiMock.create).toHaveBeenCalledWith("company-1", {
      prompt: "A red bicycle by a canal",
      aspectRatio: "16:9",
      style: null,
      organisationId: null,
    });
  });

  it("applies a style with its usual shape and the chosen client", async () => {
    imagesApiMock.status.mockResolvedValue({ configured: true, provider: "higgsfield", providerLabel: "Higgsfield", model: "m" });
    imagesApiMock.list.mockResolvedValue({ images: [], total: 0, nextOffset: null });
    imagesApiMock.create.mockResolvedValue(image({ id: "image-3", status: "pending", contentPath: null, assetId: null }));
    await render();

    const styles = container.querySelector('[data-testid="image-style-picker"]')!;
    const brand = [...styles.querySelectorAll("button")].find((button) => button.textContent === "Greatstone brand")!;
    await act(async () => brand.click());
    expect(brand.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[aria-label="Shape"] [role="radio"][aria-checked="true"]')?.textContent).toContain("Wide");
    expect(container.textContent).toContain("Charcoal and neon lime");

    const client = container.querySelector('[data-testid="image-client"]') as HTMLSelectElement;
    await act(async () => {
      client.value = "org-1";
      client.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => setTextarea(container.querySelector('[data-testid="image-prompt"]') as HTMLTextAreaElement, "A mountain path"));
    await act(async () => (container.querySelector('[data-testid="make-image"]') as HTMLButtonElement).click());

    expect(imagesApiMock.create).toHaveBeenCalledWith("company-1", {
      prompt: "A mountain path",
      aspectRatio: "16:9",
      style: "greatstone-brand",
      organisationId: "org-1",
    });
  });

  it("adds finishing touches and a camera look, and makes several versions", async () => {
    imagesApiMock.status.mockResolvedValue({ configured: true, provider: "higgsfield", providerLabel: "Higgsfield", model: "m" });
    imagesApiMock.list.mockResolvedValue({ images: [], total: 0, nextOffset: null });
    imagesApiMock.create.mockResolvedValue(image({ id: "image-4", status: "pending", contentPath: null, assetId: null }));
    await render();

    const textarea = container.querySelector('[data-testid="image-prompt"]') as HTMLTextAreaElement;
    await act(async () => setTextarea(textarea, "A chef plating dessert"));
    const golden = container.querySelector('[aria-label="Add golden hour"]') as HTMLButtonElement;
    await act(async () => golden.click());
    expect((container.querySelector('[data-testid="image-prompt"]') as HTMLTextAreaElement).value).toBe(
      "A chef plating dessert, golden hour",
    );
    expect((container.querySelector('[aria-label="golden hour (added)"]') as HTMLButtonElement).disabled).toBe(true);

    const filmStill = [...container.querySelectorAll('[aria-label="Camera looks"] button')].find(
      (button) => button.textContent === "Film still",
    ) as HTMLButtonElement;
    await act(async () => filmStill.click());
    expect(filmStill.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-testid="studio-camera"] summary')?.textContent).toContain("Grand Format 70mm Film");

    const four = [...container.querySelectorAll('[data-testid="image-variations"] [role="radio"]')].find(
      (button) => button.textContent === "4",
    ) as HTMLButtonElement;
    await act(async () => four.click());
    expect(container.querySelector('[data-testid="make-image"]')?.textContent).toContain("Make 4 images");
    await act(async () => (container.querySelector('[data-testid="make-image"]') as HTMLButtonElement).click());
    for (let index = 0; index < 5; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(imagesApiMock.create).toHaveBeenCalledTimes(4);
    expect(imagesApiMock.create).toHaveBeenCalledWith("company-1", {
      prompt: "A chef plating dessert, golden hour",
      aspectRatio: "1:1",
      style: null,
      camera: { camera: "70mm-film", lens: "classic-anamorphic", focalLength: 35, aperture: "f1.4" },
      organisationId: null,
    });
  });

  it("searches the gallery and links each image to its task and client", async () => {
    imagesApiMock.status.mockResolvedValue({ configured: true, provider: "higgsfield", providerLabel: "Higgsfield", model: "m" });
    imagesApiMock.list.mockResolvedValue({
      images: [
        image({
          id: "linked",
          style: "social-post",
          issue: { id: "issue-1", identifier: "GRE-12", title: "Spring campaign" },
          organisation: { id: "org-1", name: "Ethical Quest" },
        }),
      ],
      total: 1,
      nextOffset: null,
    });
    await render();

    const card = container.querySelector('[data-testid="generated-image-card"]')!;
    expect(card.textContent).toContain("Social post");
    expect(card.textContent).toContain("Ethical Quest");
    expect(card.querySelector("a[href='/issues/GRE-12']")?.textContent).toContain("Spring campaign");

    imagesApiMock.list.mockResolvedValue({ images: [], total: 0, nextOffset: null });
    const search = container.querySelector('[data-testid="image-search"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(search, "lighthouse");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    for (let index = 0; index < 5; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(imagesApiMock.list).toHaveBeenLastCalledWith("company-1", { limit: 120, q: "lighthouse", organisationId: undefined });
    expect(container.textContent).toContain("No images match");
  });

  it("shows finished, in-progress and failed images with who made them", async () => {
    imagesApiMock.status.mockResolvedValue({ configured: true, provider: "higgsfield", providerLabel: "Higgsfield", model: "m" });
    imagesApiMock.list.mockResolvedValue({
      images: [
        image({ id: "a" }),
        image({ id: "b", status: "pending", contentPath: null, assetId: null, createdByAgentId: null, createdByUserId: "user-1" }),
        image({ id: "c", status: "failed", contentPath: null, assetId: null, error: "The Higgsfield account has run out of credits." }),
      ],
      total: 3,
      nextOffset: null,
    });
    await render();

    const cards = container.querySelectorAll('[data-testid="generated-image-card"]');
    expect(cards).toHaveLength(3);
    expect(cards[0]!.querySelector("img")?.getAttribute("src")).toBe("/api/assets/asset-1/content");
    expect(cards[0]!.textContent).toContain("Everest");
    expect(cards[1]!.textContent).toContain("Making your image");
    expect(cards[1]!.textContent).toContain("You");
    expect(cards[2]!.textContent).toContain("run out of credits");
    expect(cards[2]!.textContent).toContain("Try again");
  });
});
