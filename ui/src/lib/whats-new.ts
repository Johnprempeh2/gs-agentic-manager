import { useSyncExternalStore } from "react";

/** One change, said in a sentence a new person understands, with the page to try it on. */
export type WhatsNewEntry = {
  text: string;
  /** Board path without the organisation prefix, for example "/needed". */
  to?: string;
  linkLabel?: string;
};

export type WhatsNewArea = {
  area: string;
  entries: WhatsNewEntry[];
};

export type WhatsNewRelease = {
  /** Stable id; a change here shows the New badge again. */
  id: string;
  title: string;
  date: string;
  summary: string;
  areas: WhatsNewArea[];
};

/** Newest first. Add a release at the top when a batch of changes lands. */
export const WHATS_NEW: WhatsNewRelease[] = [
  {
    id: "2026-10-16",
    title: "Overnight improvements",
    date: "2026-10-16",
    summary: "A night of changes to make GSAM easier to use, especially if you are new to it.",
    areas: [
      {
        area: "What needs you",
        entries: [
          { text: "Needed from you puts everything waiting on you on one page, grouped by what you need to do.", to: "/needed", linkLabel: "Open Needed from you" },
          { text: "You can answer a decision straight from Needed from you, without opening another page.", to: "/needed" },
          { text: "Needed from you also shows what the team got on with while you were away.", to: "/needed" },
          { text: "Swipe a row to the right on a phone to put it away until tomorrow, with Undo.", to: "/needed" },
          { text: "Decisions opens with one sentence on what a decision is.", to: "/decisions", linkLabel: "Open Decisions" },
          { text: "When an agent asks for a file, attach it to your answer by picking, dropping or pasting it.", to: "/decisions" },
          { text: "Approvals says in plain words what a sign-off is.", to: "/approvals", linkLabel: "Open Approvals" },
          { text: "The Blocked tab in the Inbox shows what holds each piece of work up, who must act and how long it has waited.", to: "/inbox/blocked", linkLabel: "Open Blocked" },
        ],
      },
      {
        area: "Search and Ask Everest",
        entries: [
          { text: "Search everything, or ask Everest a question, from any screen with Ctrl or Cmd and K or J.", to: "/search", linkLabel: "Open Search" },
          { text: "Search now looks inside comments and documents, and shows recent items before you type.", to: "/search" },
          { text: "Type a plain command in the search box and see a preview before anything happens.", to: "/search" },
          { text: "Ask Everest takes files and voice, sent along with your question." },
          { text: "Save a search or pin a page to come back to it, and see what changed since you were away.", to: "/search" },
          { text: "Press ? on any screen to see every keyboard shortcut." },
        ],
      },
      {
        area: "Clients",
        entries: [
          { text: "Each client page shows where things stand, the NDA and the engagement pack.", to: "/organisations", linkLabel: "Open Organisations" },
          { text: "Upload files straight onto a client and file them under a stage, by picking, dropping or pasting.", to: "/organisations" },
          { text: "Each stage lists the documents to collect, and the signed NDA goes in in one step.", to: "/organisations" },
          { text: "Pick each client's country owner from your team.", to: "/organisations" },
          { text: "Bring clients in from Pipedrive, HubSpot or a Notion export without an API key.", to: "/organisations" },
        ],
      },
      {
        area: "Reports and the team",
        entries: [
          { text: "This week at Greatstone sums up the week on one page, with a PDF to download.", to: "/weekly-report", linkLabel: "Open This week" },
          { text: "Turn on a weekly report every Monday morning in Notifications.", to: "/notifications" },
          { text: "The morning summary sends one daily message on what needs you, what finished and what is stuck.", to: "/morning", linkLabel: "Open the morning summary" },
          { text: "The Scorecard shows each agent's week in plain words, and copies as a written update or a spreadsheet.", to: "/scorecard", linkLabel: "Open Scorecard" },
          { text: "See what each agent can reach and what needs your attention.", to: "/agents", linkLabel: "Open Agents" },
        ],
      },
      {
        area: "Tasks and the calendar",
        entries: [
          { text: "The Calendar shows task due dates, routine runs and goal dates on one page.", to: "/calendar", linkLabel: "Open Calendar" },
          { text: "Add the calendar to Google Calendar or Outlook with a private feed, or download the month.", to: "/calendar" },
          { text: "Quick starts fill in a clear brief when you create a new task.", to: "/issues", linkLabel: "Open Tasks" },
          { text: "Filter task lists by due date and download them as a spreadsheet.", to: "/issues" },
          { text: "Do this again starts a new task from an earlier one.", to: "/issues" },
          { text: "Mark a task as waiting on someone outside until a date, and it wakes up when the date passes.", to: "/issues" },
          { text: "A routine can keep one standing task instead of making a new task each time it runs.", to: "/routines", linkLabel: "Open Routines" },
        ],
      },
      {
        area: "Memory",
        entries: [
          { text: "Bring what Claude and ChatGPT know about your work into the organisation's memory.", to: "/memory", linkLabel: "Open Memory" },
          { text: "Claude, Claude Code and Codex can read and add to memory, and you see when they first do.", to: "/memory/apps" },
          { text: "Memory remembers each client, and search results read as a plain list.", to: "/memory/clients" },
          { text: "Confirm or reject several memory suggestions at once, with look-alikes flagged.", to: "/memory/review" },
        ],
      },
      {
        area: "Images",
        entries: [
          { text: "Describe a picture and the Images page makes it for you. It needs an image service set up first.", to: "/images", linkLabel: "Open Images" },
        ],
      },
      {
        area: "Connections",
        entries: [
          { text: "Settings has an Integrations page with a plain status on each connection.", to: "/company/settings/integrations", linkLabel: "Open Integrations" },
          { text: "Send updates to Slack, Teams, Zapier or Make, and let outside tools create tasks.", to: "/company/settings/integrations" },
          { text: "Agents can save email drafts for you to check, when you turn it on for a mailbox." },
        ],
      },
      {
        area: "On your phone",
        entries: [
          { text: "Add GSAM to your phone's Home Screen; on an iPhone a one-screen guide shows you how." },
          { text: "Pages open faster on a phone, and buttons and switches are easier to tap." },
          { text: "Notification settings read in plain words, with phone alerts for tasks given to you.", to: "/notifications", linkLabel: "Open Notifications" },
          { text: "Swipe an Inbox task to the right to put it away until tomorrow morning.", to: "/inbox/mine" },
        ],
      },
      {
        area: "Help and getting started",
        entries: [
          { text: "Tutorials has a Start here path of four short tours.", to: "/tutorials", linkLabel: "Open Tutorials" },
          { text: "Show me around is on every everyday page, and on task and agent pages." },
          { text: "New short tours for This week, Images, Integrations and the Calendar, and updated ones for client pages and phones.", to: "/tutorials", linkLabel: "See the tours" },
          { text: "Show me around now also covers Blocked work, the Scorecard, the morning summary, Organisations with the Pipedrive import, Search, Deliverables, the catch-up page and more of the client page.", to: "/tutorials", linkLabel: "See the tours" },
          { text: "Words with a dotted underline explain themselves when you tap them, and Tutorials lists them all.", to: "/tutorials#words" },
          { text: "Decisions, Projects, Costs and Approvals open with a plain sentence on what the page is for.", to: "/projects" },
          { text: "Light mode is easier on the eyes, with a proper daytime theme." },
        ],
      },
      {
        area: "Behind the scenes",
        entries: [
          { text: "Agents check they have the tools they need before they start, and stop early with a plain reason if not." },
          { text: "Agents skip a scheduled run when nothing has changed, which saves money." },
          { text: "An agent wakes up when the pull request on its task is merged." },
        ],
      },
    ],
  },
];

export const LATEST_WHATS_NEW_ID = WHATS_NEW[0]?.id ?? "";

const SEEN_KEY = "gsam.whatsNew.seen";
const CHANGE_EVENT = "gsam:whats-new-seen";

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

/** Remember that this person has opened What's new, so the badge goes away. */
export function markWhatsNewSeen(id = LATEST_WHATS_NEW_ID) {
  try {
    window.localStorage.setItem(SEEN_KEY, id);
  } catch {
    // Private windows can refuse storage; the badge simply stays.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** True until the person opens the latest What's new. */
export function useWhatsNewUnseen() {
  const seen = useSyncExternalStore(subscribe, readSeen, () => LATEST_WHATS_NEW_ID);
  return Boolean(LATEST_WHATS_NEW_ID) && seen !== LATEST_WHATS_NEW_ID;
}
