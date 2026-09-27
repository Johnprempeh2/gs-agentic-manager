/**
 * Focus mode queue for the Decisions page (GRE-55).
 *
 * Pure state so the rules are testable without React: the queue remembers every
 * question it has shown this session (so answered tabs stay visible, crossed
 * out) and re-syncs against the live attention feed on every refetch. A
 * question that leaves the feed without being answered here was answered
 * elsewhere (or expired) — it drops out as "gone" and is never submitted twice.
 */
export interface FocusQueueState {
  /** Every id seen this session, in queue order. New arrivals append. */
  order: string[];
  /** Answered here, this session. Never shown as pending again. */
  answered: string[];
  /** Left the feed without an answer here: answered elsewhere, expired, withdrawn. */
  gone: string[];
  /** Skipped for now. Still open; revisited only after the rest. */
  skipped: string[];
  currentId: string | null;
}

export const initialFocusQueue: FocusQueueState = {
  order: [],
  answered: [],
  gone: [],
  skipped: [],
  currentId: null,
};

export function isFocusPending(state: FocusQueueState, id: string): boolean {
  return !state.answered.includes(id) && !state.gone.includes(id);
}

export function focusPendingIds(state: FocusQueueState): string[] {
  return state.order.filter((id) => isFocusPending(state, id));
}

/**
 * The next question to open after `fromId`, in queue order, wrapping. Skipped
 * questions are passed over; `null` means nothing unskipped is left.
 */
export function findNextFocusId(state: FocusQueueState, fromId: string | null): string | null {
  const { order } = state;
  if (order.length === 0) return null;
  const start = fromId ? order.indexOf(fromId) : -1;
  for (let step = 1; step <= order.length; step += 1) {
    const id = order[(start + step + order.length) % order.length]!;
    if (id === fromId) continue;
    if (isFocusPending(state, id) && !state.skipped.includes(id)) return id;
  }
  return null;
}

/** Re-sync with the ids currently open in the feed (in feed order). */
export function syncFocusQueue(state: FocusQueueState, openIds: readonly string[]): FocusQueueState {
  const open = new Set(openIds);
  const known = new Set(state.order);
  const order = [...state.order, ...openIds.filter((id) => !known.has(id))];
  // Anything we know that the feed no longer lists, and that we did not answer
  // ourselves, was resolved somewhere else. Gone is sticky: a stale feed that
  // still lists a question we saw closed must not bring it back.
  const gone = order.filter(
    (id) => state.gone.includes(id) || (!open.has(id) && !state.answered.includes(id)),
  );
  const skipped = state.skipped.filter((id) => open.has(id));
  const next: FocusQueueState = { order, answered: state.answered, gone, skipped, currentId: state.currentId };
  if (next.currentId && isFocusPending(next, next.currentId)) return next;
  return { ...next, currentId: findNextFocusId(next, next.currentId) };
}

/** A question on screen turned out to be closed already (seen on fetch). */
export function markFocusGone(state: FocusQueueState, id: string): FocusQueueState {
  if (state.gone.includes(id) || state.answered.includes(id)) return state;
  const next = { ...state, gone: [...state.gone, id], skipped: state.skipped.filter((entry) => entry !== id) };
  return next.currentId === id ? { ...next, currentId: findNextFocusId(next, id) } : next;
}

export function answerFocusItem(state: FocusQueueState, id: string): FocusQueueState {
  if (state.answered.includes(id)) return state;
  const next = {
    ...state,
    answered: [...state.answered, id],
    gone: state.gone.filter((entry) => entry !== id),
    skipped: state.skipped.filter((entry) => entry !== id),
  };
  return next.currentId === id ? { ...next, currentId: findNextFocusId(next, id) } : next;
}

export function skipFocusItem(state: FocusQueueState): FocusQueueState {
  const id = state.currentId;
  if (!id) return state;
  const next = { ...state, skipped: state.skipped.includes(id) ? state.skipped : [...state.skipped, id] };
  return { ...next, currentId: findNextFocusId(next, id) };
}

export function selectFocusItem(state: FocusQueueState, id: string): FocusQueueState {
  if (!isFocusPending(state, id)) return state;
  return { ...state, currentId: id };
}

/** J / K: step through every pending question, skipped ones included. */
export function stepFocus(state: FocusQueueState, direction: 1 | -1): FocusQueueState {
  const pending = focusPendingIds(state);
  if (pending.length === 0) return state;
  const index = state.currentId ? pending.indexOf(state.currentId) : -1;
  const nextIndex = index < 0
    ? direction === 1 ? 0 : pending.length - 1
    : (index + direction + pending.length) % pending.length;
  return { ...state, currentId: pending[nextIndex]! };
}

/** Put skipped questions back in line and open the first. */
export function reviewSkippedFocus(state: FocusQueueState): FocusQueueState {
  const next = { ...state, skipped: [] };
  return { ...next, currentId: findNextFocusId(next, null) };
}

export function focusProgress(state: FocusQueueState) {
  const answered = state.answered.length;
  const remaining = focusPendingIds(state).length;
  return { answered, remaining, total: answered + remaining };
}

/**
 * The Focus session survives leaving the page (Open task, then Back) for the
 * rest of the browser session, so the progress count does not reset (GRE-59).
 * `items` are the rows the session has shown, keyed by id, so answered tabs
 * still render after the feed drops them.
 */
export interface FocusSession<Item> {
  queue: FocusQueueState;
  items: Item[];
}

export function focusSessionKey(companyId: string) {
  return `paperclip:attention:focus-session:${companyId}`;
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function loadFocusSession<Item extends { id: string }>(companyId: string): FocusSession<Item> | null {
  try {
    const raw = sessionStorage.getItem(focusSessionKey(companyId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { queue?: Partial<FocusQueueState>; items?: unknown };
    const queue = parsed.queue;
    if (
      !queue ||
      !isIdList(queue.order) ||
      !isIdList(queue.answered) ||
      !isIdList(queue.gone) ||
      !isIdList(queue.skipped) ||
      !(queue.currentId === null || typeof queue.currentId === "string") ||
      !Array.isArray(parsed.items)
    ) {
      return null;
    }
    const items = parsed.items.filter(
      (item): item is Item => !!item && typeof (item as { id?: unknown }).id === "string",
    );
    return {
      queue: {
        order: queue.order,
        answered: queue.answered,
        gone: queue.gone,
        skipped: queue.skipped,
        currentId: queue.currentId,
      },
      items,
    };
  } catch {
    return null;
  }
}

export function saveFocusSession<Item>(companyId: string, session: FocusSession<Item>) {
  try {
    sessionStorage.setItem(focusSessionKey(companyId), JSON.stringify(session));
  } catch {
    // Ignore sessionStorage failures: progress then lasts only while the page is open.
  }
}
