// @vitest-environment jsdom

// Bare links such as /inbox/mine, /morning and /notifications (an old bookmark,
// a link pasted into a phone, a home screen shortcut) must open the page under
// the selected company. Without a redirect the first segment is read as a
// company prefix ("INBOX") and the page shows "Organization not found".

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

// Sentinel pages so we can assert *which* route resolved.
vi.mock("./pages/Inbox", () => ({ Inbox: () => <div>INBOX_PAGE</div> }));
vi.mock("./pages/MorningSummary", () => ({ MorningSummary: () => <div>MORNING_PAGE</div> }));
vi.mock("./pages/NotificationSettings", () => ({ NotificationSettings: () => <div>NOTIFICATIONS_PAGE</div> }));

// Cloud access is unrelated to the route-table regression. Let it fall through
// synchronously so this test does not poll its three query transitions.
vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

// The prefix resolver + redirect logic both read the active company.
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

async function renderAppAt(container: HTMLElement, path: string) {
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

/**
 * Waits on the condition, not on a fixed number of turns. The previous version
 * yielded at most three macrotasks before asserting, which is ample on an idle
 * machine and not when the suite is running many workers in parallel — the
 * container was still empty and the assertion failed on a route that resolves
 * perfectly well. `vi.waitFor` retries against a time budget instead, so a
 * loaded worker gets more turns rather than a failure.
 *
 * The same fix #11499 applied to the sibling `App.activity-routing.test.tsx`,
 * which had the identical loop with five turns instead of three.
 */
async function waitForRoute(container: HTMLElement, text: string) {
  await vi.waitFor(() => expect(container.textContent).toContain(text));
}

describe("App unprefixed board links", () => {
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

  it.each([
    ["/inbox/mine", "INBOX_PAGE"],
    ["/morning", "MORNING_PAGE"],
    ["/today", "MORNING_PAGE"],
    ["/notifications", "NOTIFICATIONS_PAGE"],
  ])("opens %s under the selected company", async (path, sentinel) => {
    const root = await renderAppAt(container, path);
    await waitForRoute(container, sentinel);
    expect(container.textContent).not.toContain("No organization matches prefix");
    flushSync(() => root.unmount());
  });

  it("still opens a company-prefixed link as before", async () => {
    const root = await renderAppAt(container, "/PAP/inbox/mine");
    await waitForRoute(container, "INBOX_PAGE");
    flushSync(() => root.unmount());
  });
});
