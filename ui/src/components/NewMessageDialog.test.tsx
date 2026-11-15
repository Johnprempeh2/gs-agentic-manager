// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewMessageDialog } from "./NewMessageDialog";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("NewMessageDialog", () => {
  it("names an agent by its title, or its role in words, never the role's code", async () => {
    await act(async () => {
      root.render(
        <NewMessageDialog
          open
          onOpenChange={vi.fn()}
          agents={[
            { id: "a-1", name: "Ada", role: "general", title: null, appearance: null },
            { id: "a-2", name: "Flint", role: "qa", title: "Release checker", appearance: null },
          ] as never}
          people={[]}
          onPickAgent={vi.fn()}
          onPickPerson={vi.fn()}
        />,
      );
    });
    const rows = [...document.querySelectorAll<HTMLElement>("[role=option]")].map((el) => el.textContent);
    expect(rows).toContain("AdaGeneral");
    expect(rows).toContain("FlintRelease checker");
  });
});
