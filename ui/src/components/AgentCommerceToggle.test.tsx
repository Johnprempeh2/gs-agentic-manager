// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCommerceToggle } from "./AgentCommerceToggle";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentCommerceToggle (GRE-4814)", () => {
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
    act(() => root.render(<AgentCommerceToggle grants={grants} onChange={onChange} />));
    return container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
  }
  const hint = () => container.querySelector('[data-testid="agent-commerce-hint"]')!.textContent;

  it("turns Commerce on for an agent with website access", () => {
    const onChange = vi.fn();
    const toggle = render([{ permissionKey: "website:view", scope: { siteIds: ["site-1"] } }], onChange);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(false);
    expect(hint()).toContain("asks to publish or refund");
    act(() => toggle.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("shows a held grant as on and turns it off", () => {
    const onChange = vi.fn();
    const toggle = render([{ permissionKey: "website:view" }, { permissionKey: "website:commerce" }], onChange);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => toggle.click());
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("cannot be turned on without website access", () => {
    const onChange = vi.fn();
    const toggle = render([{ permissionKey: "agents:configure" }], onChange);
    expect(toggle.disabled).toBe(true);
    expect(hint()).toBe("Needs website access View or Edit first.");
    act(() => toggle.click());
    expect(onChange).not.toHaveBeenCalled();
  });
});
