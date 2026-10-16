// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequestDraftReviewInteraction } from "../lib/issue-thread-interactions";
import { IssueThreadInteractionCard } from "./IssueThreadInteractionCard";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const issuesApiMocks = vi.hoisted(() => ({
  acceptInteraction: vi.fn(),
  rejectInteraction: vi.fn(),
}));
vi.mock("../api/issues", () => ({ issuesApi: issuesApiMocks }));
const clipboardMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: clipboardMock }));

const BODY = "Dear Martyn,\n\nThanks for the call.";

const draft: RequestDraftReviewInteraction = {
  id: "draft-1",
  companyId: "company-1",
  issueId: "issue-1",
  kind: "request_draft_review",
  status: "pending",
  continuationPolicy: "wake_assignee",
  resolverPolicy: "human_only",
  requestedResolverPolicy: "human_only",
  effectiveResolverPolicy: "human_only",
  resolverPolicyProvenance: "inherited",
  effectiveResolverPolicySource: "governed_action",
  legacyResolverPolicyAliases: { requested: null, effective: null },
  createdByAgentId: "agent-1",
  createdByUserId: null,
  title: "Draft email to Indago",
  payload: { version: 1, purpose: "Email to Indago", body: BODY, channel: "email" },
  createdAt: "2026-10-14T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(interaction: RequestDraftReviewInteraction) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ThemeProvider>
            <IssueThreadInteractionCard interaction={interaction} />
          </ThemeProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("DraftReviewCard", () => {
  it("enables Send edits only after an edit and sends the edited text", async () => {
    issuesApiMocks.acceptInteraction.mockResolvedValue({ ...draft, status: "accepted" });
    const host = render(draft);
    const textarea = host.querySelector("textarea")!;
    expect(textarea.value).toBe(BODY);
    expect(button(host, "Send edits").disabled).toBe(true);
    expect(button(host, "Approve as is").disabled).toBe(false);

    typeInto(textarea, "Hi Martyn,\n\nThanks for the call.");
    expect(host.textContent).toContain("1 change");
    expect(host.textContent).toContain("Send your edits to");
    expect(button(host, "Send edits").disabled).toBe(false);
    expect(button(host, "Approve as is").disabled).toBe(true);

    await act(async () => {
      button(host, "Send edits").click();
    });
    expect(issuesApiMocks.acceptInteraction).toHaveBeenCalledWith("issue-1", "draft-1", {
      editedBody: "Hi Martyn,\n\nThanks for the call.",
      learnFromEdits: true,
    });
  });

  it("copies the current text", async () => {
    const host = render(draft);
    await act(async () => {
      button(host, "Copy").click();
    });
    expect(clipboardMock).toHaveBeenCalledWith(BODY);
    expect(host.textContent).toContain("Copied");
  });

  it("asks for a redraft with a note", async () => {
    issuesApiMocks.rejectInteraction.mockResolvedValue({ ...draft, status: "rejected" });
    const host = render(draft);
    act(() => button(host, "Ask for a redraft").click());
    const note = host.querySelectorAll("textarea")[1] as HTMLTextAreaElement;
    typeInto(note, "Warmer please");
    await act(async () => {
      button(host, "Send redraft request").click();
    });
    expect(issuesApiMocks.rejectInteraction).toHaveBeenCalledWith("issue-1", "draft-1", "Warmer please");
  });

  it("shows the final text and a collapsible word diff once edits are sent", () => {
    const host = render({
      ...draft,
      status: "accepted",
      resolvedByUserId: "user-1",
      resolvedAt: "2026-10-14T10:05:00.000Z",
      result: {
        version: 1,
        outcome: "accepted",
        draft: {
          originalBody: BODY,
          finalBody: "Hi Martyn,\n\nThanks for the call.",
          edited: true,
          changeCount: 1,
          diff: [
            { type: "removed", text: "Dear" },
            { type: "added", text: "Hi" },
            { type: "same", text: " Martyn,\n\nThanks for the call." },
          ],
          editSummary: "1 change, 1 words removed, 1 words added.",
          learnFromEdits: true,
        },
      },
    });
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toContain("Edits sent (1 change)");
    act(() => button(host, "What changed").click());
    expect(host.querySelector("del")?.textContent).toBe("Dear");
    expect(host.querySelector("ins")?.textContent).toBe("Hi");
  });
});
