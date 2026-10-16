// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyboardShortcutsCheatsheetContent } from "./KeyboardShortcutsCheatsheet";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

describe("KeyboardShortcutsCheatsheet", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("does not advertise the retired sidebar collapse shortcut", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KeyboardShortcutsCheatsheetContent />);
    });

    const row = [...container.querySelectorAll("span")].find(
      (node) => node.textContent?.trim() === "Collapse or expand sidebar",
    )?.parentElement;
    expect(row).toBeUndefined();

    flushSync(() => {
      root.unmount();
    });
  });

  it("always lists search and Ask Everest, and says when single-key shortcuts are off", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KeyboardShortcutsCheatsheetContent singleKeysEnabled={false} />);
    });
    expect(container.textContent).toContain("Search everything, or type a command");
    expect(container.textContent).toContain("Ask Everest a question");
    const note = container.querySelector('[data-testid="shortcuts-off-note"]');
    expect(note?.querySelector("a")?.getAttribute("href")).toBe("/company/settings/instance/profile");
    flushSync(() => {
      root.render(<KeyboardShortcutsCheatsheetContent singleKeysEnabled />);
    });
    expect(container.querySelector('[data-testid="shortcuts-off-note"]')).toBeNull();
    flushSync(() => {
      root.unmount();
    });
  });
});
