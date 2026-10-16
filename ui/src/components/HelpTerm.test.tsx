// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpTerm } from "./HelpTerm";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null, companies: [] }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter>{node}</MemoryRouter>));
}

describe("HelpTerm", () => {
  it("explains a word in plain words when selected", async () => {
    await render(<p>Each <HelpTerm term="routine" /> repeats.</p>);
    const trigger = document.querySelector<HTMLButtonElement>("[data-testid='help-term-routine']")!;
    expect(trigger.textContent).toBe("routine");
    expect(trigger.getAttribute("aria-label")).toBe("routine: what does this mean?");
    await act(async () => trigger.click());
    expect(document.body.textContent).toContain("Work that repeats on a schedule");
    expect(document.body.textContent).toContain("For example: Every Monday at 9am");
    const link = [...document.querySelectorAll("a")].find((a) => a.textContent === "See all the words we use");
    expect(link?.getAttribute("href")).toBe("/tutorials#words");
  });

  it("keeps the given label", async () => {
    await render(<HelpTerm term="task">tasks</HelpTerm>);
    expect(document.querySelector("[data-testid='help-term-task']")?.textContent).toBe("tasks");
  });

  it("shows plain text for a word it does not know", async () => {
    await render(<HelpTerm term="nonsense">thing</HelpTerm>);
    expect(container!.querySelector("button")).toBeNull();
    expect(container!.textContent).toBe("thing");
  });
});
