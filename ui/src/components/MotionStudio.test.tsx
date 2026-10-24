// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionStudy } from "@greatstone/shared";
import { MotionStudio, filterMotionStudies } from "./MotionStudio";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const motionApiMock = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn(), resolveProposal: vi.fn() }));
vi.mock("../api/motionStudies", () => ({ motionStudiesApi: motionApiMock }));

function study(overrides: Partial<MotionStudy>): MotionStudy {
  return {
    id: "study-15",
    companyId: "company-1",
    number: "015",
    slug: "bedrock",
    title: "Bedrock",
    concept: "Immense strata drift almost imperceptibly.",
    theme: ["Background", "Text-safe", "Strata"],
    tech: "Canvas 2D",
    notes: "BACKGROUND CLASS.",
    studyDate: "2026-07-22",
    sourceUrl: null,
    textSafe: true,
    status: "new",
    decision: "undecided",
    proposal: null,
    source: "lab_import",
    assetId: "asset-15",
    previewPath: "/api/motion-studies/study-15/preview",
    posterAssetId: "poster-15",
    posterPath: "/api/motion-studies/study-15/poster?v=poster-15",
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const WEAVE = study({ id: "study-14", number: "014", slug: "weave", title: "Weave", theme: ["Truchet"], textSafe: false, decision: "maybe", previewPath: "/api/motion-studies/study-14/preview", posterAssetId: null, posterPath: null });

let container: HTMLDivElement;
let root: Root;

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MotionStudio companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function card(slug: string) {
  return container.querySelector(`[data-testid="motion-card-${slug}"]`) as HTMLButtonElement | null;
}

describe("filterMotionStudies", () => {
  it("hides archived studies unless asked, and filters by text-safe or decision", () => {
    const archived = study({ id: "a", slug: "old", status: "archived" });
    const all = [study({}), WEAVE, archived];
    expect(filterMotionStudies(all, "all", false).map((item) => item.slug)).toEqual(["bedrock", "weave"]);
    expect(filterMotionStudies(all, "all", true)).toHaveLength(3);
    expect(filterMotionStudies(all, "text-safe", false).map((item) => item.slug)).toEqual(["bedrock"]);
    expect(filterMotionStudies(all, "maybe", false).map((item) => item.slug)).toEqual(["weave"]);
  });
});

describe("MotionStudio", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("lists each study with its still poster, number, title, tags and text-safe mark, and plays it sandboxed only on hover", async () => {
    motionApiMock.list.mockResolvedValue({ studies: [study({}), WEAVE] });
    await render();

    const bedrock = card("bedrock")!;
    expect(bedrock.textContent).toContain("015");
    expect(bedrock.textContent).toContain("Bedrock");
    expect(bedrock.textContent).toContain("Background · Text-safe · Strata · Canvas 2D");
    expect(bedrock.querySelector('[data-testid="motion-text-safe"]')).not.toBeNull();
    expect(card("weave")!.querySelector('[data-testid="motion-text-safe"]')).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(bedrock.querySelector('[data-testid="motion-poster"]')?.getAttribute("src")).toBe("/api/motion-studies/study-15/poster?v=poster-15");
    expect(card("weave")!.querySelector('[data-testid="motion-poster"]')).toBeNull();

    await act(async () => {
      bedrock.focus();
    });
    const frame = bedrock.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("/api/motion-studies/study-15/preview");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("keeps Show archived in the filter row", async () => {
    motionApiMock.list.mockResolvedValue({ studies: [study({}), study({ id: "a", slug: "old", status: "archived" })] });
    await render();
    expect(card("old")).toBeNull();
    const archived = [...container.querySelectorAll('[data-testid="motion-filters"] button')].find((button) => button.textContent === "Show archived")!;
    await act(async () => (archived as HTMLButtonElement).click());
    expect(archived.getAttribute("aria-pressed")).toBe("true");
    expect(card("old")).not.toBeNull();
  });

  it("filters to text-safe studies", async () => {
    motionApiMock.list.mockResolvedValue({ studies: [study({}), WEAVE] });
    await render();
    const textSafe = [...container.querySelectorAll("button")].find((button) => button.textContent === "Text-safe")!;
    await act(async () => textSafe.click());
    expect(card("bedrock")).not.toBeNull();
    expect(card("weave")).toBeNull();
  });

  it("sets the Decision from the open study", async () => {
    motionApiMock.list.mockResolvedValue({ studies: [study({})] });
    motionApiMock.update.mockResolvedValue(study({ decision: "implement" }));
    await render();
    await act(async () => card("bedrock")!.click());
    await settle();

    const decision = document.querySelector('[data-testid="motion-decision"]')!;
    const options = [...decision.querySelectorAll('[role="radio"]')];
    expect(options.map((option) => option.textContent)).toEqual(["Implement", "Maybe", "Pass", "Undecided"]);
    expect(options.find((option) => option.getAttribute("aria-checked") === "true")?.textContent).toBe("Undecided");

    // The background rules are folded away until asked for.
    expect(document.querySelector('[data-testid="motion-background-rules"]')).toBeNull();
    const rules = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Background rules"))!;
    await act(async () => rules.click());
    expect(document.querySelector('[data-testid="motion-background-rules"]')?.textContent).toContain("Lime never behind copy");

    await act(async () => (options[0] as HTMLButtonElement).click());
    await settle();
    expect(motionApiMock.update).toHaveBeenCalledWith("study-15", { decision: "implement" });
    expect(card("bedrock")!.textContent).toContain("Implement");
  });

  it("shows an agent's proposal and accepts it", async () => {
    motionApiMock.list.mockResolvedValue({
      studies: [study({ proposal: { status: null, decision: "implement", reason: "Calm behind the hero.", agentId: "agent-1", proposedAt: new Date().toISOString() } })],
    });
    motionApiMock.resolveProposal.mockResolvedValue(study({ decision: "implement" }));
    await render();
    expect(container.textContent).toContain("1 agent proposal waits for you");
    await act(async () => card("bedrock")!.click());
    await settle();

    const proposal = document.querySelector('[data-testid="motion-proposal"]')!;
    expect(proposal.textContent).toContain("Decision: Implement");
    expect(proposal.textContent).toContain("Calm behind the hero.");
    const accept = [...proposal.querySelectorAll("button")].find((button) => button.textContent?.includes("Accept"))!;
    await act(async () => accept.click());
    await settle();
    expect(motionApiMock.resolveProposal).toHaveBeenCalledWith("study-15", true);
    expect(document.querySelector('[data-testid="motion-proposal"]')).toBeNull();
  });

  it("says plainly when there are no studies yet", async () => {
    motionApiMock.list.mockResolvedValue({ studies: [] });
    await render();
    expect(container.querySelector('[data-testid="motion-empty"]')?.textContent).toContain("No motion studies yet");
  });
});
