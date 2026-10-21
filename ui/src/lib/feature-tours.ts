import type { InstanceExperimentalSettings } from "@greatstone/shared";
import { SEARCH_ASK_TOUR } from "./search-ask-tour";
import { IMAGES_TOUR } from "./images-tour";

/**
 * One stop on a tour: the element with `data-tour="<target>"`, a title and a
 * sentence or two. A step with no target is a plain card near the top of the
 * screen, for explaining the page as a whole.
 */
export interface TourStep {
  target?: string;
  title: string;
  body: string;
}

export interface TourDefinition {
  id: string;
  /** Bump to show the tour again to everyone who has seen it. */
  version: number;
  /** The feature switch the tour belongs to; no tour while it is off. None = always on. */
  flag?: keyof InstanceExperimentalSettings;
  /**
   * Pages every organisation has: the tour lives in the page bar for the
   * matching route (company prefix removed), and Tutorials opens `path`.
   */
  route?: { match: RegExp; path: string };
  /** Open by itself on the first visit. Off for everyday pages: the button shows a dot instead. */
  autoStart?: boolean;
  label: string;
  /** Name and one line for the Tutorials list. */
  title: string;
  description: string;
  steps: TourStep[];
}

export const PIPELINES_LIST_TOUR: TourDefinition = {
  id: "pipelines-list",
  title: "Pipelines",
  description: "What a pipeline is, its stages and counts, and how to pin one.",
  version: 1,
  flag: "enablePipelines",
  label: "Pipelines",
  steps: [
    {
      target: "pipelines-title",
      title: "What a pipeline is",
      body: "A pipeline is a line of stages that work moves through. Your client list works this way: each client has one case, and the case moves on as the relationship grows.",
    },
    {
      target: "pipelines-stages",
      title: "Stages and counts",
      body: "The bar shows every stage in order. A filled segment means something is waiting there, and the chips count the open items in each stage.",
    },
    {
      target: "pipelines-attention",
      title: "Needs attention",
      body: "Items waiting on you, such as an approval or a question, are counted here. Select the count to open them.",
    },
    {
      target: "pipelines-pin",
      title: "Pin a pipeline",
      body: "Select the star to pin a pipeline to your sidebar, so the ones you use most are one click away.",
    },
    {
      target: "pipelines-new",
      title: "Start a new pipeline",
      body: "Create a pipeline for a new kind of work. You give it a name, then set up its stages.",
    },
  ],
};

export const PIPELINE_BOARD_TOUR: TourDefinition = {
  id: "pipeline-board",
  title: "A pipeline's board",
  description: "Stages as columns, moving a case on, and adding items.",
  version: 2,
  flag: "enablePipelines",
  label: "this board",
  steps: [
    {
      target: "board-columns",
      title: "Stages as columns",
      body: "Each column is a stage, in order from left to right. The cards in a column are the cases sitting in that stage.",
    },
    {
      target: "pipeline-open-deal-value",
      title: "What the open deals are worth",
      body: "On a board of Pipedrive deals, the total value of every deal still open. When more than one person owns deals, the Owner menu at the top shows just one person's.",
    },
    {
      target: "stage-deal-value",
      title: "Value in each stage",
      body: "Each column shows what the deals in that stage are worth, so you can see where the money sits.",
    },
    {
      target: "pipeline-card",
      title: "Moving a case",
      body: "Drag a card into another column to move the case on. If the move skips the usual order, you are asked for a reason first.",
    },
    {
      target: "board-warnings",
      title: "Steps that will not run",
      body: "This banner lists stages that cannot do their work yet, for example when nobody is assigned or no approver is picked. Select a line to fix it.",
    },
    {
      target: "board-add",
      title: "Add items",
      body: "Add new cases to this pipeline, one at a time or several at once.",
    },
    {
      target: "board-settings",
      title: "Settings",
      body: "Change the stages, who works on each one, and which moves between stages are allowed.",
    },
  ],
};

export const CLIENT_CASE_TOUR: TourDefinition = {
  id: "client-case",
  title: "Client page",
  description: "Where a client is in their journey, where things stand, the next action and who you deal with.",
  version: 4,
  flag: "enablePipelines",
  label: "this client",
  steps: [
    {
      target: "client-journey",
      title: "Where the client is",
      body: "The journey shows which stages are done, the stage the client is in now, and how long they have been there.",
    },
    {
      target: "client-status",
      title: "Where things stand",
      body: "Each stage so far, what is done, what is waiting and on whom (the client or us), with the documents received. Read this first before a call.",
    },
    {
      target: "client-next-action",
      title: "Next action",
      body: "What happens next, who owns it and when it is due. Keep it up to date so anyone can see the next step.",
    },
    {
      target: "client-contacts",
      title: "Contacts",
      body: "The people you deal with at this client, so anyone on your team can pick up the relationship.",
    },
    {
      target: "deal-outcome",
      title: "Won or lost",
      body: "For a client imported from Pipedrive, press Won when they sign or Lost when they say no. The client moves to that stage and the date is kept. Lost asks for a reason, which is optional.",
    },
    {
      target: "case-crm-history",
      title: "History from Pipedrive",
      body: "Every note, email, call and file from Pipedrive, newest first. Use the buttons to show one kind at a time.",
    },
    {
      target: "client-evidence",
      title: "Evidence",
      body: "Files and links you keep for this client, such as a brief or signed papers. Upload a file or add a link so everyone works from the same copy.",
    },
    {
      target: "client-deliverables",
      title: "Journey by stage",
      body: "What belongs in each stage. Upload a document to the stage it belongs to; uploading the signed NDA marks it accepted.",
    },
    {
      target: "client-portal",
      title: "What the client sees",
      body: "A preview of the client's own portal, so you know exactly what they can see before you share anything.",
    },
    {
      target: "client-projects",
      title: "Projects and goals",
      body: "The projects linked to this client and the goals they serve. Open one to see the work in progress.",
    },
    {
      target: "client-last-contact",
      title: "Keeping in touch",
      body: "When you last spoke to the client. On the pipeline board, a card is flagged after 14 days with no contact, or after 30 days in the same stage.",
    },
  ],
};

export const STRATEGY_BOARD_TOUR: TourDefinition = {
  id: "strategy-board",
  title: "Board",
  description: "Your plan on one page for directors, problems first, and board packs.",
  version: 1,
  flag: "enableStrategyBoard",
  label: "the Board",
  steps: [
    {
      target: "board-panel-header",
      title: "What the Board is",
      body: "Your plan on one page for directors: which goals are on course, which to watch and which are off course.",
    },
    {
      target: "board-attention",
      title: "Problems first",
      body: "Goals that are off course or short of evidence come first. Use Ask why to put a question to the person responsible.",
    },
    {
      target: "board-plan",
      title: "The plan",
      body: "Each part of your plan and what has to go right for it, with the latest status. Full strategy opens the whole plan.",
    },
    {
      target: "board-packs",
      title: "Board packs",
      body: "The papers for each board meeting. A pack drafted by the board secretary agent is marked Draft until a board member accepts it.",
    },
    {
      target: "board-make-pack",
      title: "Make a board pack",
      body: "Make a pack for a period yourself. It records where every goal stands at that moment.",
    },
  ],
};

export const WEBSITE_TOUR: TourDefinition = {
  id: "website",
  title: "Website",
  description: "Visitors and Google Search in one place, and connecting Google.",
  version: 1,
  flag: "enableWebsiteView",
  label: "Website",
  steps: [
    {
      target: "website-header",
      title: "Your website at a glance",
      body: "Visitors from Google Analytics and how people find you on Google Search, in one place. You can look, but nothing here changes your site.",
    },
    {
      target: "website-connect",
      title: "Connect Google first",
      body: "Nothing shows until Google is connected. Sign in once with read only access, and the reports are pulled every day.",
    },
    {
      target: "website-pull",
      title: "When the data is from",
      body: "When the reports were last pulled from Google and when the next pull is due. The figures come from that daily pull, not live.",
    },
  ],
};

export const GITHUB_SHARE_TOUR: TourDefinition = {
  id: "github-share-with-agents",
  title: "Share with agents",
  description: "Letting agents use your GitHub for their own work and for people without GitHub.",
  version: 1,
  flag: "enableApps",
  label: "sharing",
  steps: [
    {
      target: "share-intro",
      title: "Sharing your GitHub",
      body: "Agents you share with can use your GitHub for work they start themselves, and for work asked for by someone with no GitHub of their own. Anything they push or open there shows up as you.",
    },
    {
      target: "share-all",
      title: "Share with all",
      body: "Shares your GitHub with every agent at once.",
    },
    {
      target: "share-stop",
      title: "Stop sharing",
      body: "Takes your GitHub away from every agent at once. Anyone who has connected their own GitHub still uses it.",
    },
    {
      target: "share-list",
      title: "One agent at a time",
      body: "Or tick and untick agents one by one.",
    },
  ],
};

export const TEAM_CHAT_TOUR: TourDefinition = {
  id: "team-chat",
  title: "Team chat",
  description: "Messaging people, and asking agents in a group with @mentions.",
  version: 1,
  flag: "enableTeamChat",
  label: "this chat",
  steps: [
    {
      target: "team-chat-members",
      title: "Who is here",
      body: "Everyone in this chat, people and agents. Only members can read it. Add or remove members here.",
    },
    {
      target: "team-chat-thread",
      title: "Ask an agent with @",
      body: "Type @ and pick a member to mention them. Agents reply only when mentioned; if the ask needs real work, the agent makes a task and links it here.",
    },
  ],
};

/** The closing step on everyday tours: where help lives. */
const HELP_EVERYWHERE: TourStep = {
  title: "Help on every page",
  body: "Select Show me around at the top of any page to see its tour. Start each day on Needed from you, at the top of the sidebar.",
};

export const DASHBOARD_TOUR: TourDefinition = {
  id: "dashboard",
  title: "Home",
  description: "What needs you today, what the agents did and how to give them work.",
  version: 1,
  autoStart: false,
  route: { match: /^\/dashboard\/?$/, path: "/dashboard" },
  label: "Home",
  steps: [
    {
      title: "Your home page",
      body: "A summary of your organisation today: what is waiting on you, what the agents have done and what is running now.",
    },
    {
      target: "dashboard-decisions",
      title: "What is waiting on you",
      body: "Agents stop and ask when they cannot go on without you. The most urgent one is shown here. Open decisions to answer them all.",
    },
    {
      target: "dashboard-digest",
      title: "What the agents did",
      body: "Since you were last here gives one line per agent on what they did, so you never need to read the activity log.",
    },
    {
      target: "new-task",
      title: "Give the team work",
      body: "Select New Task and describe what you want in plain words. An agent picks it up and reports back in the task.",
    },
    HELP_EVERYWHERE,
  ],
};

export const NEEDED_TOUR: TourDefinition = {
  id: "needed",
  title: "Needed from you",
  description: "Everything the team is waiting on you for, on one page, and on your phone.",
  version: 3,
  autoStart: false,
  route: { match: /^\/needed\/?$/, path: "/needed" },
  label: "Needed from you",
  steps: [
    {
      target: "needed-summary",
      title: "Start here each day",
      body: "This page answers one question: what is the team waiting on me for? The first line says how many things and how long the oldest has waited.",
    },
    {
      target: "needed-groups",
      title: "Grouped by what to do",
      body: "Questions to answer, sign-offs, stuck work, logins to fix, your own tasks and clients waiting on you. Select a group to jump to it. Select Act here to answer or approve without leaving the page.",
    },
    {
      target: "needed-meanwhile",
      title: "What the team did meanwhile",
      body: "Below the list, see what each agent finished and started since you were last here.",
    },
    {
      title: "On your phone",
      body: "This page works on a phone too. Swipe a row to the right to put it away until tomorrow, and select Undo if you change your mind. Your Inbox works the same way.",
    },
    {
      title: "When it is empty",
      body: "Nothing here means the agents have all they need from you. Check back when the sidebar shows a new decision.",
    },
  ],
};

export const DECISIONS_TOUR: TourDefinition = {
  id: "decisions",
  title: "Decisions",
  description: "Answering the questions agents ask you, in a list or one at a time.",
  version: 1,
  autoStart: false,
  route: { match: /^\/decisions\/?$/, path: "/decisions" },
  label: "Decisions",
  steps: [
    {
      title: "What a decision is",
      body: "When an agent cannot go on without you, it stops and asks here. Each card says what is held up, why, and what happens next.",
    },
    {
      title: "Answer and move on",
      body: "Use the buttons on a card to answer. The agent starts again as soon as you do. Not now sets a card aside without losing it.",
    },
    {
      target: "decisions-view",
      title: "List or Focus",
      body: "List shows every card. Focus shows one at a time, large, so you can clear them quickly, even on a phone.",
    },
    {
      target: "decisions-history",
      title: "What you already decided",
      body: "Your past answers are kept under Decided, so you can check what you said and when.",
    },
  ],
};

export const MY_TASKS_TOUR: TourDefinition = {
  id: "my-tasks",
  title: "Desk",
  description: "What needs you, the tasks you follow, and the tasks you opened lately.",
  version: 2,
  autoStart: false,
  route: { match: /^\/(desk|my-tasks)\/?$/, path: "/desk" },
  label: "Desk",
  steps: [
    {
      title: "Needs me",
      body: "Decisions, reviews and tasks assigned to you, most urgent first. Routine chores stay hidden until you switch on Show routine tasks.",
    },
    {
      title: "Following",
      body: "Star a task on its page to follow it and everything under it. You see how much is done, what waits on you and the latest updates.",
    },
    {
      title: "Recently opened",
      body: "The last tasks you opened, on any device. They are also in the sidebar and at the top of the search box.",
    },
  ],
};

export const TASKS_TOUR: TourDefinition = {
  id: "tasks",
  title: "Tasks",
  description: "Every piece of work in your organisation and how to follow it.",
  version: 1,
  autoStart: false,
  route: { match: /^\/issues\/?$/, path: "/issues" },
  label: "Tasks",
  steps: [
    {
      title: "Every task in one list",
      body: "All the work in your organisation, by agents and by people. Select a task to read its conversation and see how far it has got.",
    },
    {
      title: "Narrow the list",
      body: "Use the status chips, such as Active or Blocked, and the search box at the top to find a task.",
    },
    {
      target: "new-task",
      title: "Start a new task",
      body: "Describe the outcome you want in plain words and pick who should do it.",
    },
  ],
};

export const AGENTS_TOUR: TourDefinition = {
  id: "agents",
  title: "Agents",
  description: "Your team of AI agents: who they are, what they cost and what they are doing.",
  version: 1,
  autoStart: false,
  route: { match: /^\/agents\/(all|active|paused|error|builtin)\/?$/, path: "/agents/all" },
  label: "Agents",
  steps: [
    {
      title: "Your team of agents",
      body: "Each agent is an AI worker with a role, like a member of staff. Select one to see what it is doing, its instructions and its recent work.",
    },
    {
      title: "Reading a row",
      body: "Each row shows what the agent's work this week would cost, the model it uses and when it last checked in. Live means it is working right now.",
    },
    {
      title: "Pausing an agent",
      body: "A paused agent does no work and spends nothing until you resume it. Open the agent to pause or resume.",
    },
  ],
};

export const PROJECTS_TOUR: TourDefinition = {
  id: "projects",
  title: "Projects",
  description: "Groups of tasks with one aim, and where to see their progress.",
  version: 1,
  autoStart: false,
  route: { match: /^\/projects\/?$/, path: "/projects" },
  label: "Projects",
  steps: [
    {
      title: "What a project is",
      body: "A project groups the tasks that share one aim, such as a client engagement or a product launch. Open one to see its tasks, its goal and its budget.",
    },
    {
      title: "Sort to find one",
      body: "Use Sort to order projects by name, by when they last changed or by target date.",
    },
  ],
};

export const GOALS_TOUR: TourDefinition = {
  id: "goals",
  title: "Goals",
  description: "How far you are from each goal and which work serves it.",
  version: 1,
  autoStart: false,
  route: { match: /^\/goals\/?$/, path: "/goals" },
  label: "Goals",
  steps: [
    {
      target: "goals-header",
      title: "How far we are",
      body: "Each goal shows its progress and the projects and tasks that serve it, so you can see whether the work adds up to what you want.",
    },
    {
      title: "Off course first",
      body: "Goals that are slipping come first. Open one to see why and who is responsible.",
    },
  ],
};

export const ROUTINES_TOUR: TourDefinition = {
  id: "routines",
  title: "Routines",
  description: "Work that repeats on a schedule, such as a weekly report.",
  version: 1,
  autoStart: false,
  route: { match: /^\/routines\/?$/, path: "/routines" },
  label: "Routines",
  steps: [
    {
      title: "Work on a schedule",
      body: "A routine is work that repeats, such as a Monday report or a daily inbox check. Each time it runs, it makes a task you can follow like any other.",
    },
    {
      target: "routines-create",
      title: "Make a routine",
      body: "Say what should happen, who does it and how often. You can pause a routine at any time without deleting it.",
    },
  ],
};

export const APPROVALS_TOUR: TourDefinition = {
  id: "approvals",
  title: "Approvals",
  description: "Sign-offs agents need before a governed step, such as hiring or spending.",
  version: 1,
  autoStart: false,
  route: { match: /^\/approvals\/(pending|all)\/?$/, path: "/approvals/pending" },
  label: "Approvals",
  steps: [
    {
      title: "Sign-offs",
      body: "Some steps need a person's yes before an agent may take them, such as hiring an agent or going over budget. They wait here.",
    },
    {
      title: "Approve, reject or ask for changes",
      body: "Open an approval to read what is asked and why. Add a note when you reject or ask for changes, so the agent knows what to do next.",
    },
  ],
};

export const MEMORY_TOUR: TourDefinition = {
  id: "memory",
  title: "Memory",
  description: "What your agents remember and how to check it.",
  version: 1,
  autoStart: false,
  route: { match: /^\/memory(\/(activity|review))?\/?$/, path: "/memory" },
  label: "Memory",
  steps: [
    {
      title: "Shared memory",
      body: "What agents and people have saved for later: facts about clients, decisions and how you like things done. Agents read it before they work.",
    },
    {
      title: "Three views",
      body: "Connections shows how entries link. Contributions shows who added what. Review lists entries waiting for a person to check them.",
    },
  ],
};

export const TASK_DETAIL_TOUR: TourDefinition = {
  id: "task-detail",
  title: "A task",
  description: "Reading a task's conversation, replying and changing who does it.",
  version: 1,
  autoStart: false,
  // Opened from Tutorials on the Tasks list: a task tour needs a task on screen.
  route: { match: /^\/issues\/[^/]+\/?$/, path: "/issues" },
  label: "this task",
  steps: [
    {
      title: "The conversation",
      body: "A task reads like a chat. The agent posts what it did, what it found and any question it has. Newest is at the bottom.",
    },
    {
      title: "Reply in plain words",
      body: "Write a reply at the bottom to give a steer, add detail or attach a file. The agent picks it up the next time it works on the task.",
    },
    {
      title: "Status and owner",
      body: "The status says where the task is: to do, in progress, in review, blocked or done. Change the owner to hand it to another agent or to a person.",
    },
    {
      title: "When it is waiting on you",
      body: "If the agent needs you, the task also appears on Needed from you and in Decisions, so you never have to hunt for it.",
    },
  ],
};

export const AGENT_DETAIL_TOUR: TourDefinition = {
  id: "agent-detail",
  title: "An agent",
  description: "What an agent is doing, its instructions and how to pause it.",
  version: 1,
  autoStart: false,
  route: { match: /^\/agents\/(?!(all|active|paused|error|builtin|new)\/?$)[^/]+(\/[^/]+)?\/?$/, path: "/agents/all" },
  label: "this agent",
  steps: [
    {
      title: "Overview",
      body: "What the agent is working on now, its recent work and what it has cost. Start here to see if it is doing its job.",
    },
    {
      title: "Instructions",
      body: "The agent's job description in plain words. Edit them to change how it works.",
    },
    {
      title: "Skills and tools",
      body: "Skills are the know-how it can use, such as writing a proposal. Tools are the apps it can reach, such as email or a calendar.",
    },
    {
      title: "Pause when unsure",
      body: "Pausing stops all its work and spending at once, and nothing is lost. Resume when you are ready.",
    },
  ],
};

export const INTEGRATIONS_TOUR: TourDefinition = {
  id: "integrations",
  title: "Integrations",
  description: "What each integration is for: bringing work in, sending updates out, spreadsheets and keys.",
  version: 2,
  autoStart: false,
  route: { match: /^\/company\/settings\/integrations\/?$/, path: "/company/settings/integrations" },
  label: "Integrations",
  steps: [
    {
      title: "Work in and out of GSAM",
      body: "Integrations connect GSAM to the tools your team already uses. Nothing is switched on until you turn it on, and you can turn anything off again.",
    },
    {
      target: "integrations-apps",
      title: "Your other tools",
      body: "Each card says what it does and when you would want it. Connect lets agents work in that tool. Import copies your clients and notes in once, from a file, with no key.",
    },
    {
      target: "integration-pipedrive",
      title: "Pipedrive",
      body: "Connect with your Pipedrive key to bring in organisations, people, deals, activities, notes, emails and files. GSAM only reads from Pipedrive and never changes anything there. No key? Upload a Pipedrive export instead.",
    },
    {
      target: "integrations-builtin",
      title: "Built in, no account needed",
      body: "An incoming webhook turns a form or another tool's requests into tasks. Updates to Slack, Teams or Zapier tell your team when work is done. The calendar feed puts deadlines in your own calendar.",
    },
    {
      target: "integrations-export",
      title: "Download to a spreadsheet",
      body: "Take your clients, tasks or this week's numbers into Excel or Google Sheets with one click.",
    },
    {
      target: "integrations-keys",
      title: "What needs a key",
      body: "Some integrations wait on a key from the provider. This list names each one, the exact names to paste and where they go.",
    },
  ],
};

/** Everyday pages: their tours live in the page bar. */
export const WEEKLY_REPORT_TOUR: TourDefinition = {
  id: "weekly-report",
  title: "This week",
  description: "A one page report of the week to read or share with your team.",
  version: 1,
  autoStart: false,
  route: { match: /^\/weekly-report\/?$/, path: "/weekly-report" },
  label: "This week",
  steps: [
    {
      target: "weekly-report-headline",
      title: "The week in one line",
      body: "The first line sums up the last seven days: what was finished, what is stuck and what is waiting on you.",
    },
    {
      target: "weekly-report-needs-you",
      title: "What needs you",
      body: "Anything the agents cannot finish without you. Select an item to open it and answer.",
    },
    {
      target: "weekly-report-stuck",
      title: "What is stuck",
      body: "Work that has stopped, and why. These are the items to ask about in your next team meeting.",
    },
    {
      target: "weekly-report-share",
      title: "Share it",
      body: "Download a PDF or copy the report as text to paste into an email or chat. Nobody needs a login to read it.",
    },
  ],
};

export const CALENDAR_TOUR: TourDefinition = {
  id: "calendar",
  title: "Calendar",
  description: "Due dates, routines and meetings by month or by week.",
  version: 1,
  autoStart: false,
  route: { match: /^\/calendar\/?$/, path: "/calendar" },
  label: "Calendar",
  steps: [
    {
      title: "Everything with a date",
      body: "Task due dates, routines and goals in one place. Select a day to see what is on it and move a due date.",
    },
    {
      target: "calendar-view",
      title: "Month or week",
      body: "Switch to Week to see every item for seven days in one row, with nothing hidden. On a phone the calendar shows a list instead.",
    },
    {
      target: "calendar-filters",
      title: "Choose what to show",
      body: "Turn tasks, routines or goals on or off so the calendar shows only what you care about.",
    },
    {
      target: "calendar-copy-week",
      title: "Share the week ahead",
      body: "Copy the next seven days as text to paste into an email or chat.",
    },
    {
      target: "calendar-add",
      title: "Add it to your own calendar",
      body: "Download a file for Outlook, Google Calendar or Apple Calendar so due dates show next to your meetings.",
    },
  ],
};

export const BLOCKED_TOUR: TourDefinition = {
  id: "blocked",
  title: "Blocked work",
  description: "What is holding work up, which tasks are on hold, and how to get them moving.",
  version: 1,
  autoStart: false,
  route: { match: /^\/inbox\/blocked\/?$/, path: "/inbox/blocked" },
  label: "Blocked work",
  steps: [
    {
      title: "Why work has stopped",
      body: "This page lists every task that cannot go on, and what it is waiting for. Most need one answer or one decision from someone.",
    },
    {
      target: "recovery-holds",
      title: "Tasks on hold",
      body: "GSAM puts a task on hold when it keeps failing, so it stops using time and money. Read the reason, fix it, then clear the hold to let the agent try again.",
    },
    {
      target: "blocked-work-summary",
      title: "What is holding work up",
      body: "One line for each thing that is blocking other work, with how many tasks wait on it. Clear the top one first: it frees the most.",
    },
    {
      target: "blocked-inbox",
      title: "Every blocked task",
      body: "Each row says who or what it is waiting on and for how long. Open a task to answer, reassign it or unblock it.",
    },
  ],
};

export const SCORECARD_TOUR: TourDefinition = {
  id: "scorecard",
  title: "Scorecard",
  description: "What each agent finished, how that compares with before, and how to share it.",
  version: 1,
  autoStart: false,
  route: { match: /^\/scorecard\/?$/, path: "/scorecard" },
  label: "Scorecard",
  steps: [
    {
      target: "scorecard-totals",
      title: "The team at a glance",
      body: "Finished, under way, waiting for review, stuck and past due. The small line under Finished says whether that is up or down on the period before, so you can see if the team is speeding up.",
    },
    {
      target: "scorecard-period",
      title: "Choose the period",
      body: "Switch between the last 7 and the last 30 days. Each comparison uses the same length of time just before it.",
    },
    {
      target: "scorecard-agents",
      title: "Each agent",
      body: "One card per agent, with stuck work first. Each card says what they finished and are on now, and whether they finished more or less than before.",
    },
    {
      target: "scorecard-actions",
      title: "Ask and share",
      body: "Ask about every stuck task in one go, download the numbers as a spreadsheet, or copy a short written update to paste into an email.",
    },
  ],
};

export const MORNING_TOUR: TourDefinition = {
  id: "morning",
  title: "Your morning summary",
  description: "One page each morning: what needs you, what is due and what the team did.",
  version: 1,
  autoStart: false,
  route: { match: /^\/(morning|today)\/?$/, path: "/today" },
  label: "Morning summary",
  steps: [
    {
      title: "Start your day here",
      body: "A short summary of the last day, made for reading on a phone with a coffee. It reaches your phone each morning too.",
    },
    {
      target: "morning-needs-you",
      title: "Needs you",
      body: "Questions and sign-offs waiting on you. Open Decisions to answer them all in one place.",
    },
    {
      target: "morning-due-today",
      title: "Due today",
      body: "Tasks with today's due date, so nothing slips.",
    },
    {
      target: "morning-finished-since-yesterday",
      title: "What the team finished",
      body: "Everything the agents completed in the last 24 hours.",
    },
    {
      target: "morning-stuck",
      title: "What is stuck",
      body: "Tasks that cannot go on. Open the blocked page to see why and get them moving.",
    },
  ],
};

export const ORGANISATIONS_TOUR: TourDefinition = {
  id: "organisations",
  title: "Organisations",
  description: "Every company you work with in one list, and bringing them in from Pipedrive, HubSpot or Notion.",
  version: 1,
  flag: "enablePipelines",
  autoStart: false,
  route: { match: /^\/organisations\/?$/, path: "/organisations" },
  label: "Organisations",
  steps: [
    {
      title: "Everyone you work with",
      body: "Targets, prospects, clients and former clients, each with their contacts, owner and country. Open one to see its timeline and cases.",
    },
    {
      target: "organisations-import",
      title: "Bring in your CRM",
      body: "Select Import from Pipedrive to copy your organisations, people, deals, notes and files across. You see a preview first, and running it again updates rather than duplicates. HubSpot and Notion work the same way.",
    },
    {
      target: "organisations-search",
      title: "Find one fast",
      body: "Search by name, industry, country or contact, or pick a status such as Client to narrow the list.",
    },
  ],
};

export const SEARCH_PAGE_TOUR: TourDefinition = {
  id: "search",
  title: "Search",
  description: "Find any task, comment, document or agent, and narrow the results.",
  version: 1,
  autoStart: false,
  route: { match: /^\/search\/?$/, path: "/search" },
  label: "Search",
  steps: [
    {
      target: "search-page-input",
      title: "Type anything",
      body: "A client, a task number or a few words from a document. Results update as you type.",
    },
    {
      target: "search-filters",
      title: "Narrow the results",
      body: "When there are too many results, use the filters and the sort order to narrow the list.",
    },
    {
      target: "search-results",
      title: "Open what you need",
      body: "The best matches come first. Select a result to open it.",
    },
    {
      title: "From any page",
      body: "Press Cmd or Ctrl and K to search from anywhere, or Cmd or Ctrl and J to ask Everest a question in plain words.",
    },
  ],
};

export const DELIVERABLES_TOUR: TourDefinition = {
  id: "deliverables",
  title: "Deliverables",
  description: "Every finished document and site the agents made, in one place.",
  version: 1,
  autoStart: false,
  route: { match: /^\/deliverables\/?$/, path: "/deliverables" },
  label: "Deliverables",
  steps: [
    {
      title: "Finished work lives here",
      body: "When an agent finishes a document, a deck or a website, it lands on this page. Open any card to read it or download it.",
    },
    {
      target: "deliverables-search",
      title: "Find anything",
      body: "Type a title, a client or a few words from inside a document. Press / to jump here from anywhere on the page.",
    },
    {
      target: "deliverable-audience",
      title: "Who it is for",
      body: "Switch between work made for your clients and work made for your own team.",
    },
    {
      target: "deliverables-kind",
      title: "Pick a kind",
      body: "Show only documents, sites or another kind of work.",
    },
    {
      target: "deliverable-sort",
      title: "Sort and group",
      body: "Put the newest first, or group the work by project or client.",
    },
    {
      target: "deliverables-live-previews",
      title: "Live sites",
      body: "Websites the agents are building show a live preview here, so you can check them without leaving the page.",
    },
  ],
};

export const SINCE_LAST_VISIT_TOUR: TourDefinition = {
  id: "since-last-visit",
  title: "Since you were last here",
  description: "A catch-up on what each agent did while you were away.",
  version: 1,
  autoStart: false,
  route: { match: /^\/since-last-visit\/?$/, path: "/since-last-visit" },
  label: "Since you were last here",
  steps: [
    {
      title: "Catch up in a minute",
      body: "This page shows what changed since your last visit, so you do not need to read every update.",
    },
    {
      target: "since-last-visit-agents",
      title: "One section per agent",
      body: "Each agent lists what it finished and what it moved on. Open a task to see the detail.",
    },
    {
      title: "Need everything?",
      body: "The link at the bottom opens the full Audit log with every event.",
    },
  ],
};

export const CORE_TOURS: TourDefinition[] = [
  NEEDED_TOUR,
  DASHBOARD_TOUR,
  DECISIONS_TOUR,
  MY_TASKS_TOUR,
  TASKS_TOUR,
  CALENDAR_TOUR,
  AGENTS_TOUR,
  PROJECTS_TOUR,
  GOALS_TOUR,
  ROUTINES_TOUR,
  APPROVALS_TOUR,
  MEMORY_TOUR,
  MORNING_TOUR,
  WEEKLY_REPORT_TOUR,
  SCORECARD_TOUR,
  BLOCKED_TOUR,
  ORGANISATIONS_TOUR,
  SEARCH_PAGE_TOUR,
  DELIVERABLES_TOUR,
  SINCE_LAST_VISIT_TOUR,
  IMAGES_TOUR,
  TASK_DETAIL_TOUR,
  AGENT_DETAIL_TOUR,
  INTEGRATIONS_TOUR,
];

/** The everyday tour for a company relative path, if there is one. */
export function coreTourForPath(pathname: string): TourDefinition | null {
  return CORE_TOURS.find((tour) => tour.route?.match.test(pathname)) ?? null;
}

/** Every tour, in the order the Tutorials list shows them. */
export const ALL_TOURS: TourDefinition[] = [
  ...CORE_TOURS,
  SEARCH_ASK_TOUR,
  PIPELINES_LIST_TOUR,
  PIPELINE_BOARD_TOUR,
  CLIENT_CASE_TOUR,
  STRATEGY_BOARD_TOUR,
  WEBSITE_TOUR,
  GITHUB_SHARE_TOUR,
  TEAM_CHAT_TOUR,
];
