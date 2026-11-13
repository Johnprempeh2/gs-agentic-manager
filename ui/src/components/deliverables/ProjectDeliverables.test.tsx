// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupDeliverableDocuments } from "@greatstone/shared";
import type { Deliverable } from "@/api/deliverables";
import { DEMO_PORTAL_VERSIONS, DEMO_PROJECT_DELIVERABLES } from "./ProjectDeliverablesDesignExamples";
import {
  filterProjectDeliverables,
  onlyProject,
  ProjectDeliverableCard,
  ProjectDeliverableFilters,
  sortLatestFirst,
} from "./ProjectDeliverables";
import { DeliverableVersionTimeline, OldVersionBanner, sortVersionsNewestFirst } from "./DeliverableVersionTimeline";

vi.mock("@/components/AgentAvatar", () => ({ AgentAvatar: () => <span data-testid="agent-avatar" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const documents = () => sortLatestFirst(groupDeliverableDocuments(DEMO_PROJECT_DELIVERABLES));

describe("project deliverables", () => {
  it("keeps only the project's own deliverables", () => {
    const other: Deliverable = { ...DEMO_PROJECT_DELIVERABLES[0]!, id: "elsewhere", project: { id: "p-other", name: "Other" } };
    const none: Deliverable = { ...DEMO_PROJECT_DELIVERABLES[0]!, id: "loose", project: null };
    expect(onlyProject([...DEMO_PROJECT_DELIVERABLES, other, none], "p-demo").map((item) => item.id))
      .toEqual(DEMO_PROJECT_DELIVERABLES.map((item) => item.id));
  });

  it("sorts latest delivered first and filters Delivered and Client-facing", () => {
    const shuffled = sortLatestFirst([...documents()].reverse());
    expect(shuffled.map((document) => document.latest.id)).toEqual(["d-portal", "d-findings", "d-proposal", "d-notes", "d-pack"]);
    expect(filterProjectDeliverables(shuffled, "delivered").map((document) => document.latest.id)).toEqual(["d-portal", "d-pack"]);
    expect(filterProjectDeliverables(shuffled, "client_facing").map((document) => document.latest.id))
      .toEqual(["d-portal", "d-findings", "d-proposal", "d-pack"]);
    expect(filterProjectDeliverables(shuffled, "all")).toHaveLength(5);
  });

  it("shows title, type, stage, audience, release, date and who on a card", () => {
    const node = render(<ProjectDeliverableCard deliverable={DEMO_PROJECT_DELIVERABLES[0]!} onOpen={() => undefined} />);
    const text = node.textContent ?? "";
    expect(text).toContain("Discovery portal with the North Star instrument");
    expect(text).toContain("Mockup");
    expect(text).toContain("Delivered");
    expect(text).toContain("Client-facing");
    expect(node.querySelector("[data-testid='project-deliverable-release']")?.textContent).toBe("Release 3");
    expect(text).toContain("Lintel");
  });

  it("keeps phone targets at 44px and a single column under sm", () => {
    const node = render(
      <div>
        <ProjectDeliverableFilters value="all" counts={{ all: 5, delivered: 2, client_facing: 4 }} onChange={() => undefined} />
        <ProjectDeliverableCard deliverable={DEMO_PROJECT_DELIVERABLES[0]!} onOpen={() => undefined} />
      </div>,
    );
    const targets = [...node.querySelectorAll("button")];
    expect(targets.length).toBe(4);
    for (const target of targets) {
      expect(target.className).toMatch(/(^|\s)min-h-11(\s|$)/);
      // Nothing fixed-width that could push a 390px screen sideways.
      expect(target.className).not.toMatch(/(^|\s)(w|min-w)-\[\d+px\]/);
    }
    expect(node.querySelector("[data-testid='project-deliverable-card']")?.className).toContain("w-full");
  });
});

describe("release timeline", () => {
  it("orders releases newest first and marks the current one", () => {
    const shuffled = [DEMO_PORTAL_VERSIONS[2]!, DEMO_PORTAL_VERSIONS[0]!, DEMO_PORTAL_VERSIONS[1]!];
    expect(sortVersionsNewestFirst(shuffled).map((version) => version.version)).toEqual([3, 2, 1]);
    const node = render(<DeliverableVersionTimeline versions={shuffled} shownId="v1" onView={() => undefined} />);
    const releases = [...node.querySelectorAll("[data-testid='deliverable-release']")];
    expect(releases.map((item) => item.getAttribute("data-version"))).toEqual(["3", "2", "1"]);
    expect(releases[0]!.textContent).toContain("Current");
    expect(releases[2]!.getAttribute("aria-current")).toBe("true");
    expect(releases[1]!.textContent).toContain("Review note: The North Star instrument is missing");
  });

  it("shows the old-version banner only on an older release", () => {
    const old = render(<OldVersionBanner shownVersion={1} latestVersion={3} onViewLatest={() => undefined} />);
    expect(old.querySelector("[data-testid='deliverable-old-version-banner']")?.textContent)
      .toContain("You're viewing Release 1. The latest is Release 3.");
    act(() => root?.unmount());
    container?.remove();
    const latest = render(<OldVersionBanner shownVersion={3} latestVersion={3} onViewLatest={() => undefined} />);
    expect(latest.querySelector("[data-testid='deliverable-old-version-banner']")).toBeNull();
  });
});
