/** Window event that opens the Ask Everest panel from anywhere, optionally with a question. */
export const OPEN_ASK_EVEREST_EVENT = "gsam:open-ask-everest";

export function openAskEverest(question?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_ASK_EVEREST_EVENT, { detail: { question: question ?? "" } }));
}
