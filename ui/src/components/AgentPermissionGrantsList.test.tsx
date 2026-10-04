// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PERMISSION_KEYS } from "@greatstone/shared";
import { AgentPermissionGrantsList } from "./AgentPermissionGrantsList";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentPermissionGrantsList", () => {
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

  function rowFor(key: string) {
    return container.querySelector(`[data-permission-key="${key}"]`) as HTMLElement | null;
  }

  it("lists every known grant key with granted or not granted", () => {
    act(() => {
      root.render(
        <AgentPermissionGrantsList grants={[{ permissionKey: "inbox:manage" }, { permissionKey: "tasks:assign" }]} />,
      );
    });

    const rows = container.querySelectorAll("[data-permission-key]");
    expect(rows).toHaveLength(PERMISSION_KEYS.length);

    expect(rowFor("inbox:manage")?.dataset.granted).toBe("true");
    expect(rowFor("inbox:manage")?.textContent).toContain("granted");
    expect(rowFor("inbox:manage")?.textContent).not.toContain("not granted");
    expect(rowFor("tasks:assign")?.dataset.granted).toBe("true");

    expect(rowFor("users:invite")?.dataset.granted).toBe("false");
    expect(rowFor("users:invite")?.textContent).toContain("not granted");
  });

  it("shows every key as not granted when the agent has no grants", () => {
    act(() => {
      root.render(<AgentPermissionGrantsList grants={[]} />);
    });

    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-permission-key]"));
    expect(rows).toHaveLength(PERMISSION_KEYS.length);
    expect(rows.every((row) => row.dataset.granted === "false")).toBe(true);
  });

  it("has no edit controls", () => {
    act(() => {
      root.render(<AgentPermissionGrantsList grants={[{ permissionKey: "inbox:manage" }]} />);
    });

    expect(container.querySelector("button, input, [role='switch']")).toBeNull();
  });
});
