// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";
import { TaskOwnerLabel, type TaskOwnerLabelProps } from "./TaskOwnerLabel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(props: TaskOwnerLabelProps): HTMLElement | null {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(<TaskOwnerLabel {...props} />));
  return container.querySelector<HTMLElement>("[data-testid='task-owner-label']");
}

const userLabels = new Map([["user-2", "Ama Mensah"]]);

describe("TaskOwnerLabel", () => {
  it("says Agent task when an agent is the assignee", () => {
    const label = render({ issue: { assigneeAgentId: "agent-1" }, currentUserId: "user-1", userLabels });
    expect(label?.textContent).toBe("Agent task");
    expect(label?.dataset.ownerKind).toBe("agent");
  });

  it("says Your task when the viewer is the assignee", () => {
    const label = render({ issue: { assigneeUserId: "user-1" }, currentUserId: "user-1", userLabels });
    expect(label?.textContent).toBe("Your task");
    expect(label?.dataset.ownerKind).toBe("you");
  });

  it("names another person who is the assignee", () => {
    const label = render({ issue: { assigneeUserId: "user-2" }, currentUserId: "user-1", userLabels });
    expect(label?.textContent).toBe("Ama Mensah");
    expect(label?.dataset.ownerKind).toBe("person");
  });

  it("renders no label for an unassigned task", () => {
    const label = render({ issue: { assigneeAgentId: null, assigneeUserId: null }, currentUserId: "user-1", userLabels });
    expect(label).toBeNull();
    expect(container?.innerHTML).toBe("");
  });
});
