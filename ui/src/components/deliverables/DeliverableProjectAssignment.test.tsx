// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliverableProjectAssignment } from "./DeliverableVersionTimeline";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const projects = [{ id: "p-1", name: "Website refresh" }, { id: "p-2", name: "Launch" }];
const moveButton = () => document.querySelector<HTMLButtonElement>('[data-testid="deliverable-move-open"]')!;

describe("DeliverableProjectAssignment", () => {
  it("offers a project, not another one, when the deliverable has none", async () => {
    await act(async () => {
      root.render(<DeliverableProjectAssignment title="Launch email" project={null} clientName={null} projects={projects} onMove={vi.fn()} />);
    });
    expect(moveButton().textContent?.trim()).toBe("Move to a project");
  });

  it("offers another project when it already has one", async () => {
    await act(async () => {
      root.render(<DeliverableProjectAssignment title="Launch email" project={projects[0]} clientName={null} projects={projects} onMove={vi.fn()} />);
    });
    expect(moveButton().textContent?.trim()).toBe("Move to another project");
  });
});
