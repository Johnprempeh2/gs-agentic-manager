// @vitest-environment jsdom

// /issues/new is the home screen New task shortcut and the address Android
// opens when a page or text is shared to GSAM. It must open the new task form,
// filled from what was shared, over the task list; before this it was read as
// a task called "new".

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// jsdom's CSS parser rejects the custom-property marker rule stitches inserts
// (`--sxs{--sxs:N}`), pulled into <App>'s eager import graph transitively via
// @codesandbox/sandpack-react. Substitute a benign, valid rule on parse failure
// so stitches' index bookkeeping stays intact and the module graph evaluates.
// (sandpack itself is never exercised by the routing under test.)
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __pap13002Patched?: boolean;
  };
  if (!sheetProto.__pap13002Patched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".pap13002-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__pap13002Patched = true;
  }
});

// Real Layout renders the full authenticated shell (sidebar, data queries) and
// owns the "No company matches prefix" NotFound. For routing we only need it to
// resolve the :companyPrefix segment and render its nested routes.
vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

// Rendered by <App> outside <Routes> and needs DialogProvider; irrelevant here.
vi.mock("./components/OnDemandDialogs", () => ({
  OnDemandOnboarding: () => null,
}));

const openNewIssue = vi.fn();
vi.mock("./context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue, openOnboarding: vi.fn() }),
  useDialogState: () => ({ onboardingOpen: false, onboardingRouteDismissed: false }),
}));

vi.mock("./pages/Issues", () => ({ Issues: () => <div>ISSUES_PAGE</div> }));
vi.mock("./pages/IssueDetail", () => ({ IssueDetail: () => <div>ISSUE_DETAIL_PAGE</div> }));

vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

const PAP_COMPANY = {
  id: "company-1",
  name: "GS Agentic Manager",
  issuePrefix: "PAP",
  status: "active",
};
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [PAP_COMPANY],
    selectedCompanyId: PAP_COMPANY.id,
    selectedCompany: PAP_COMPANY,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function renderAppAt(container: HTMLElement, path: string) {
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  return root;
}

describe("App new task and share links", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("opens an empty new task form over the task list from the shortcut", async () => {
    const root = renderAppAt(container, "/issues/new");
    await vi.waitFor(() => expect(container.textContent).toContain("ISSUES_PAGE"));
    expect(container.textContent).not.toContain("ISSUE_DETAIL_PAGE");
    expect(openNewIssue).toHaveBeenCalledTimes(1);
    expect(openNewIssue).toHaveBeenCalledWith({});
    flushSync(() => root.unmount());
  });

  it("fills the form from a page shared to GSAM", async () => {
    const root = renderAppAt(container, "/issues/new?title=Acme%20pricing&url=https%3A%2F%2Facme.test%2Fpricing");
    await vi.waitFor(() => expect(container.textContent).toContain("ISSUES_PAGE"));
    expect(openNewIssue).toHaveBeenCalledTimes(1);
    expect(openNewIssue).toHaveBeenCalledWith({ title: "Acme pricing", description: "https://acme.test/pricing" });
    flushSync(() => root.unmount());
  });

  it("still opens a real task", async () => {
    const root = renderAppAt(container, "/PAP/issues/PAP-42");
    await vi.waitFor(() => expect(container.textContent).toContain("ISSUE_DETAIL_PAGE"));
    expect(openNewIssue).not.toHaveBeenCalled();
    flushSync(() => root.unmount());
  });
});
