import type { TourDefinition } from "./feature-tours";

/**
 * Tours of the pages in the sidebar that had none: Links, Conference Room, Status, Skills,
 * Connectors, Workflows, Artifacts, Cases, Deep Dive, GSAM releases and Settings. Each lives in
 * the page bar for its route (CORE_TOURS), never opens by itself, and is listed on Tutorials.
 */

export const LINKS_TOUR: TourDefinition = {
  id: "links",
  title: "Links",
  description: "Every link we share, by client, and how to find or add one.",
  version: 1,
  route: { match: /^\/links\/?$/, path: "/links" },
  autoStart: false,
  label: "Links",
  steps: [
    {
      target: "Search links",
      title: "Find a link",
      body: "Search titles, addresses, clients, tasks and notes. The list narrows as you type.",
    },
    {
      target: "link-filters",
      title: "Narrow the list",
      body: "Filter by client, project, type and status. Status says whether a link is live, a draft, archived or broken.",
    },
    {
      target: "link-group",
      title: "By client",
      body: "Links sit under their client. The button above the list switches to one list with no grouping.",
    },
    {
      target: "links-add",
      title: "Add one",
      body: "Agents add sites, previews and deliverable links as they make them. Add link is for anything else.",
    },
  ],
};

export const CONFERENCE_ROOM_TOUR: TourDefinition = {
  id: "conference-room",
  title: "Conference Room",
  description: "A chat with your team lead about the whole organisation, beside a feed of what the agents are doing.",
  version: 1,
  route: { match: /^\/board-chat\/?$/, path: "/board-chat" },
  autoStart: false,
  label: "the Conference Room",
  steps: [
    {
      target: "conference-room-header",
      title: "Your team lead",
      body: "Messages here go to your team lead agent, who answers for the whole organisation rather than one task.",
    },
    {
      target: "conference-room-messages",
      title: "The conversation",
      body: "Your messages and the replies, newest at the bottom. In a new organisation, the suggestions here draft a first brief or plan.",
    },
    {
      target: "conference-room-composer",
      title: "Ask",
      body: "Type a question and press Enter to send it. Shift and Enter starts a new line. You can attach files or make an image too.",
    },
    {
      target: ["conference-room-feed", "Open agent feed"],
      title: "Agent feed",
      body: "What the agents are doing right now. On a phone it opens from the button at the top of the chat.",
    },
  ],
};

export const STATUS_TOUR: TourDefinition = {
  id: "status",
  title: "Status",
  description: "Cards that keep a short, up to date summary of the tasks you care about.",
  version: 1,
  flag: "enableStatusCards",
  route: { match: /^\/status\/?$/, path: "/status" },
  autoStart: false,
  label: "Status",
  steps: [
    {
      target: "status-new",
      title: "Make a card",
      body: "Say in your own words what to keep an eye on. The card finds the matching tasks and writes a summary.",
    },
    {
      target: "status-card-tile",
      title: "One card",
      body: "Its summary, how fresh it is and what it cost. Select the card to open the detail.",
    },
    {
      target: "Card actions",
      title: "Card actions",
      body: "Refresh it now, change what it watches and how often it checks, or archive it.",
    },
    {
      target: "status-archived",
      title: "Archived cards",
      body: "Archived cards wait here. Open one to read it, or restore it.",
    },
  ],
};

export const SKILLS_TOUR: TourDefinition = {
  id: "skills",
  title: "Skills",
  description: "The skills your agents can use, how to find one, and how to add another.",
  version: 1,
  route: { match: /^\/skills\/?$/, path: "/skills" },
  autoStart: false,
  label: "Skills",
  steps: [
    {
      target: "skills-folders",
      title: "Folders",
      body: "Skills sit in folders. Pick a folder to see only its skills. A skill's menu moves it to another folder.",
    },
    {
      target: "skills-search",
      title: "Find a skill",
      body: "Search by name. Sort and Source, beside it, change the order and narrow the list by where a skill came from.",
    },
    {
      target: "Scan project workspaces for skills",
      title: "Scan the projects",
      body: "Looks through the project workspaces for skills that are not on this list yet.",
    },
    {
      target: "skills-new",
      title: "Add a skill",
      body: "Write a new one, find one in the catalogue, or import one from a path or a web address.",
    },
  ],
};

export const CONNECTORS_TOUR: TourDefinition = {
  id: "connectors",
  title: "Connectors",
  description: "The tools and accounts GSAM is connected to, and how to add another.",
  version: 1,
  route: { match: /^\/apps\/?$/, path: "/apps" },
  autoStart: false,
  label: "Connectors",
  steps: [
    {
      target: "Search connectors",
      title: "Find a connector",
      body: "Type a tool's name. Searching also opens the list of connectors you can add.",
    },
    {
      target: "connectors-mailboxes",
      title: "Mailboxes",
      body: "Link email inboxes so agents can search and read them. Manage shows any that need reconnecting.",
    },
    {
      target: "connectors-agent-access",
      title: "Agent access",
      body: "Check access shows what every agent can reach, and what is missing or about to expire.",
    },
    {
      target: "connectors-accounts",
      title: "Your accounts",
      body: "Working accounts are under Connected. A set-up someone started and did not finish is under Not finished, ready to pick up again.",
    },
    {
      target: ["connectors-add", "Available connectors"],
      title: "Add a connector",
      body: "Opens the list of tools you can connect. Pick one and follow its steps.",
    },
  ],
};

export const WORKFLOWS_TOUR: TourDefinition = {
  id: "workflows",
  title: "Workflows",
  description: "Templates that start a whole set of tasks in one click.",
  version: 1,
  route: { match: /^\/workflows\/?$/, path: "/workflows" },
  autoStart: false,
  label: "Workflows",
  steps: [
    {
      title: "What a template does",
      body: "One click creates the lead task, a task for each step, the human checks and the empty documents the steps fill in.",
    },
    {
      target: "workflows-template",
      title: "A template",
      body: "Its name, what it is for, and how many steps and checks it has.",
    },
    {
      target: "workflows-steps",
      title: "Who does each step",
      body: "Pick an agent for the lead task and for each step. Save assignees keeps your choice for next time.",
    },
    {
      target: "workflows-start",
      title: "Start",
      body: "Asks for a title, then creates the tasks. Save or discard any changes first.",
    },
  ],
};

export const ARTIFACTS_TOUR: TourDefinition = {
  id: "artifacts",
  title: "Artifacts",
  description: "Every file your agents attach to tasks, and how to find one.",
  version: 1,
  route: { match: /^\/artifacts\/?$/, path: "/artifacts" },
  autoStart: false,
  label: "Artifacts",
  steps: [
    {
      target: "Search artifacts",
      title: "Find one",
      body: "Type part of a name to narrow the list.",
    },
    {
      target: "Filter artifacts by type",
      title: "One type at a time",
      body: "Images, videos, documents, text or other files.",
    },
    {
      target: "artifact-group-control",
      title: "Stack them",
      body: "Group the files by task or by parent task, so everything made for one task sits together.",
    },
    {
      target: "artifacts-grid",
      title: "The files",
      body: "Select one to open it. Mark as deliverable adds a file to Deliverables, with the rest of the work made for clients.",
    },
  ],
};

export const CASES_TOUR: TourDefinition = {
  id: "cases",
  title: "Cases",
  description: "The lasting pieces of work that tasks create and keep improving, such as posts and pages.",
  version: 1,
  flag: "enableCases",
  route: { match: /^\/cases\/?$/, path: "/cases" },
  autoStart: false,
  label: "Cases",
  steps: [
    {
      title: "What a case is",
      body: "A case is a piece of work that outlives one task, such as a blog post or a docs page. Agents create cases; you follow and steer them here.",
    },
    {
      target: "Search cases",
      title: "Find one",
      body: "Type part of a case's name to narrow the list.",
    },
    {
      target: "cases-toolbar",
      title: "Change the view",
      body: "Show parents and children as a tree, pick the columns, filter by type, status, project or label, and group or sort the list.",
    },
    {
      target: "cases-list",
      title: "The list",
      body: "One row for each case. Select a row to open it.",
    },
    {
      target: "Change case status",
      title: "Its status",
      body: "Change a case's status straight from its row.",
    },
  ],
};

export const DEEP_DIVE_TOUR: TourDefinition = {
  id: "deep-dive",
  title: "Deep Dive",
  description: "One Deep Dive for each client engagement, each with its own portal.",
  version: 2,
  // The page also needs Cases on; Tutorials checks both.
  flag: "enableDeepDive",
  route: { match: /^\/deep-dive\/?$/, path: "/deep-dive" },
  autoStart: false,
  label: "the Deep Dive",
  steps: [
    {
      target: "deep-dive-start",
      title: "Start a Deep Dive",
      body: "Pick the client. A client can have more than one Deep Dive over time.",
    },
    {
      target: "deep-dive-tiles",
      title: "One tile for each client",
      body: "A tile shows what waits for a person: interview drafts to review and findings to validate.",
    },
    {
      target: "deep-dive-tiles",
      title: "Inside a tile",
      body: "The client's portal: questions and answers, registers, sessions, findings, documents and deliverables, each a tab.",
    },
  ],
};

export const GSAM_RELEASES_TOUR: TourDefinition = {
  id: "gsam-releases",
  title: "GSAM releases",
  description: "The version of GSAM running now, what is waiting to go out, and every release so far. For owners and admins.",
  version: 1,
  route: { match: /^\/releases\/?$/, path: "/releases" },
  autoStart: false,
  label: "GSAM releases",
  steps: [
    {
      target: "release-live",
      title: "Live now",
      body: "The version of GSAM everyone is using.",
    },
    {
      target: "release-next",
      title: "Next release",
      body: "What is merged into main and not live yet, with its proposed title. Release now adds it to the queue.",
    },
    {
      target: "release-queue",
      title: "The queue",
      body: "Each release waits for its tests to pass, then goes out. This shows the one running now, step by step, and any waiting behind it.",
    },
    {
      target: "release-history",
      title: "History",
      body: "Every version that went live, newest first.",
    },
  ],
};

export const SETTINGS_TOUR: TourDefinition = {
  id: "settings",
  title: "Settings",
  description: "Your organisation's name, logo and rules, and where the other settings pages are.",
  version: 1,
  route: { match: /^\/company\/settings\/?$/, path: "/company/settings" },
  autoStart: false,
  label: "Settings",
  steps: [
    {
      target: "Settings pages",
      title: "Every settings page",
      body: "General is this page. Members, Integrations, Secrets and the rest each have their own. Some are only for owners.",
    },
    {
      target: "Settings section",
      title: "Sections of this page",
      body: "Organisation, Agents and work, Security, and Backups and data.",
    },
    {
      target: "settings-name",
      title: "Name and logo",
      body: "The name, description and logo people see. Save changes appears once you edit one.",
    },
    {
      target: "company-settings-team-section",
      title: "Hiring",
      body: "Turn this on and every new agent waits for a person's approval before it starts.",
    },
    {
      target: "company-settings-hourly-rate-section",
      title: "Agent hours",
      body: "The dashboard values agent hours at this rate. Leave it empty to show hours only.",
    },
  ],
};

export const AREA_TOURS = [
  LINKS_TOUR,
  CONFERENCE_ROOM_TOUR,
  STATUS_TOUR,
  SKILLS_TOUR,
  CONNECTORS_TOUR,
  WORKFLOWS_TOUR,
  ARTIFACTS_TOUR,
  CASES_TOUR,
  DEEP_DIVE_TOUR,
  GSAM_RELEASES_TOUR,
  SETTINGS_TOUR,
];
