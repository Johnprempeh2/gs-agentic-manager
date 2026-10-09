// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineAccess } from "@greatstone/shared";
import { AgentPipelineAccessControl } from "./AgentPipelineAccessControl";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PIPELINES = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Sales" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Onboarding" },
];

describe("AgentPipelineAccessControl", () => {
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

  function render(grants: Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>, onSave = vi.fn()) {
    act(() => {
      root.render(
        <AgentPipelineAccessControl
          grants={grants as never}
          pipelines={PIPELINES}
          onSave={onSave}
        />,
      );
    });
    return onSave;
  }

  function levelSelect() {
    return container.querySelector("select[aria-label='Pipeline access level']") as HTMLSelectElement;
  }

  function changeLevel(value: string) {
    const select = levelSelect();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function button(label: string) {
    return Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.includes(label)) as
      | HTMLButtonElement
      | undefined;
  }

  function radio(label: string) {
    const labelEl = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.trim() === label);
    return labelEl?.querySelector("input[type='radio']") as HTMLInputElement;
  }

  it("shows the level the agent holds today", () => {
    render([]);
    expect(levelSelect().value).toBe("view");
    render([{ permissionKey: "pipelines:cases", scope: null }]);
    expect(levelSelect().value).toBe("work_cases");
    render([{ permissionKey: "pipelines:write", scope: { pipelineIds: [PIPELINES[0]!.id] } }]);
    expect(levelSelect().value).toBe("administer");
    expect(radio("Picked pipelines").checked).toBe(true);
  });

  it("saves Administer on all pipelines", () => {
    const onSave = render([]);
    expect(button("Save pipeline access")).toBeUndefined();

    changeLevel("administer");
    expect(radio("All pipelines").checked).toBe(true);
    act(() => button("Save pipeline access")!.click());

    expect(onSave).toHaveBeenCalledWith({ level: "administer", pipelineIds: null } satisfies PipelineAccess);
  });

  it("needs at least one picked pipeline before saving a picked scope", () => {
    const onSave = render([]);
    changeLevel("work_cases");
    act(() => radio("Picked pipelines").click());
    expect(button("Save pipeline access")!.disabled).toBe(true);
    expect(container.textContent).toContain("Pick at least one pipeline.");

    const sales = container.querySelector("button[aria-label='Sales']") as HTMLButtonElement;
    act(() => sales.click());
    expect(button("Save pipeline access")!.disabled).toBe(false);
    act(() => button("Save pipeline access")!.click());

    expect(onSave).toHaveBeenCalledWith({ level: "work_cases", pipelineIds: [PIPELINES[0]!.id] });
  });
});
