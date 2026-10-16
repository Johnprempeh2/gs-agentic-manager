// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FirstWeekChecklistView } from "./FirstWeekChecklist";
import { firstWeekSteps, readFirstWeekMark, setFirstWeekMark, subscribeFirstWeekMarks } from "../lib/first-week";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  if (typeof reactAct === "function") {
    reactAct(callback);
    return;
  }
  flushSync(callback);
}

describe("first week steps", () => {
  it("lists the four steps in order and marks the done ones", () => {
    const steps = firstWeekSteps({
      calendarFeedOn: true,
      quickStartPicked: false,
      decisionAnswered: true,
      weeklyReportRead: false,
    });
    expect(steps.map((step) => [step.id, step.done])).toEqual([
      ["calendar-feed", true],
      ["quick-start", false],
      ["decision", true],
      ["weekly-report", false],
    ]);
  });

  it("remembers local marks per company and tells listeners", () => {
    window.localStorage.clear();
    const listener = vi.fn();
    const stop = subscribeFirstWeekMarks(listener);
    expect(readFirstWeekMark("c1", "weekly-report")).toBe(false);
    setFirstWeekMark("c1", "weekly-report");
    expect(readFirstWeekMark("c1", "weekly-report")).toBe(true);
    expect(readFirstWeekMark("c2", "weekly-report")).toBe(false);
    setFirstWeekMark("c1", "weekly-report", false);
    expect(readFirstWeekMark("c1", "weekly-report")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("FirstWeekChecklistView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows progress, links the open steps and runs the quick start and hide actions", () => {
    const onQuickStart = vi.fn();
    const onHide = vi.fn();
    const steps = firstWeekSteps({
      calendarFeedOn: true,
      quickStartPicked: false,
      decisionAnswered: false,
      weeklyReportRead: false,
    });
    act(() => root.render(<FirstWeekChecklistView steps={steps} onQuickStart={onQuickStart} onHide={onHide} />));

    expect(container.textContent).toContain("Your first week");
    expect(container.textContent).toContain("1 of 4 done");
    const item = (id: string) => container.querySelector(`[data-testid="first-week-${id}"]`)!;
    expect(item("calendar-feed").getAttribute("data-done")).toBe("true");
    expect(item("calendar-feed").querySelector("a")).toBeNull();
    expect(item("decision").querySelector("a")?.getAttribute("href")).toBe("/decisions");
    expect(item("weekly-report").querySelector("a")?.getAttribute("href")).toBe("/weekly-report");

    act(() => item("quick-start").querySelector("button")!.click());
    expect(onQuickStart).toHaveBeenCalledTimes(1);

    act(() => (container.querySelector('[data-testid="first-week-hide"]') as HTMLButtonElement).click());
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
