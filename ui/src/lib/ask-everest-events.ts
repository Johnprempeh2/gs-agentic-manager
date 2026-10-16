import type { AskContext } from "./ask-everest";

/** Window event that opens the Ask Everest panel from anywhere, optionally with a question or a page's context. */
export const OPEN_ASK_EVEREST_EVENT = "gsam:open-ask-everest";

export interface OpenAskEverestDetail {
  question?: string;
  /** What the page is about: the panel shows it on a chip and sends it with the question. */
  context?: AskContext;
}

export function openAskEverest(question?: string, context?: AskContext) {
  const detail: OpenAskEverestDetail = { question: question ?? "", ...(context ? { context } : {}) };
  window.dispatchEvent(new CustomEvent(OPEN_ASK_EVEREST_EVENT, { detail }));
}
