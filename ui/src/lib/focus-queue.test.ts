// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  answerFocusItem,
  focusProgress,
  focusSessionKey,
  initialFocusQueue,
  loadFocusSession,
  markFocusGone,
  reviewSkippedFocus,
  saveFocusSession,
  selectFocusItem,
  skipFocusItem,
  stepFocus,
  syncFocusQueue,
} from "./focus-queue";

const start = (ids: string[]) => syncFocusQueue(initialFocusQueue, ids);

describe("focus queue", () => {
  it("opens the first question and keeps feed order", () => {
    const state = start(["a", "b", "c"]);
    expect(state.order).toEqual(["a", "b", "c"]);
    expect(state.currentId).toBe("a");
    expect(focusProgress(state)).toEqual({ answered: 0, remaining: 3, total: 3 });
  });

  it("Submit & next marks the answer and opens the next question", () => {
    let state = start(["a", "b", "c"]);
    state = answerFocusItem(state, "a");
    expect(state.currentId).toBe("b");
    expect(focusProgress(state)).toEqual({ answered: 1, remaining: 2, total: 3 });
  });

  it("keeps an answered question answered when a stale feed still lists it", () => {
    let state = start(["a", "b"]);
    state = answerFocusItem(state, "a");
    state = syncFocusQueue(state, ["a", "b"]);
    expect(state.answered).toEqual(["a"]);
    expect(state.currentId).toBe("b");
  });

  it("skip moves on, keeps the question open, and passes it over", () => {
    let state = start(["a", "b", "c"]);
    state = skipFocusItem(state);
    expect(state.currentId).toBe("b");
    state = answerFocusItem(state, "b");
    expect(state.currentId).toBe("c");
    state = answerFocusItem(state, "c");
    // Only the skipped one is left: caught up, with one to review.
    expect(state.currentId).toBeNull();
    expect(focusProgress(state).remaining).toBe(1);
    state = reviewSkippedFocus(state);
    expect(state.currentId).toBe("a");
  });

  it("drops a question answered elsewhere and moves on without answering it", () => {
    let state = start(["a", "b", "c"]);
    state = syncFocusQueue(state, ["b", "c"]);
    expect(state.gone).toEqual(["a"]);
    expect(state.answered).toEqual([]);
    expect(state.currentId).toBe("b");
    expect(focusProgress(state)).toEqual({ answered: 0, remaining: 2, total: 2 });
  });

  it("drops a question seen closed on fetch, even while the feed still lists it", () => {
    let state = start(["a", "b"]);
    state = markFocusGone(state, "a");
    expect(state.currentId).toBe("b");
    state = syncFocusQueue(state, ["a", "b"]);
    expect(state.gone).toEqual(["a"]);
    expect(state.currentId).toBe("b");
    // A gone question cannot be selected or answered into the tally.
    expect(selectFocusItem(state, "a").currentId).toBe("b");
  });

  it("appends new arrivals to the end of the queue", () => {
    let state = start(["a"]);
    state = answerFocusItem(state, "a");
    expect(state.currentId).toBeNull();
    state = syncFocusQueue(state, ["z"]);
    expect(state.order).toEqual(["a", "z"]);
    expect(state.currentId).toBe("z");
  });

  it("J / K step through pending questions, wrapping", () => {
    let state = start(["a", "b", "c"]);
    state = answerFocusItem(state, "a");
    expect(stepFocus(state, 1).currentId).toBe("c");
    expect(stepFocus(stepFocus(state, 1), 1).currentId).toBe("b");
    expect(stepFocus(state, -1).currentId).toBe("c");
  });
});

describe("focus session", () => {
  it("saves and restores the queue and seen rows per company", () => {
    sessionStorage.clear();
    const queue = answerFocusItem(start(["a", "b"]), "a");
    saveFocusSession("co-1", { queue, items: [{ id: "a" }, { id: "b" }] });
    expect(loadFocusSession("co-1")).toEqual({ queue, items: [{ id: "a" }, { id: "b" }] });
    expect(loadFocusSession("co-2")).toBeNull();
    expect(focusProgress(syncFocusQueue(loadFocusSession("co-1")!.queue, ["b"]))).toEqual({
      answered: 1,
      remaining: 1,
      total: 2,
    });
  });

  it("ignores broken saved data", () => {
    sessionStorage.setItem(focusSessionKey("co-1"), "{not json");
    expect(loadFocusSession("co-1")).toBeNull();
    sessionStorage.setItem(focusSessionKey("co-1"), JSON.stringify({ queue: { order: "a" }, items: [] }));
    expect(loadFocusSession("co-1")).toBeNull();
  });
});
