// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateDeliverableCommentInput, DeliverableComment } from "../../api/deliverables";
import { DeliverableCommentsPanel, DeliverableReviewFrame, useDeliverableReview } from "./DeliverableComments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// GRE-982: select a passage, draft a note, edit, delete, then send them all.
// GRE-1223: pick an element or draw an area and comment on it the same way.

const store = vi.hoisted(() => ({ comments: [] as DeliverableComment[], next: 1 }));

const deliverablesApiMock = vi.hoisted(() => ({
  reviewContentPath: (companyId: string, id: string) => `/api/companies/${companyId}/deliverables/${id}/review-content`,
  listComments: vi.fn(async () => ({ comments: store.comments.map((comment) => ({ ...comment })) })),
  createComment: vi.fn(async (_companyId: string, id: string, input: CreateDeliverableCommentInput) => {
    const comment: DeliverableComment = {
      id: `c-${store.next++}`,
      companyId: "company-1",
      deliverableId: id,
      issueId: "issue-1",
      anchorKind: input.anchorKind ?? "text",
      quote: input.quote,
      prefix: input.prefix ?? null,
      suffix: input.suffix ?? null,
      textStart: input.textStart ?? null,
      locator: input.locator ? { ...input.locator, label: input.locator.label ?? null, box: input.locator.box ?? null } : null,
      body: input.body,
      status: "draft",
      authorUserId: "user-1",
      sentCommentId: null,
      sentAt: null,
      createdAt: "2026-10-06T10:00:00.000Z",
      updatedAt: "2026-10-06T10:00:00.000Z",
    };
    store.comments.push(comment);
    return comment;
  }),
  updateComment: vi.fn(async (_companyId: string, _id: string, commentId: string, body: string) => {
    const comment = store.comments.find((entry) => entry.id === commentId)!;
    comment.body = body;
    return comment;
  }),
  deleteComment: vi.fn(async (_companyId: string, _id: string, commentId: string) => {
    store.comments = store.comments.filter((entry) => entry.id !== commentId);
  }),
  sendComments: vi.fn(async () => {
    for (const comment of store.comments) {
      comment.status = "sent";
      comment.sentCommentId = "task-comment-1";
    }
    return { sent: store.comments, commentId: "task-comment-1", agentId: "agent-1", woken: true };
  }),
}));

vi.mock("@/api/deliverables", () => ({ deliverablesApi: deliverablesApiMock }));

function Harness() {
  const review = useDeliverableReview("company-1", "d-1");
  return (
    <div>
      <DeliverableReviewFrame review={review} title="Q3 board pack" />
      <DeliverableCommentsPanel review={review} />
    </div>
  );
}

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("DeliverableCommentsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    store.comments = [];
    store.next = 1;
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const frame = () => container.querySelector<HTMLIFrameElement>("[data-testid='deliverable-review-frame']")!;
  const items = () => [...container.querySelectorAll<HTMLElement>("[data-testid='deliverable-comment']")];
  const button = (label: string, scope: ParentNode = container) =>
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
      entry.textContent?.trim() === label || entry.getAttribute("aria-label") === label)!;

  async function fromFrame(data: Record<string, unknown>) {
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data: { gsamReview: 1, ...data }, source: frame().contentWindow }));
    });
    await flush();
  }

  async function type(element: HTMLTextAreaElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
    });
    await flush();
  }

  async function comment(quote: string, textStart: number, note: string) {
    await fromFrame({ type: "selection", quote, prefix: "", suffix: "", textStart });
    await type(container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Comment on the selected text']")!, note);
    await click(button("Add comment"));
  }

  function render() {
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Harness />
        </QueryClientProvider>,
      );
    });
  }

  const lastMessage = (postMessage: { mock: { calls: unknown[][] } }, type: string) =>
    postMessage.mock.calls.map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.type === type).at(-1);

  it("picks an image, a chart and an area, comments on each, and tells the frame where to draw boxes", async () => {
    render();
    await flush();
    const postMessage = vi.spyOn(frame().contentWindow!, "postMessage");
    await fromFrame({ type: "ready" });
    expect(lastMessage(postMessage, "pickMode")).toMatchObject({ on: false });

    const pick = container.querySelector<HTMLButtonElement>("[data-testid='deliverable-comments-pick']")!;
    expect(pick.getAttribute("aria-pressed")).toBe("false");
    await click(pick);
    expect(pick.getAttribute("aria-pressed")).toBe("true");
    expect(lastMessage(postMessage, "pickMode")).toMatchObject({ on: true });
    expect(container.textContent).toContain("drag a box over an area");

    const imageLocator = { path: "body > figure:nth-of-type(1) > img:nth-of-type(1)", tag: "img", label: "Image: Q3 revenue chart", box: null };
    await fromFrame({ type: "selection", kind: "element", quote: "Image: Q3 revenue chart", locator: imageLocator });
    // A pick ends pick mode, and the note form names what was picked.
    expect(lastMessage(postMessage, "pickMode")).toMatchObject({ on: false });
    expect(container.textContent).toContain("Image: Q3 revenue chart");
    await type(container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Comment on the picked element']")!, "Use the new colours.");
    await click(button("Add comment"));
    expect(deliverablesApiMock.createComment).toHaveBeenLastCalledWith("company-1", "d-1", {
      anchorKind: "element",
      quote: "Image: Q3 revenue chart",
      locator: imageLocator,
      body: "Use the new colours.",
    });

    // Alt+click works without pick mode.
    const chartLocator = { path: "body > svg:nth-of-type(1)", tag: "svg", label: "Graphic: Costs by region", box: null };
    await fromFrame({ type: "selection", kind: "element", quote: "Graphic: Costs by region", locator: chartLocator });
    await type(container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Comment on the picked element']")!, "Label the axis.");
    await click(button("Add comment"));

    const areaLocator = { path: "body > section:nth-of-type(2)", tag: "section", label: "Block: Slide 2", box: { x: 0.1, y: 0.5, width: 0.25, height: 0.2 } };
    await fromFrame({ type: "selection", kind: "region", quote: "Area on Block: Slide 2", locator: areaLocator });
    await type(container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Comment on the picked area']")!, "Too empty.");
    await click(button("Add comment"));
    expect(deliverablesApiMock.createComment).toHaveBeenLastCalledWith("company-1", "d-1", expect.objectContaining({
      anchorKind: "region",
      locator: areaLocator,
    }));

    expect(items().map((item) => item.textContent)).toEqual([
      expect.stringContaining("Image: Q3 revenue chart"),
      expect.stringContaining("Graphic: Costs by region"),
      expect.stringContaining("Area on Block: Slide 2"),
    ]);
    const marks = lastMessage(postMessage, "marks")!.marks;
    expect(marks).toEqual([
      expect.objectContaining({ id: "c-1", n: 1, kind: "element", locator: imageLocator }),
      expect.objectContaining({ id: "c-2", n: 2, kind: "element", locator: chartLocator }),
      expect.objectContaining({ id: "c-3", n: 3, kind: "region", locator: areaLocator }),
    ]);
    expect(JSON.stringify(marks)).not.toContain("Use the new colours.");

    // Clicking a comment scrolls the frame to its element.
    await click(button("Show comment 2 in the document"));
    expect(lastMessage(postMessage, "scrollTo")).toMatchObject({ id: "c-2" });
  });

  it("ignores a pick without a usable locator, and Esc in the frame stops pick mode", async () => {
    render();
    await flush();
    await fromFrame({ type: "ready" });
    await fromFrame({ type: "selection", kind: "element", quote: "Image: Logo", locator: { path: "", tag: "img" } });
    await fromFrame({ type: "selection", kind: "region", quote: "Area on Page", locator: { path: "body", tag: "body", label: "Page" } });
    expect(container.querySelector("textarea")).toBeNull();

    const pick = container.querySelector<HTMLButtonElement>("[data-testid='deliverable-comments-pick']")!;
    await click(pick);
    expect(pick.getAttribute("aria-pressed")).toBe("true");
    await fromFrame({ type: "pickCancel" });
    expect(container.querySelector("[data-testid='deliverable-comments-pick']")!.getAttribute("aria-pressed")).toBe("false");

    // Esc in the app also stops picking, and does not reach the dialog behind it.
    await click(pick);
    const behind = vi.fn();
    document.addEventListener("keydown", behind);
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    document.removeEventListener("keydown", behind);
    expect(behind).not.toHaveBeenCalled();
    expect(pick.getAttribute("aria-pressed")).toBe("false");
  });

  it("drafts two notes on different passages, edits one, deletes one, then sends", async () => {
    render();
    await flush();

    expect(frame().getAttribute("src")).toBe("/api/companies/company-1/deliverables/d-1/review-content");
    expect(container.textContent).toContain("Select text in the document to comment on it.");
    expect(container.querySelector("[data-testid='deliverable-comments-send']")).toBeNull();
    const postMessage = vi.spyOn(frame().contentWindow!, "postMessage");
    await fromFrame({ type: "ready" });

    // A message from anything other than the frame is ignored.
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data: { gsamReview: 1, type: "selection", quote: "Forged" } }));
    });
    expect(container.textContent).not.toContain("Forged");

    await comment("Revenue grew in Accra.", 14, "Give the figure.");
    await comment("Costs fell in Kumasi.", 37, "Why?");
    await comment("Q3 board pack", 0, "Drop me");
    expect(items()).toHaveLength(3);
    expect(container.querySelector("[data-testid='deliverable-comments-send']")).not.toBeNull();
    expect(deliverablesApiMock.createComment).toHaveBeenCalledWith("company-1", "d-1", {
      quote: "Revenue grew in Accra.",
      prefix: "",
      suffix: "",
      textStart: 14,
      body: "Give the figure.",
    });

    // The frame is told where to draw numbered markers: quotes only, never notes.
    const lastMarks = postMessage.mock.calls.map(([message]) => message as { type: string; marks?: unknown[] })
      .filter((message) => message.type === "marks").at(-1)!;
    expect(lastMarks.marks).toEqual([
      expect.objectContaining({ id: "c-1", n: 1, quote: "Revenue grew in Accra.", sent: false }),
      expect.objectContaining({ id: "c-2", n: 2, quote: "Costs fell in Kumasi." }),
      expect.objectContaining({ id: "c-3", n: 3, quote: "Q3 board pack" }),
    ]);
    expect(JSON.stringify(lastMarks)).not.toContain("Give the figure.");

    await click(button("Edit comment 2"));
    await type(container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Edit comment 2']")!, "Say by how much.");
    await click(button("Save"));
    expect(deliverablesApiMock.updateComment).toHaveBeenCalledWith("company-1", "d-1", "c-2", "Say by how much.");
    expect(items()[1]!.textContent).toContain("Say by how much.");

    await click(button("Delete comment 3"));
    expect(deliverablesApiMock.deleteComment).toHaveBeenCalledWith("company-1", "d-1", "c-3");
    expect(items()).toHaveLength(2);

    const send = container.querySelector<HTMLButtonElement>("[data-testid='deliverable-comments-send']")!;
    expect(send.textContent).toContain("Send 2 comments");
    await click(send);
    expect(deliverablesApiMock.sendComments).toHaveBeenCalledTimes(1);
    expect(items().map((item) => item.dataset.status)).toEqual(["sent", "sent"]);
    expect(button("Edit comment 1")).toBeUndefined();
    expect(button("Delete comment 2")).toBeUndefined();
    // With no drafts left there is nothing to send, so the action is replaced by a confirmation.
    expect(container.querySelector("[data-testid='deliverable-comments-send']")).toBeNull();
    expect(container.textContent).toContain("Sent. The task's agent will revise the deliverable.");
  });
});
