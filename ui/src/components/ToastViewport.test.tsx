// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToastActions, type ToastInput } from "../context/ToastContext";
import { ToastViewport } from "./ToastViewport";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Push({ toast }: { toast: ToastInput }) {
  const { pushToast } = useToastActions();
  useEffect(() => {
    pushToast(toast);
  }, [pushToast, toast]);
  return null;
}

function render(toast: ToastInput) {
  act(() =>
    root.render(
      <MemoryRouter>
        <ToastProvider>
          <Push toast={toast} />
          <ToastViewport />
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
}

describe("ToastViewport", () => {
  it("shows a second choice before the main one, and either closes the toast", () => {
    const nextWeek = vi.fn();
    const undo = vi.fn();
    render({
      title: "Back tomorrow at 08:00",
      tone: "info",
      secondaryAction: { label: "Next week", onClick: nextWeek },
      action: { label: "Undo", onClick: undo },
    });
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons.slice(0, 2)).toEqual(["Next week", "Undo"]);

    act(() => [...container.querySelectorAll("button")].find((b) => b.textContent === "Next week")!.click());
    expect(nextWeek).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Back tomorrow at 08:00");
  });
});
