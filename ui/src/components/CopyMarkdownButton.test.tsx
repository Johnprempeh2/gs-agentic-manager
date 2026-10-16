// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyMarkdownButton } from "./CopyMarkdownButton";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class FakeClipboardItem {
  constructor(public readonly items: Record<string, Blob>) {}
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("CopyMarkdownButton", () => {
  it("writes clean html and plain text, then shows Copied", async () => {
    const write = vi.fn(async (_items: FakeClipboardItem[]) => {});
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<CopyMarkdownButton markdown={"Hi Martyn,\n\n1. One\n2. **Two**"} />);
    });
    const button = container.querySelector("button")!;
    await act(async () => {
      button.click();
    });

    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0]![0][0]!;
    const html = await item.items["text/html"]!.text();
    const text = await item.items["text/plain"]!.text();
    expect(html).toContain("<ol>");
    expect(html).toContain("<strong>Two</strong>");
    expect(html).not.toMatch(/style=|class=/);
    expect(text).toBe("Hi Martyn,\n\n1. One\n2. Two");
    expect(button.textContent).toBe("Copied");

    await act(async () => root.unmount());
  });
});
