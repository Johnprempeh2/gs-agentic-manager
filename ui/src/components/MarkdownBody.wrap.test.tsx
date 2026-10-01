// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: { children: ReactNode; to: string } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
  },
}));

describe("MarkdownBody code block wrapping", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  it("fades the edge of a wide table that has more to scroll to", () => {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <MarkdownBody>{"| Check | Result |\n|---|---|\n| Build | Pass |"}</MarkdownBody>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    const box = container.querySelector<HTMLDivElement>(".paperclip-markdown-table-scroll")!;
    expect(box).not.toBeNull();
    expect(box.hasAttribute("data-more-right")).toBe(false);

    // jsdom has no layout: give the box a table wider than itself, then scroll.
    Object.defineProperty(box, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(box, "scrollWidth", { configurable: true, value: 600 });
    flushSync(() => box.dispatchEvent(new Event("scroll")));
    expect(box.hasAttribute("data-more-right")).toBe(true);
    expect(box.hasAttribute("data-more-left")).toBe(false);

    box.scrollLeft = 300;
    flushSync(() => box.dispatchEvent(new Event("scroll")));
    expect(box.hasAttribute("data-more-left")).toBe(true);
    expect(box.hasAttribute("data-more-right")).toBe(false);
  });

  it("toggles fenced code blocks between horizontal scroll and wrapped lines", () => {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <MarkdownBody>{"```text\nlong line that can wrap when requested\n```"}</MarkdownBody>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });

    const pre = container.querySelector("pre");
    const actions = container.querySelector<HTMLDivElement>(
      ".paperclip-markdown-codeblock-actions",
    );
    const wrapButton = container.querySelector<HTMLButtonElement>(
      ".paperclip-markdown-codeblock-wrap",
    );

    expect(pre).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(wrapButton).not.toBeNull();
    expect(actions?.getAttribute("data-active")).toBeNull();
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("false");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Wrap lines");
    expect(pre?.style.overflowX).toBe("auto");
    expect(pre?.style.whiteSpace).toBe("");

    flushSync(() => {
      wrapButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(wrapButton?.getAttribute("aria-pressed")).toBe("true");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Unwrap lines");
    expect(actions?.getAttribute("data-active")).toBe("true");
    expect(pre?.style.overflowX).toBe("hidden");
    expect(pre?.style.whiteSpace).toBe("pre-wrap");
    expect(pre?.style.overflowWrap).toBe("anywhere");

    flushSync(() => {
      wrapButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(wrapButton?.getAttribute("aria-pressed")).toBe("false");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Wrap lines");
    expect(actions?.getAttribute("data-active")).toBeNull();
    expect(pre?.style.overflowX).toBe("auto");
    expect(pre?.style.whiteSpace).toBe("");
  });
});
