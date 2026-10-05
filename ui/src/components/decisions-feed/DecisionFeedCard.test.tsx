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
  humanReviewCard,
  mergedCard,
  noOwnerCard,
  questionCard,
  reviewCard,
  setupCard,
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
  AttentionInteractionResolver: ({ interactionId, embedded }: { interactionId: string; embedded?: boolean }) => (
    <div data-testid="inline-question" data-embedded={embedded ? "true" : "false"}>{interactionId}</div>
  ),
}));
vi.mock("../MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("../DecisionResolver", () => ({ DecisionResolver: () => <div data-testid="inline-decision" /> }));

import { DecisionFeedCard, decisionKindLabel, visibleCardActions } from "./DecisionFeedCard";

/** A confirmation: the feed files it under "question" (GRE-360). */
function confirmationCard(): DecisionCard {
  const card = questionCard("int-7", "issue-42", "GRE-42");
  card.reason = "Confirmation requested";
  card.items = card.items.map((item) => ({
    ...item,
    subject: { ...item.subject, metadata: { ...item.subject.metadata, kind: "request_confirmation" } },
  })) as DecisionCard["items"];
  return card;
}

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

  it("labels a confirmation Confirmation, once, and embeds its answer without a second header", () => {
    render(confirmationCard());
    const chips = [...container.querySelectorAll("[data-decision-card] span.rounded-full")].map((el) => el.textContent);
    expect(chips).toEqual(["Confirmation"]);
    expect(container.textContent).not.toContain("Question");
    expect(container.textContent?.split("Confirmation requested").length).toBe(2);
    expect(container.querySelector("[data-testid='inline-question']")?.getAttribute("data-embedded")).toBe("true");
  });

  it("names each answered-in-place kind for what it asks", () => {
    expect(decisionKindLabel(questionCard(), "question")).toBe("Question");
    expect(decisionKindLabel(confirmationCard(), "question")).toBe("Confirmation");
    expect(decisionKindLabel(blockedCard(), "blocked")).toBe("Blocked");
  });

  it("folds the task actions into More when the card is answered in place", async () => {
    render(questionCard());
    expect(hasButton("Reassign")).toBe(false);
    expect(hasButton("Give an instruction")).toBe(false);
    expect(hasButton("Cancel the task")).toBe(false);
    expect(hasButton("Ask for clarity")).toBe(true);
    expect(hasButton("Not now")).toBe(true);
    const more = button("More actions");
    await act(async () => {
      more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    const items = [...document.querySelectorAll("[role='menuitem']")].map((el) => el.textContent?.trim());
    expect(items).toEqual(["Reassign", "Give an instruction", "Cancel the task"]);
    await click(document.querySelector("[role='menuitem']:last-child") as HTMLElement);
    await click(button("Yes, cancel the task"));
    expect(api.patch).toHaveBeenCalledWith("/issues/issue-44", { status: "cancelled" });
  });

  it("keeps a blocked card's actions as buttons", () => {
    render(blockedCard());
    expect(hasButton("Reassign")).toBe(true);
    expect(hasButton("More actions")).toBe(false);
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

  it("shows the task's screenshots once each, and none on a card without them", () => {
    const card = questionCard();
    const shot = (assetId: string) => ({ assetId, alt: `${assetId}.png` });
    card.items = card.items.map((item, index) => ({
      ...item,
      detail: { kind: "generic", summaryExcerpt: "", images: index === 0 ? [shot("option-a"), shot("option-b")] : [shot("option-a")] },
    })) as DecisionCard["items"];
    card.items.push({ ...card.items[0]!, id: "extra-row" });
    render(card);
    const images = [...container.querySelectorAll("[data-decision-images] img")].map((img) => img.getAttribute("src"));
    expect(images).toEqual(["/api/assets/option-a/content", "/api/assets/option-b/content"]);
    expect(button("Open image 2 of 2, option-b.png")).toBeTruthy();

    render(blockedCard());
    expect(container.querySelector("[data-decision-images]")).toBeNull();
  });

  it("shows the task's deliverable inline, and lets John switch between several (GRE-451)", () => {
    const card = confirmationCard();
    const deliverable = (id: string, title: string) => ({
      id,
      title,
      contentType: "text/html",
      contentPath: `/api/attachments/${id}/content`,
      originalFilename: `${id}.html`,
    });
    card.items = card.items.map((item) => ({
      ...item,
      detail: {
        kind: "confirmation",
        promptExcerpt: "Approve the pricing deck?",
        isPlanTarget: false,
        images: [],
        deliverables: [deliverable("deck-v2", "Pricing deck"), deliverable("brief-v1", "Pricing brief")],
      },
    })) as DecisionCard["items"];
    render(card);

    const section = container.querySelector("[data-decision-deliverable]");
    expect(section).not.toBeNull();
    const frame = () => section!.querySelector("[data-testid='deliverable-preview-frame']") as HTMLIFrameElement;
    expect(frame().getAttribute("src")).toBe("/api/attachments/deck-v2/content");
    expect(frame().getAttribute("sandbox")).toBeTruthy();
    const open = [...section!.querySelectorAll("a")].find((link) => link.textContent?.includes("Open full size"));
    expect(open?.getAttribute("href")).toBe("/api/attachments/deck-v2/content");

    act(() => button("Pricing brief").click());
    expect(frame().getAttribute("src")).toBe("/api/attachments/brief-v1/content");
    expect(button("Pricing brief").getAttribute("aria-pressed")).toBe("true");

    render(blockedCard());
    expect(container.querySelector("[data-decision-deliverable]")).toBeNull();
  });

  it("keeps ask_clarity out of the plain action buttons", () => {
    expect(visibleCardActions(blockedCard()).map((action) => action.id)).toEqual(["reassign", "instruct", "cancel_task"]);
    expect(visibleCardActions(questionCard()).map((action) => action.id)).not.toContain("open");
  });
});

describe("DecisionFeedCard for a repeated setup failure (GRE-504)", () => {
  it("shows the count, last seen, the stopped tasks and the fix link on one card", () => {
    render(setupCard());
    const card = document.querySelector("[data-decision-card]")!;
    expect(card.querySelector("[data-setup-count]")?.textContent).toMatch(/^4 failures, last /);
    const links = [...card.querySelectorAll("a")].map((link) => [link.textContent?.trim(), link.getAttribute("href")]);
    expect(links).toEqual(expect.arrayContaining([
      ["GRE-601", "/issues/GRE-601"],
      ["GRE-602", "/issues/GRE-602"],
      ["Fix setup", "/agents/agent-everest/runtime"],
    ]));
    // A card for several tasks has no single task to table or ask about.
    expect(hasButton("Not now")).toBe(false);
    expect(hasButton("Ask for clarity")).toBe(false);
  });

  it("Retry all sends every stopped task back in one press", async () => {
    render(setupCard());
    await click(button("Retry all 2"));
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(api.post).toHaveBeenCalledWith("/issues/issue-602/recovery-actions/resolve", expect.objectContaining({ actionId: "rec-602" }));
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

  it("puts no task action in front of a confirmation's own Approve", () => {
    render(confirmationCard());
    const actionRow = button("More actions").parentElement!;
    const labels = [...actionRow.querySelectorAll("button")].map((entry) => entry.textContent?.trim());
    expect(labels).toEqual(["Not now", "More"]);
  });
});

describe("review card (GRE-870)", () => {
  it("names the reviewer and shows Approve and Request changes", () => {
    render(humanReviewCard());
    expect(container.textContent).toContain("You (John Prempeh)");
    expect(container.textContent).toContain("Mason");
    expect(container.textContent).not.toContain("No agent owns this yet.");
    expect(hasButton("Approve")).toBe(true);
    expect(hasButton("Request changes")).toBe(true);
  });

  it("approves with one click through the issue's own review decision", async () => {
    render(humanReviewCard());
    await click(button("Approve"));
    expect(api.patch).toHaveBeenCalledWith("/issues/issue-800", { status: "done", comment: "Approved from Decisions." });
    expect(onActed).toHaveBeenCalled();
  });

  it("asks what must change before it sends the task back", async () => {
    render(humanReviewCard());
    await click(button("Request changes"));
    expect(api.patch).not.toHaveBeenCalled();
    const field = container.querySelector("textarea, input[aria-label='What must change']") as HTMLTextAreaElement;
    expect(field).not.toBeNull();
    const submits = buttons().filter((entry) => entry.textContent?.trim() === "Request changes");
    expect(submits.at(-1)!.disabled).toBe(true);
    typeInto(field, "Render the HTML part as a page.");
    await click(buttons().filter((entry) => entry.textContent?.trim() === "Request changes").at(-1)!);
    expect(api.patch).toHaveBeenCalledWith("/issues/issue-800", { status: "in_progress", comment: "Render the HTML part as a page." });
  });

  it("shows another user's review without verdict buttons", () => {
    const card = humanReviewCard();
    card.reviewer = { type: "user", id: "user-john", name: "John Prempeh", isYou: false };
    card.actions = card.actions.filter((action) => action.id !== "approve" && action.id !== "request_changes");
    render(card);
    expect(container.textContent).toContain("John Prempeh");
    expect(container.textContent).not.toContain("You (John Prempeh)");
    expect(hasButton("Approve")).toBe(false);
    expect(hasButton("Request changes")).toBe(false);
  });
});
