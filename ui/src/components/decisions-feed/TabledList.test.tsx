// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_COMPANY_ID, tabledIssue } from "../../fixtures/decisionsFeedFixtures";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));

vi.mock("../../api/client", () => ({ api }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { TabledList, tabledReturnLabel } from "./TabledList";
import { TabledBanner } from "./TabledBanner";

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

function render(node: ReactNode) {
  act(() => root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.post.mockReset().mockResolvedValue({});
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Tabled list", () => {
  const issues = [
    tabledIssue("issue-5", "GRE-5", "Renew the domain", "2026-10-12T07:00:00.000Z"),
    tabledIssue("issue-6", "GRE-6", "Tidy the shared drive", null),
  ];

  it("lists each tabled task with its return date and Bring back", () => {
    render(<TabledList companyId={FIXTURE_COMPANY_ID} issues={issues} />);
    expect(container.textContent).toContain("GRE-5 Renew the domain");
    expect(container.textContent).toContain("Comes back");
    expect(container.textContent).toContain("Until you bring it back");
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });

  it("Bring back calls the server for that task", async () => {
    render(<TabledList companyId={FIXTURE_COMPANY_ID} issues={issues} />);
    await act(async () => (container.querySelector("[aria-label='Bring back GRE-6']") as HTMLButtonElement).click());
    expect(api.post).toHaveBeenCalledWith("/issues/issue-6/bring-back", {});
  });

  it("says so when nothing is set aside", () => {
    render(<TabledList companyId={FIXTURE_COMPANY_ID} issues={[]} />);
    expect(container.textContent).toContain("Nothing is set aside.");
  });

  it("labels the return date", () => {
    expect(tabledReturnLabel({ tabledUntil: null })).toBe("Until you bring it back");
    expect(tabledReturnLabel({ tabledUntil: new Date("2026-10-12T07:00:00.000Z") })).toMatch(/^Comes back /);
  });
});

describe("Task page banner", () => {
  it("shows only while the task is tabled, with Bring back", async () => {
    render(<TabledBanner issue={{ ...tabledIssue("issue-5", "GRE-5", "Renew the domain", null), tabledAt: null }} />);
    expect(container.textContent).toBe("");
    render(<TabledBanner issue={tabledIssue("issue-5", "GRE-5", "Renew the domain", null)} />);
    expect(container.textContent).toContain("Set aside (Not now).");
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    expect(api.post).toHaveBeenCalledWith("/issues/issue-5/bring-back", {});
  });
});
