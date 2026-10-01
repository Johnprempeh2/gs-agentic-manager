// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorState, errorStateMessage } from "./ErrorState";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ErrorState", () => {
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

  it("shows the error message as an alert with a retry button", () => {
    const onRetry = vi.fn();
    act(() => root.render(<ErrorState error={new Error("Server said no")} onRetry={onRetry} />));

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not load this page");
    expect(alert?.textContent).toContain("Server said no");

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Try again");
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("hides the retry button without a handler and disables it while retrying", () => {
    act(() => root.render(<ErrorState error={new Error("x")} />));
    expect(container.querySelector("button")).toBeNull();

    act(() => root.render(<ErrorState error={new Error("x")} onRetry={() => {}} retrying />));
    expect(container.querySelector("button")?.disabled).toBe(true);
  });

  it("titles the compact banner as a failed refresh", () => {
    act(() => root.render(<ErrorState error={new Error("x")} compact />));
    expect(container.textContent).toContain("Could not refresh");
  });

  it("falls back to a plain line for unknown errors", () => {
    expect(errorStateMessage("Timed out")).toBe("Timed out");
    expect(errorStateMessage(new Error("  "))).toBe("Something went wrong.");
    expect(errorStateMessage({ status: 500 })).toBe("Something went wrong.");
  });
});
