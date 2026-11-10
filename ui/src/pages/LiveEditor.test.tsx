// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { VersionList, type VersionItem } from "./LiveEditor";

const versions: VersionItem[] = [
  { id: "r3", version: 3, createdAt: "2026-11-10T02:00:00Z", restoreId: "r3", current: true, by: "you", what: "Edited by hand" },
  { id: "r2", version: 2, createdAt: "2026-11-09T18:30:00Z", restoreId: "r2", current: false, by: "Mica", what: "Live design" },
  { id: "r1", version: 1, createdAt: "2026-11-08T09:00:00Z", restoreId: null, current: false },
];

function show(props: Partial<Parameters<typeof VersionList>[0]> = {}) {
  const el = document.createElement("div");
  const onRestore = vi.fn();
  const onView = vi.fn();
  act(() => createRoot(el).render(<VersionList versions={versions} busy={false} unsaved={false} onRestore={onRestore} onView={onView} {...props} />));
  const button = (name: string) => [...el.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent) === name);
  return { el, onRestore, onView, button };
}

describe("VersionList", () => {
  it("says who saved each version and how, and offers a look and a restore on the earlier ones", () => {
    const { el, onRestore, onView, button } = show();
    const rows = [...el.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows[0]).toContain("Version 3 · Edited by hand");
    expect(rows[0]).toContain("by you");
    expect(rows[0]).toContain("Showing");
    expect(rows[1]).toContain("Version 2 · Live design");
    expect(rows[1]).toContain("by Mica");
    // The version on show has nothing to restore; one that cannot be restored offers nothing.
    expect(button("Restore version 3")).toBeUndefined();
    expect(button("Look at version 1")).toBeUndefined();
    act(() => button("Look at version 2")!.click());
    expect(onView).toHaveBeenCalledWith(versions[1]);
    expect(onRestore).not.toHaveBeenCalled();
    act(() => button("Restore version 2")!.click());
    expect(onRestore).toHaveBeenCalledWith("r2");
  });

  it("undoes the last change by restoring the version before it", () => {
    const { onRestore, button } = show();
    act(() => button("Undo last change")!.click());
    expect(onRestore).toHaveBeenCalledWith("r2");
  });

  it("holds restore while edits wait to be saved or the agent is working, and says why", () => {
    const unsaved = show({ unsaved: true });
    expect(unsaved.el.textContent).toContain("Save or undo your edits first.");
    expect(unsaved.button("Restore version 2")!.disabled).toBe(true);
    expect(unsaved.button("Look at version 2")!.disabled).toBe(true);
    expect(unsaved.button("Undo last change")!.disabled).toBe(true);
    const busy = show({ busy: true });
    expect(busy.el.textContent).toContain("The agent is working on the page.");
    expect(busy.button("Restore version 2")!.disabled).toBe(true);
    // Looking changes nothing, so it stays open while the agent works.
    expect(busy.button("Look at version 2")!.disabled).toBe(false);
  });
});
