// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionCard } from "@greatstone/shared";
import {
  FIXTURE_COMPANY_ID,
  approvalCard,
  blockedCard,
  connectionAlertCard,
  failedRunCard,
  fixtureAgents,
  mergedCard,
  noOwnerCard,
  questionCard,
  reviewCard,
} from "../../fixtures/decisionsFeedFixtures";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  pushToast: vi.fn(),
}));

vi.mock("../../api/client", () => ({ api: { get: api.get, post: api.post, patch: api.patch } }));
vi.mock("../../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: api.pushToast }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
// The inline question form has its own tests; here it only has to appear.
vi.mock("../AttentionInteractionResolver", () => ({
  AttentionInteractionResolver: ({ interactionId }: { interactionId: string }) => (
    <div data-testid="inline-question">{interactionId}</div>
  ),
}));
vi.mock("../MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("../DecisionResolver", () => ({ DecisionResolver: () => <div data-testid="inline-decision" /> }));

import { DecisionFeedCard, visibleCardActions } from "./DecisionFeedCard";

if (!globalThis.PointerEvent) {
  (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent;
}
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const onActed = vi.fn();

function render(card: DecisionCard) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DecisionFeedCard
          card={card}
          companyId={FIXTURE_COMPANY_ID}
          assignableAgents={fixtureAgents}
          onActed={onActed}
        />
      </QueryClientProvider>,
    );
  });
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")] as HTMLButtonElement[];
}

function button(label: string): HTMLButtonElement {
  const match = buttons().find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No button "${label}". Have: ${buttons().map((b) => b.textContent?.trim()).join(", ")}`);
  return match;
}

function hasButton(label: string) {
  return buttons().some((entry) => entry.getAttribute("aria-label") === label || entry.textContent?.trim() === label);
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  // Let a rejected mutation settle into its error state.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function typeInto(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pickSelectOption(label: string, optionText: string) {
  const trigger = document.querySelector(`[aria-label="${label}"]`) as HTMLElement;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const option = [...document.querySelectorAll("[role='option']")].find((entry) => entry.textContent?.trim() === optionText);
  if (!option) throw new Error(`No option "${optionText}"`);
  await act(async () => {
    (option as HTMLElement).focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.get.mockReset().mockResolvedValue([]);
  api.post.mockReset().mockResolvedValue({});
  api.patch.mockReset().mockResolvedValue({});
  api.pushToast.mockReset();
  onActed.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("DecisionFeedCard rendering per kind", () => {
  it.each([
    ["question", questionCard(), "Question"],
    ["approval", approvalCard(), "Approval"],
    ["blocked", blockedCard(), "Blocked"],
    ["failed run", failedRunCard(), "Failed run"],
    ["review", reviewCard(), "Review"],
    ["merged GRE-138", mergedCard(), "Stopped"],
  ])("a %s card says what is blocked, why, who waits and what happens next", (_name, card, kindLabel) => {
    render(card);
    const text = container.textContent ?? "";
    expect(text).toContain(kindLabel);
    expect(text).toContain(card.title);
    expect(text).toContain("Why");
    expect(text).toContain(card.reason);
    expect(text).toContain("Waiting");
    expect(text).toContain(card.waiting!.name);
    expect(text).toContain("Next");
    expect(text).toContain(card.nextStep);
    expect(hasButton("Ask for clarity")).toBe(true);
    expect(hasButton("Not now")).toBe(true);
  });

  it("shows every merged kind on one card", () => {
    render(mergedCard());
    const chips = [...container.querySelectorAll("[data-decision-card] span.rounded-full")].map((el) => el.textContent);
    expect(chips).toEqual(["Stopped", "Failed run", "Connection"]);
  });

  it("answers a question in place, without the Answer link", () => {
    render(questionCard());
    expect(container.querySelector("[data-testid='inline-question']")?.textContent).toBe("int-1");
    expect(hasButton("Answer")).toBe(false);
    expect(container.querySelector("a[href='/issues/GRE-44']")).not.toBeNull();
  });

  it("a company-level card has no Not now or Ask for clarity", () => {
    render(connectionAlertCard());
    expect(container.textContent).toContain("No agent owns this yet.");
    expect(hasButton("Not now")).toBe(false);
    expect(hasButton("Ask for clarity")).toBe(false);
    const link = container.querySelector("a[href='/settings/ai-connections']");
    expect(link?.textContent).toContain("Reconnect");
  });

  it("disables Ask for clarity when no agent owns the task", () => {
    render(noOwnerCard());
    expect(button("Ask for clarity").disabled).toBe(true);
    expect(button("Ask for clarity").title).toContain("Reassign it first");
  });

  it("shows the agent's answer to an earlier question on the same card", () => {
    render(mergedCard());
    const clarity = container.querySelector("[data-clarity]")!;
    expect(clarity.textContent).toContain("Did the backup finish before it stopped?");
    expect(clarity.textContent).toContain("Ridge answered");
    expect(clarity.textContent).toContain("It copied 3 of 5 folders.");
  });

  it("says it is waiting while the question has no answer yet", () => {
    const card = mergedCard();
    card.clarity = { ...card.clarity!, answer: null };
    render(card);
    expect(container.querySelector("[data-clarity]")?.textContent).toContain("Waiting for Ridge to answer.");
  });

  it("keeps ask_clarity out of the plain action buttons", () => {
    expect(visibleCardActions(blockedCard()).map((action) => action.id)).toEqual(["reassign", "instruct", "cancel_task"]);
    expect(visibleCardActions(questionCard()).map((action) => action.id)).not.toContain("open");
  });
});

describe("DecisionFeedCard actions", () => {
  it("Retry runs its request at once and refreshes", async () => {
    render(failedRunCard());
    await click(button("Retry"));
    expect(api.post).toHaveBeenCalledWith("/agents/agent-ridge/wakeup", {
      source: "on_demand",
      reason: "retry_failed_run",
      failedRunId: "run-9",
    });
    expect(onActed).toHaveBeenCalled();
  });

  it("Approve posts to the approval", async () => {
    render(approvalCard());
    await click(button("Approve"));
    expect(api.post).toHaveBeenCalledWith("/approvals/appr-1/approve", {});
  });

  it("Give an instruction sends the text as the comment body", async () => {
    render(blockedCard());
    await click(button("Give an instruction"));
    const field = container.querySelector("textarea[aria-label='Instruction']") as HTMLTextAreaElement;
    // The confirm button is disabled until the required text is there.
    const confirm = [...container.querySelectorAll("form button[type='submit']")][0] as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    typeInto(field, "Split the move into two batches.");
    await click(confirm);
    expect(api.post).toHaveBeenCalledWith("/issues/issue-201/comments", {
      resume: true,
      body: "Split the move into two batches.",
    });
  });

  it("Reassign picks a named agent", async () => {
    render(blockedCard());
    await click(button("Reassign"));
    await pickSelectOption("New owner", "Mica");
    const confirm = container.querySelector("form button[type='submit']") as HTMLButtonElement;
    await click(confirm);
    expect(api.patch).toHaveBeenCalledWith("/issues/issue-201", { assigneeUserId: null, assigneeAgentId: "agent-mica" });
  });

  it("Mark resolved asks where the task goes", async () => {
    render(mergedCard());
    await click(button("Mark resolved"));
    await pickSelectOption("Task goes to", "In review");
    await click(container.querySelector("form button[type='submit']") as HTMLButtonElement);
    expect(api.post).toHaveBeenCalledWith("/issues/issue-138/recovery-actions/resolve", {
      actionId: "rec-1",
      outcome: "restored",
      sourceIssueStatus: "in_review",
    });
  });

  it("Cancel the task asks to confirm first", async () => {
    render(blockedCard());
    await click(button("Cancel the task"));
    expect(api.patch).not.toHaveBeenCalled();
    await click(button("Yes, cancel the task"));
    expect(api.patch).toHaveBeenCalledWith("/issues/issue-201", { status: "cancelled" });
  });

  it("shows the server error on the card", async () => {
    api.post.mockRejectedValueOnce(new Error("Agent is paused"));
    render(failedRunCard());
    await click(button("Retry"));
    expect(container.querySelector("[role='alert']")?.textContent).toBe("Agent is paused");
  });
});

describe("Ask for clarity", () => {
  it("posts a short question to the card and refreshes", async () => {
    render(blockedCard());
    await click(button("Ask for clarity"));
    const field = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(container.textContent).toContain("Ask Summit a short question");
    typeInto(field, "  What is left to move?  ");
    await click(button("Ask"));
    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, body] = api.post.mock.calls[0]!;
    expect(path).toBe(`/companies/${FIXTURE_COMPANY_ID}/decisions-feed/cards/task%3Aissue-201/clarity`);
    expect(body).toMatchObject({ question: "What is left to move?" });
    expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(onActed).toHaveBeenCalled();
    // The form closes; the answer arrives on the refreshed card.
    expect(container.querySelector("textarea")).toBeNull();
  });
});

describe("Not now", () => {
  it("tables the task until brought back when no date is set", async () => {
    render(blockedCard());
    await click(button("Not now"));
    await click(button("Set aside until I bring it back"));
    expect(api.post).toHaveBeenCalledWith("/issues/issue-201/table", { returnAt: null });
    expect(api.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Set aside" }));
    expect(onActed).toHaveBeenCalled();
  });

  it("sends the chosen return date at 09:00 local time", async () => {
    render(blockedCard());
    await click(button("Not now"));
    const dateInput = document.querySelector("input[type='date']") as HTMLInputElement;
    typeInto(dateInput, "2026-10-12");
    await click(button("Set aside"));
    expect(api.post).toHaveBeenCalledWith("/issues/issue-201/table", {
      returnAt: new Date(2026, 9, 12, 9, 0, 0, 0).toISOString(),
    });
  });
});

describe("DecisionFeedCard on a phone", () => {
  const originalMatchMedia = window.matchMedia;
  beforeEach(() => {
    // Phone width: the (width < 40rem) query matches.
    window.matchMedia = ((query: string) => ({
      matches: query.includes("40rem"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("shows the main action and Not now up front, the rest in More, and Cancel still confirms", async () => {
    render(blockedCard());
    expect(hasButton("More actions")).toBe(true);
    expect(hasButton("Cancel the task")).toBe(false);
    await click(button("More actions"));
    const sheet = document.querySelector("[role='dialog']");
    expect(sheet?.textContent).toContain("Cancel the task");
    expect(sheet?.textContent).toContain("Ask for clarity");
    await click(button("Cancel the task"));
    expect(api.patch).not.toHaveBeenCalled();
    await click(button("Yes, cancel the task"));
    expect(api.patch).toHaveBeenCalledWith("/issues/issue-201", { status: "cancelled" });
  });
});
