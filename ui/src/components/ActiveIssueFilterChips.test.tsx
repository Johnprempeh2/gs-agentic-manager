// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveIssueFilterChips } from "./ActiveIssueFilterChips";
import { defaultIssueFilterState } from "../lib/issue-filters";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ActiveIssueFilterChips", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function render(node: React.ReactNode) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => createRoot(container).render(node));
    return container;
  }

  it("shows each filter as a chip that removes it when tapped", () => {
    const onChange = vi.fn();
    const container = render(
      <ActiveIssueFilterChips
        filters={[{ key: "statuses", name: "Status", value: "Recent", clear: { statuses: [] } }]}
        onChange={onChange}
      />,
    );
    const chip = container.querySelector<HTMLButtonElement>('button[aria-label="Remove filter Status: Recent"]');
    expect(chip?.textContent).toBe("Status:Recent");
    expect(container.textContent).not.toContain("Clear all");
    act(() => chip!.click());
    expect(onChange).toHaveBeenCalledWith({ statuses: [] });
  });

  it("offers Clear all when more than one filter is on", () => {
    const onChange = vi.fn();
    const container = render(
      <ActiveIssueFilterChips
        filters={[
          { key: "statuses", name: "Status", value: "Recent", clear: { statuses: [] } },
          { key: "due", name: "Due", value: "Past due", clear: { due: null } },
        ]}
        onChange={onChange}
      />,
    );
    const clearAll = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Clear all");
    act(() => clearAll!.click());
    expect(onChange).toHaveBeenCalledWith(defaultIssueFilterState);
  });

  it("renders nothing with no filters on", () => {
    const container = render(<ActiveIssueFilterChips filters={[]} onChange={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});
