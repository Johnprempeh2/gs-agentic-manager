// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWebsiteAccessSelect } from "./AgentWebsiteAccessSelect";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentWebsiteAccessSelect (GRE-2239)", () => {
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

  function render(grants: Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>, onChange = vi.fn()) {
    act(() => root.render(<AgentWebsiteAccessSelect grants={grants} onChange={onChange} />));
    return container.querySelector<HTMLSelectElement>('select[aria-label="Website access"]')!;
  }

  it("shows the level from the agent's grants and offers no Publish option", () => {
    expect(render([{ permissionKey: "agents:configure" }]).value).toBe("none");
    expect(render([{ permissionKey: "website:view" }]).value).toBe("view");
    const select = render([{ permissionKey: "website:view" }, { permissionKey: "website:edit" }]);
    expect(select.value).toBe("edit");
    expect([...select.options].map((option) => option.value)).toEqual(["none", "view", "edit"]);
    expect(container.textContent).toContain("Publishing stays with people.");
  });

  it("does not count grants scoped to some sites as all-site access", () => {
    expect(render([{ permissionKey: "website:view", scope: { siteIds: ["s1"] } }]).value).toBe("none");
  });

  it("saves the picked level", () => {
    const onChange = vi.fn();
    const select = render([], onChange);
    act(() => {
      select.value = "edit";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("edit");
  });
});
