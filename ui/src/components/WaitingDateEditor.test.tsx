// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WaitingDateEditor } from "./WaitingDateEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
});

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return container;
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("WaitingDateEditor", () => {
  it("saves who the task waits on and the chase date, owned by the assignee", () => {
    const onSave = vi.fn();
    const root = render(<WaitingDateEditor issue={{ id: "i1", assigneeAgentId: "agent-1" }} onSave={onSave} />);
    const open = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("Set a waiting date"))!;
    act(() => open.click());
    act(() => setValue(root.querySelector("select")!, "outside"));
    act(() => setValue(root.querySelector('input[type="date"]')!, "2030-01-15"));
    const save = [...root.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    act(() => save.click());
    expect(onSave).toHaveBeenCalledWith({
      owner: { agentId: "agent-1" },
      action: "Hear back from outside the company.",
      waitingOn: "outside",
      expectedBy: "2030-01-15",
    });
  });

  it("offers to change or remove a date already set", () => {
    const onSave = vi.fn();
    const root = render(
      <WaitingDateEditor
        issue={{
          id: "i1",
          assigneeAgentId: "agent-1",
          unblockDescriptor: { owner: "board", action: "Ben replies", waitingOn: "board", expectedBy: "2030-02-01" },
        }}
        onSave={onSave}
      />,
    );
    const open = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("Change the waiting date"))!;
    act(() => open.click());
    const remove = [...root.querySelectorAll("button")].find((b) => b.textContent === "Remove the date")!;
    act(() => remove.click());
    expect(onSave).toHaveBeenCalledWith({ owner: "board", action: "Ben replies", waitingOn: "board" });
  });
});
