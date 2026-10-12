// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { MarkdownBody } from "./MarkdownBody";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: { children: React.ReactNode; to: string } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useOptionalCompany: () => ({ selectedCompanyId: "company-1", companies: [] }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function renderMarkdown(
  children: string,
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  }),
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  flushSync(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MarkdownBody>{children}</MarkdownBody>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });

  return container;
}

function click(element: Element | null) {
  if (!element) throw new Error("Expected element to exist");
  flushSync(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("MarkdownBody code block interactions", () => {
  it("toggles line wrapping for indented preformatted markdown blocks", () => {
    const node = renderMarkdown("Plan:\n\n    source fetch/sync -> signal inbox");
    const pre = node.querySelector("pre");
    const wrapButton = node.querySelector<HTMLButtonElement>(".paperclip-markdown-codeblock-wrap");

    expect(pre?.style.whiteSpace).toBe("");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Wrap lines");

    click(wrapButton);

    expect(pre?.style.whiteSpace).toBe("pre-wrap");
    expect(pre?.style.overflowWrap).toBe("anywhere");
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("true");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Unwrap lines");

    click(wrapButton);

    expect(pre?.style.whiteSpace).toBe("");
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("false");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Wrap lines");
  });
});

describe("MarkdownBody issue mention chips", () => {
  const pap7 = {
    id: "issue-7",
    identifier: "PAP-7",
    companyId: "company-1",
    projectId: null,
    parentId: null,
    title: "Ship the release",
    description: null,
    status: "done",
    priority: "medium",
    workMode: "standard",
    assigneeAgentId: null,
    assigneeUserId: null,
    executionRunId: null,
    issueNumber: 7,
    requestDepth: 0,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  };
  const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

  beforeEach(() => {
    vi.mocked(issuesApi.get).mockReset().mockResolvedValue(undefined as never);
  });

  it("paints chips from a cached issue list and fetches only the task it lacks", async () => {
    const queryClient = newQueryClient();
    queryClient.setQueryData(queryKeys.issues.mentionPool("company-1"), [pap7]);

    const node = renderMarkdown("See PAP-7 and PAP-8.", queryClient);
    await Promise.resolve();

    expect(node.querySelector('[aria-label="Issue PAP-7: Ship the release"]')).not.toBeNull();
    expect(vi.mocked(issuesApi.get).mock.calls).toEqual([["PAP-8"]]);
  });

  it("waits for the page's first issue-list load instead of racing it", async () => {
    const queryClient = newQueryClient();
    let resolvePool: (rows: unknown[]) => void = () => {};
    void queryClient.fetchQuery({
      queryKey: queryKeys.issues.mentionPool("company-1"),
      queryFn: () => new Promise<unknown[]>((resolve) => { resolvePool = resolve; }),
    });

    const node = renderMarkdown("See PAP-7.", queryClient);
    await act(async () => { await Promise.resolve(); });
    expect(issuesApi.get).not.toHaveBeenCalled();

    // Query cache notifications are batched onto the next macrotask.
    await act(async () => {
      resolvePool([pap7]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(node.querySelector('[aria-label="Issue PAP-7: Ship the release"]')).not.toBeNull();
    expect(issuesApi.get).not.toHaveBeenCalled();
  });
});
