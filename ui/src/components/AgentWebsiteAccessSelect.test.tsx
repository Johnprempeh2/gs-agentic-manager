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

  const sites = [
    { id: "site-live", name: "Greatstone website" },
    { id: "site-stg", name: "Staging copy" },
  ];

  function render(
    grants: Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>,
    onChange = vi.fn(),
    siteList: Array<{ id: string; name: string }> = [],
  ) {
    act(() => root.render(<AgentWebsiteAccessSelect grants={grants} sites={siteList} onChange={onChange} />));
    return container.querySelector<HTMLSelectElement>('select[aria-label="Website access"]')!;
  }
  const siteSelect = () => container.querySelector<HTMLSelectElement>('select[aria-label="Website access sites"]');
  function pick(select: HTMLSelectElement, value: string) {
    act(() => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("shows the level from the agent's grants and offers no Publish option", () => {
    expect(render([{ permissionKey: "agents:configure" }]).value).toBe("none");
    expect(render([{ permissionKey: "website:view" }]).value).toBe("view");
    const select = render([{ permissionKey: "website:view" }, { permissionKey: "website:edit" }]);
    expect(select.value).toBe("edit");
    expect([...select.options].map((option) => option.value)).toEqual(["none", "view", "edit"]);
    expect(container.textContent).toContain("Publishing stays with people.");
  });

  it("shows a grant limited to one site as that level on that site (GRE-3992)", () => {
    const select = render([{ permissionKey: "website:view", scope: { siteIds: ["site-stg"] } }], vi.fn(), sites);
    expect(select.value).toBe("view");
    expect(siteSelect()!.value).toBe("site-stg");
    expect(container.textContent).toContain("on Staging copy.");
  });

  it("hides the site picker when the company has no sites and the access covers every site", () => {
    render([{ permissionKey: "website:view" }]);
    expect(siteSelect()).toBeNull();
    expect(container.textContent).toContain("on every site.");
  });

  it("saves the picked level", () => {
    const onChange = vi.fn();
    const select = render([], onChange);
    act(() => {
      select.value = "edit";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("edit", null);
  });

  it("grants view on one chosen site: the site is picked first and nothing is saved until a level is picked", () => {
    const onChange = vi.fn();
    const select = render([], onChange, sites);
    pick(siteSelect()!, "site-stg");
    expect(onChange).not.toHaveBeenCalled();
    pick(select, "view");
    expect(onChange).toHaveBeenCalledWith("view", "site-stg");
  });

  it("moves an existing grant to another site, and removes it with None", () => {
    const onChange = vi.fn();
    const select = render([{ permissionKey: "website:view", scope: { siteIds: ["site-stg"] } }], onChange, sites);
    pick(siteSelect()!, "site-live");
    expect(onChange).toHaveBeenLastCalledWith("view", "site-live");
    pick(siteSelect()!, "all");
    expect(onChange).toHaveBeenLastCalledWith("view", null);
    pick(select, "none");
    expect(onChange).toHaveBeenLastCalledWith("none", null);
  });
});
