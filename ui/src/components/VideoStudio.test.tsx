// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedImage, GeneratedVideo } from "@greatstone/shared";
import { VideoStudio } from "./VideoStudio";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const videosApiMock = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  setFavourite: vi.fn(),
}));
vi.mock("../api/videos", () => ({ videosApi: videosApiMock }));
const imagesApiMock = vi.hoisted(() => ({ setPlanSettings: vi.fn() }));
vi.mock("@/api/images", () => ({ imagesApi: imagesApiMock }));

function planStatus(credits: number, extra: Record<string, unknown> = {}) {
  return {
    configured: true,
    provider: "higgsfield_plan",
    providerLabel: "Higgsfield (your plan)",
    plan: {
      connectionId: "conn-1",
      credits,
      planType: "basic",
      lowCredits: credits < 50,
      agentsMaySpend: false,
      planUrl: "https://higgsfield.ai/pricing",
      creditsPerClip: { "kling-2.5-turbo-pro": { 5: 7.5, 10: 15 }, "hailuo-2.3": { 6: 6, 10: 6 } },
    },
    alsoAvailable: { provider: "higgsfield", providerLabel: "Higgsfield" },
    ...extra,
  };
}

function video(overrides: Partial<GeneratedVideo>): GeneratedVideo {
  return {
    id: "video-1",
    companyId: "company-1",
    prompt: "Waves on rocks",
    model: "hailuo-2.3",
    provider: "mock",
    durationSeconds: 6,
    motion: "drone",
    camera: null,
    sourceImage: null,
    status: "completed",
    error: null,
    assetId: "asset-9",
    contentPath: "/api/assets/asset-9/content",
    createdByAgentId: null,
    createdByUserId: "user-1",
    issue: null,
    organisation: null,
    favourite: false,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

const IMAGE = {
  id: "11111111-1111-4111-8111-111111111111",
  prompt: "A red boat in a harbour",
  altText: "A red boat in a harbour",
  contentPath: "/api/assets/asset-1/content",
  issue: { id: "22222222-2222-4222-8222-222222222222", identifier: "GRE-1", title: "Teaser" },
  organisation: null,
} as unknown as GeneratedImage;

let container: HTMLDivElement;
let root: Root;

async function render(props: { sourceImage?: GeneratedImage | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <VideoStudio companyId="company-1" sourceImage={props.sourceImage ?? null} onClearSourceImage={vi.fn()} onError={vi.fn()} />
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** Let queries and mutations settle. */
async function settle() {
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

describe("VideoStudio", () => {
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

  it("says plainly when video making is off", async () => {
    videosApiMock.status.mockResolvedValue({ configured: false, provider: null, providerLabel: null });
    videosApiMock.list.mockResolvedValue({ videos: [], total: 0, nextOffset: null });
    await render();
    expect(container.querySelector('[data-testid="videos-not-set-up"]')?.textContent).toContain("not switched on yet");
    expect((container.querySelector('[data-testid="make-video"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain("No videos yet");
  });

  it("makes a clip from words with a camera movement and length, and plays finished clips", async () => {
    videosApiMock.status.mockResolvedValue({ configured: true, provider: "mock", providerLabel: "Practice mode" });
    videosApiMock.list.mockResolvedValue({ videos: [video({})], total: 1, nextOffset: null });
    videosApiMock.create.mockResolvedValue(video({ id: "video-2", status: "pending", contentPath: null }));
    await render();

    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/assets/asset-9/content");
    expect(container.textContent).toContain("Hailuo 2.3 · 6 seconds · Drone rise");
    // Image-only models are not offered without an image.
    const models = [...container.querySelectorAll('[data-testid="video-model"] option')].map((option) => option.getAttribute("value"));
    expect(models).toEqual(["kling-2.5-turbo-pro", "hailuo-2.3"]);

    await act(async () => setTextarea(container.querySelector('[data-testid="video-prompt"]') as HTMLTextAreaElement, "A bus crossing a bridge"));
    const orbit = [...container.querySelectorAll('[data-testid="video-motion"] [role="radio"]')].find((button) => button.textContent === "Orbit") as HTMLButtonElement;
    await act(async () => orbit.click());
    const ten = [...container.querySelectorAll('[data-testid="video-duration"] [role="radio"]')].find((button) => button.textContent === "10 seconds") as HTMLButtonElement;
    await act(async () => ten.click());
    await act(async () => (container.querySelector('[data-testid="make-video"]') as HTMLButtonElement).click());

    expect(videosApiMock.create).toHaveBeenCalledWith("company-1", {
      prompt: "A bus crossing a bridge",
      model: "kling-2.5-turbo-pro",
      duration: 10,
      motion: "orbit",
    });
  });

  it("animates a picked image and keeps its task link", async () => {
    videosApiMock.status.mockResolvedValue({ configured: true, provider: "higgsfield", providerLabel: "Higgsfield" });
    videosApiMock.list.mockResolvedValue({ videos: [], total: 0, nextOffset: null });
    videosApiMock.create.mockResolvedValue(video({ status: "pending", contentPath: null }));
    await render({ sourceImage: IMAGE });

    expect(container.textContent).toContain("Bring an image to life");
    expect(container.querySelector('[data-testid="video-source-image"] img')?.getAttribute("alt")).toBe("A red boat in a harbour");
    const models = [...container.querySelectorAll('[data-testid="video-model"] option')].map((option) => option.getAttribute("value"));
    expect(models).toContain("kling-2.5-turbo-standard");

    await act(async () => setTextarea(container.querySelector('[data-testid="video-prompt"]') as HTMLTextAreaElement, "The boat bobs gently"));
    await act(async () => (container.querySelector('[data-testid="make-video"]') as HTMLButtonElement).click());
    expect(videosApiMock.create).toHaveBeenCalledWith("company-1", {
      prompt: "The boat bobs gently",
      model: "kling-2.5-turbo-pro",
      duration: 5,
      sourceImageId: IMAGE.id,
      issueId: IMAGE.issue!.id,
    });
  });

  it("stars a clip and shows only favourite clips when asked", async () => {
    videosApiMock.status.mockResolvedValue({ configured: true, provider: "mock", providerLabel: "Practice mode" });
    let starred = false;
    videosApiMock.list.mockImplementation(async (_companyId: string, params: { favourite?: boolean }) => {
      const all = [video({ id: "video-1", favourite: starred }), video({ id: "video-2", prompt: "Gulls over a harbour" })];
      const videos = params.favourite ? all.filter((item) => item.favourite) : all;
      return { videos, total: videos.length, nextOffset: null };
    });
    videosApiMock.setFavourite.mockImplementation(async (_id: string, body: { favourite: boolean }) => {
      starred = body.favourite;
      return video({ id: "video-1", favourite: starred });
    });
    await render();

    const star = container.querySelector('[data-testid="video-favourite"]') as HTMLButtonElement;
    expect(star.getAttribute("aria-label")).toBe("Add to favourites");
    await act(async () => star.click());
    await settle();
    expect(videosApiMock.setFavourite).toHaveBeenCalledWith("video-1", { favourite: true });
    expect(container.querySelector('[data-testid="video-favourite"]')?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => (container.querySelector('[data-testid="video-favourites-filter"]') as HTMLButtonElement).click());
    await settle();
    expect(videosApiMock.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ favourite: true }));
    expect(container.querySelectorAll('[data-testid="generated-video-card"]')).toHaveLength(1);
  });
  it("uses the Higgsfield plan by default, shows its credits and price, and can switch to the API key", async () => {
    videosApiMock.status.mockResolvedValue(planStatus(312.75));
    videosApiMock.list.mockResolvedValue({ videos: [], total: 0, nextOffset: null });
    videosApiMock.create.mockResolvedValue(video({ status: "pending", contentPath: null }));
    imagesApiMock.setPlanSettings.mockResolvedValue({ agentsMaySpend: true });
    await render();

    expect(container.textContent).toContain("Using Higgsfield (your plan)");
    expect(container.querySelector('[data-testid="plan-credits"]')?.textContent).toBe("312.75 credits left on the basic plan");
    expect(container.querySelector('[data-testid="plan-cost"]')?.textContent).toBe("This uses 7.5 credits");
    expect(container.querySelector('[data-testid="plan-low"]')).toBeNull();

    await act(async () => setTextarea(container.querySelector('[data-testid="video-prompt"]') as HTMLTextAreaElement, "Waves at dusk"));
    await act(async () => (container.querySelector('[data-testid="make-video"]') as HTMLButtonElement).click());
    expect(videosApiMock.create).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ provider: "higgsfield_plan" }));

    const agents = container.querySelector('[data-testid="plan-agents"]') as HTMLButtonElement;
    expect(agents.getAttribute("aria-checked")).toBe("false");
    await act(async () => agents.click());
    expect(imagesApiMock.setPlanSettings).toHaveBeenCalledWith("company-1", { agentsMaySpend: true });

    const service = container.querySelector('[data-testid="studio-provider"]') as HTMLSelectElement;
    await act(async () => {
      service.value = "key";
      service.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="plan-credits"]')).toBeNull();
    await act(async () => setTextarea(container.querySelector('[data-testid="video-prompt"]') as HTMLTextAreaElement, "Waves at dawn"));
    await act(async () => (container.querySelector('[data-testid="make-video"]') as HTMLButtonElement).click());
    expect(videosApiMock.create).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ provider: "higgsfield" }));
  });

  it("warns when plan credits are low and stops when they run out, linking to the plan page", async () => {
    videosApiMock.list.mockResolvedValue({ videos: [], total: 0, nextOffset: null });
    videosApiMock.status.mockResolvedValue(planStatus(20));
    await render();
    expect(container.querySelector('[data-testid="plan-low"]')?.getAttribute("href")).toBe("https://higgsfield.ai/pricing");

    act(() => root.unmount());
    root = createRoot(container);
    videosApiMock.status.mockResolvedValue(planStatus(0, { alsoAvailable: null }));
    await render();
    expect(container.querySelector('[data-testid="studio-provider"]')).toBeNull();
    expect(container.querySelector('[data-testid="plan-empty"]')?.getAttribute("href")).toBe("https://higgsfield.ai/pricing");
    await act(async () => setTextarea(container.querySelector('[data-testid="video-prompt"]') as HTMLTextAreaElement, "Waves at dusk"));
    expect((container.querySelector('[data-testid="make-video"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
