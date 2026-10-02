// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { InlineEntitySelector } from "./InlineEntitySelector";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

describe("InlineEntitySelector", () => {
  let container: HTMLDivElement;
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    container.remove();
    document.body.innerHTML = "";
  });

  it("keeps handled search navigation keys inside the popover", async () => {
    const root = createRoot(container);
    const onChange = vi.fn();
    const documentKeyDown = vi.fn();
    document.addEventListener("keydown", documentKeyDown);

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[
            { id: "agent:agent-1", label: "CodexCoder" },
            { id: "agent:agent-2", label: "DesignBot" },
          ]}
          placeholder="Responsible"
          noneLabel="No responsible"
          searchPlaceholder="Search responsible..."
          emptyMessage="No responsible found."
          onChange={onChange}
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const searchInput = document.querySelector('input[placeholder="Search responsible..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    searchInput?.focus();

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      searchInput?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    });

    expect(documentKeyDown).not.toHaveBeenCalled();

    await act(async () => {
      searchInput?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });

    expect(documentKeyDown).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("agent:agent-1");

    document.removeEventListener("keydown", documentKeyDown);
    act(() => {
      root.unmount();
    });
  });

  it("focuses the search input when opened on coarse pointers", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const root = createRoot(container);

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[
            { id: "agent:agent-1", label: "CodexCoder" },
            { id: "agent:agent-2", label: "DesignBot" },
          ]}
          placeholder="Responsible"
          noneLabel="No responsible"
          searchPlaceholder="Search responsible..."
          emptyMessage="No responsible found."
          onChange={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const searchInput = document.querySelector('input[placeholder="Search responsible..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    expect(searchInput?.className).toContain("text-base");
    expect(document.querySelector("[data-mobile-entity-picker]")).not.toBeNull();
    expect(document.activeElement).toBe(searchInput);

    act(() => {
      root.unmount();
    });
  });

  it("opens on programmatic focus without toggling an open popover closed", async () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[{ id: "project-1", label: "Project One" }]}
          placeholder="Project"
          noneLabel="No project"
          searchPlaceholder="Search projects..."
          emptyMessage="No projects found."
          onChange={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.focus();
      await Promise.resolve();
    });
    expect(
      document.querySelector('input[placeholder="Search projects..."]'),
    ).not.toBeNull();

    await act(async () => {
      trigger?.focus();
      await Promise.resolve();
    });
    expect(
      document.querySelector('input[placeholder="Search projects..."]'),
    ).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it.each(["click", "focus"] as const)(
    "closes on Escape after a %s open and stays closed inside a dialog",
    async (openWith) => {
      const root = createRoot(container);
      const onDialogOpenChange = vi.fn();

      act(() => {
        root.render(
          <Dialog open onOpenChange={onDialogOpenChange}>
            <DialogContent>
              <DialogTitle>New task</DialogTitle>
              <input aria-label="Task title" />
              <InlineEntitySelector
                value=""
                options={[{ id: "agent:agent-1", label: "CodexCoder" }]}
                placeholder="Assignee"
                noneLabel="No assignee"
                searchPlaceholder="Search assignees..."
                emptyMessage="No assignees found."
                onChange={vi.fn()}
                triggerTestId="assignee-trigger"
                disablePortal
              />
            </DialogContent>
          </Dialog>,
        );
      });

      const trigger = document.querySelector('[data-testid="assignee-trigger"]') as HTMLButtonElement;
      expect(trigger).not.toBeNull();

      await act(async () => {
        if (openWith === "click") {
          trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        } else {
          trigger.focus();
        }
        await Promise.resolve();
      });

      const searchInput = document.querySelector('input[placeholder="Search assignees..."]') as HTMLInputElement;
      expect(searchInput).not.toBeNull();
      searchInput.focus();

      await act(async () => {
        searchInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
        await Promise.resolve();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(document.querySelector('input[placeholder="Search assignees..."]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(onDialogOpenChange).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      // A later keyboard focus still opens the picker.
      await act(async () => {
        trigger.blur();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      });
      await act(async () => {
        trigger.focus();
        await Promise.resolve();
      });
      expect(document.querySelector('input[placeholder="Search assignees..."]')).not.toBeNull();

      act(() => {
        root.unmount();
      });
    },
  );

  it("does not open the popover when disabled", async () => {
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[{ id: "agent:agent-1", label: "CodexCoder" }]}
          placeholder="Responsible"
          noneLabel="No responsible"
          searchPlaceholder="Search responsible..."
          emptyMessage="No responsible found."
          onChange={onChange}
          disabled
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger?.disabled).toBe(true);

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.querySelector('input[placeholder="Search responsible..."]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("filters options as the user types in the search box", async () => {
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[
            { id: "agent:agent-1", label: "CodexCoder" },
            { id: "agent:agent-2", label: "DesignBot" },
          ]}
          placeholder="Responsible"
          noneLabel="No responsible"
          searchPlaceholder="Search responsible..."
          emptyMessage="No responsible found."
          onChange={onChange}
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const searchInput = document.querySelector('input[placeholder="Search responsible..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    const nativeInputValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeInputValue?.call(searchInput, "design");
      searchInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const optionLabels = Array.from(document.querySelectorAll("[role='dialog'] button, .max-h-56 button")).map(
      (el) => el.textContent ?? "",
    );
    const joined = optionLabels.join("|");
    expect(joined).toContain("DesignBot");
    expect(joined).not.toContain("CodexCoder");

    act(() => {
      root.unmount();
    });
  });
  it("creates from unmatched search text on Enter and selects the new id", async () => {
    const root = createRoot(container);
    const onChange = vi.fn();
    const onCreate = vi.fn(async (name: string) => `project:${name}`);

    act(() => {
      root.render(
        <InlineEntitySelector
          value=""
          options={[{ id: "project-1", label: "Alpha" }]}
          placeholder="Project"
          noneLabel="No project"
          searchPlaceholder="Search projects..."
          emptyMessage="No projects found."
          onChange={onChange}
          onCreate={onCreate}
          createLabel={(name) => (name ? `Create project "${name}"` : "New project")}
        />,
      );
    });

    const trigger = container.querySelector("button") as HTMLButtonElement | null;
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const searchInput = document.querySelector('input[placeholder="Search projects..."]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(searchInput, "Inbox");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelector("[data-inline-entity-create]")?.textContent).toBe('Create project "Inbox"');

    await act(async () => {
      searchInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await Promise.resolve();
    });

    expect(onCreate).toHaveBeenCalledWith("Inbox");
    expect(onChange).toHaveBeenCalledWith("project:Inbox");

    act(() => {
      root.unmount();
    });
  });
});
