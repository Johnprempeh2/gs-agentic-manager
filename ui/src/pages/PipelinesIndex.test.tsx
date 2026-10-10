// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineListItem, PipelineStage } from "../api/pipelines";
import { PipelinesIndexTable } from "./Pipelines";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "GRE" } }),
}));

function stage(key: string, name: string, kind: string, position: number, openCaseCount: number): PipelineStage {
  return { id: `stage-${key}`, pipelineId: "p1", key, name, kind, position, openCaseCount };
}

const clientJourney: PipelineListItem = {
  id: "p1",
  companyId: "company-1",
  key: "client-journey",
  name: "Client journey",
  description: "One case per client.\nMoves from first contact through GITA, deposit and Deep Dive to live support.",
  projectId: null,
  enforceTransitions: false,
  archivedAt: null,
  stageCount: 5,
  stages: [
    stage("first-contact", "First contact", "working", 100, 2),
    stage("intro-pack", "Introduction pack", "working", 200, 0),
    stage("gita", "GITA", "review", 300, 1),
    stage("live", "Live support", "done", 900, 0),
    stage("lost", "Lost", "cancelled", 1000, 0),
  ],
  openCaseCount: 3,
  attentionCount: 2,
  inMotionCount: 3,
  lastActivityAt: new Date().toISOString(),
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(
  pipelines: PipelineListItem[],
  search = "",
  stars?: { starredIds: Set<string>; onToggleStar: (pipeline: PipelineListItem, next: boolean) => void },
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <MemoryRouter initialEntries={["/GRE/pipelines"]}>
        <PipelinesIndexTable
          pipelines={pipelines}
          viewMode="flat"
          onViewModeChange={() => {}}
          connectionsAvailable={false}
          search={search}
          onSearchChange={() => {}}
          starredIds={stars?.starredIds}
          onToggleStar={stars?.onToggleStar}
        />
      </MemoryRouter>,
    );
  });
  return container;
}

afterEach(() => {
  flushSync(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("PipelinesIndexTable", () => {
  it("shows a scannable row: clamped description, stage distribution and plain attention", () => {
    const html = render([clientJourney]);

    const name = html.querySelector<HTMLAnchorElement>('a[href="/GRE/pipelines/p1"]')!;
    expect(name.textContent).toBe("Client journey");
    expect(name.title).toBe(clientJourney.description);

    const description = [...html.querySelectorAll("p")].find((p) => p.textContent?.startsWith("One case per client"))!;
    expect(description.className).toContain("truncate");

    const chips = [...html.querySelectorAll('[aria-label="Open items by stage"] li')].map((li) => li.textContent);
    expect(chips).toEqual(["First contact2", "GITA1"]);

    const attention = html.querySelector<HTMLAnchorElement>('a[href="/GRE/review-queue"]')!;
    expect(attention.textContent).toBe("2 need attention");
    expect(html.textContent).not.toContain("in motion");
    expect(html.querySelector("table")).toBeNull();
  });

  it("says when nothing is waiting and filters by search", () => {
    const quiet = { ...clientJourney, id: "p2", name: "Content", attentionCount: 0 };
    const html = render([clientJourney, quiet], "cont");
    expect(html.textContent).toContain("Nothing waiting");
    expect(html.querySelector('a[href="/GRE/pipelines/p1"]')).toBeNull();
    expect(html.querySelector('a[href="/GRE/pipelines/p2"]')).not.toBeNull();
  });

  it("pins a pipeline from its row without opening it, and shows pinned ones as starred", () => {
    const onToggleStar = vi.fn();
    const other = { ...clientJourney, id: "p2", name: "Content" };
    const html = render([clientJourney, other], "", { starredIds: new Set(["p2"]), onToggleStar });

    const pin = html.querySelector<HTMLButtonElement>('button[aria-label="Star Client journey"]')!;
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    flushSync(() => pin.click());
    expect(onToggleStar).toHaveBeenCalledWith(clientJourney, true);

    const pinned = html.querySelector<HTMLButtonElement>('button[aria-label="Unstar Content"]')!;
    expect(pinned.getAttribute("aria-pressed")).toBe("true");
  });

  it("hides the pin star when no handler is given", () => {
    const html = render([clientJourney]);
    expect(html.querySelector('button[aria-label^="Star "]')).toBeNull();
  });
});
