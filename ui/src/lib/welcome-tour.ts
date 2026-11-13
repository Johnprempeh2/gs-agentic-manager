import type { TourDefinition } from "./feature-tours";

/**
 * The first tour a person sees: what GSAM is and where things are. It opens
 * once, on Home, and Tutorials replays it there. Every stop is a control in
 * the sidebar, so it is the same on every page a person might start from.
 */
export const WELCOME_TOUR: TourDefinition = {
  id: "welcome",
  title: "Welcome to GSAM",
  description: "What GSAM is, and where to find tasks, agents, decisions, the website and these tours.",
  version: 1,
  // Not in CORE_TOURS, so Home keeps its own tour in the page bar; this one runs beside it.
  route: { match: /^\/dashboard\/?$/, path: "/dashboard" },
  label: "GSAM",
  steps: [
    {
      title: "Welcome to GSAM",
      body: "GSAM is where your team and its AI agents work together. You give the agents work, they do it and report back, and they stop and ask when they need you. Here is where things are.",
    },
    {
      target: "global-ask",
      title: "Talk to an agent",
      body: "The lead agent is always at the bottom right. Select the stone to open a chat, then ask a question or say what you need, as you would to a colleague.",
    },
    {
      target: "new-task",
      title: "Give work as a task",
      body: "Select New Task and describe what you want in plain words. An agent picks it up and reports back in the task.",
    },
    {
      target: "nav-tasks",
      title: "Where tasks live",
      body: "Tasks lists every piece of work and who owns it. Open a task to read what the agent did and to reply.",
    },
    {
      target: "nav-decisions",
      title: "Where approvals wait",
      body: "When an agent needs your answer or your sign-off, it waits in Decisions. The number shows how many are waiting. Start each day here.",
    },
    {
      // Website sits in Work: point at the fold when the row is not showing.
      target: ["nav-website", "Expand Work"],
      title: "The website",
      body: "Website is in the Work section of the sidebar. Open Work if it is folded. It holds the sitemap, the pages and the page editor.",
    },
    {
      target: "nav-commerce",
      title: "Commerce",
      body: "Commerce holds what the website sells: the catalogue of products, and the quotes, orders and invoices that come from it.",
    },
    {
      target: "account-menu",
      title: "Your account menu",
      body: "Your name, bottom left, opens your account menu: switch company, your profile, the theme, customise the menu, settings, and Tutorials, which lists every tour so you can replay any of them.",
    },
  ],
};
