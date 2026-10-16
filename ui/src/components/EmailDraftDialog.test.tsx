// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailDraftDialog, splitRecipients } from "./EmailDraftDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mailboxes = vi.hoisted(() => ({ list: vi.fn(), saveDraft: vi.fn() }));
vi.mock("../api/mailboxes", () => ({ mailboxesApi: mailboxes }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/lib/router", () => ({ Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a> }));

describe("EmailDraftDialog", () => {
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

  it("splits typed recipients", () => {
    expect(splitRecipients(" a@x.com, b@y.com; c@z.com  ")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
  });

  it("points to Mailboxes when no mailbox takes drafts, and offers no save", async () => {
    mailboxes.list.mockResolvedValue([{ id: "m", label: "Team", address: "t@x.com", allowDrafts: false }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <EmailDraftDialog open onOpenChange={() => {}} companyId="company-1" title="Status email" seed={{ to: [], subject: "s", text: "t" }} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector("[data-testid='email-draft-no-mailbox']")?.textContent).toContain("Turn on drafts");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Save as draft")).toBe(false);
  });
});
