import type { TourDefinition } from "./feature-tours";

/**
 * Search and Ask Everest. Not tied to one page: it runs from the page bar
 * on any screen, and Tutorials opens it on Home.
 */
export const SEARCH_ASK_TOUR: TourDefinition = {
  id: "search-ask",
  title: "Search and Ask Everest",
  description: "Find anything, type a command, and ask Everest what happened while you were away.",
  version: 1,
  autoStart: false,
  // Never matches a page, so it does not replace a page's own tour; Tutorials opens it on Home.
  route: { match: /(?!)/, path: "/dashboard" },
  label: "search and Ask Everest",
  steps: [
    {
      target: "global-search",
      title: "Search everything",
      body: "Press Cmd or Ctrl and K, or select Search. Type a client, a task or a word from a document, and open it from the list.",
    },
    {
      title: "Type what you want done",
      body: "Write it as a sentence, such as \"create a task for Mason to draft the Indago pack by Friday\" or \"remind me on Monday to call Ben\". You see a preview, and nothing happens until you confirm.",
    },
    {
      title: "Save and pin",
      body: "Save a search you use often, or pin the page you are on. Both are waiting at the top when you open search again.",
    },
    {
      target: "global-ask",
      title: "Ask Everest",
      body: "Press Cmd or Ctrl and J, or select Ask. Ask in plain words, such as \"What is stuck?\". Start with \"What happened since I was last here?\" to catch up.",
    },
    {
      title: "Every shortcut",
      body: "Press ? on any page to see every keyboard shortcut.",
    },
  ],
};
