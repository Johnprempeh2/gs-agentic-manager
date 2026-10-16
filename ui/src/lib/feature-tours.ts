import type { InstanceExperimentalSettings } from "@greatstone/shared";
import { SEARCH_ASK_TOUR } from "./search-ask-tour";

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
  version: 1,
  flag: "enablePipelines",
  label: "this board",
  steps: [
    {
      target: "board-columns",
      title: "Stages as columns",
      body: "Each column is a stage, in order from left to right. The cards in a column are the cases sitting in that stage.",
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
  description: "Where a client is in their journey, the next action and who you deal with.",
  version: 1,
  flag: "enablePipelines",
  label: "this client",
  steps: [
    {
      target: "client-journey",
      title: "Where the client is",
      body: "The journey shows which stages are done, the stage the client is in now, and how long they have been there.",
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
  description: "Everything the team is waiting on you for, on one page.",
  version: 2,
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
  title: "My tasks",
  description: "Work assigned to you rather than to an agent.",
  version: 1,
  autoStart: false,
  route: { match: /^\/my-tasks\/?$/, path: "/my-tasks" },
  label: "My tasks",
  steps: [
    {
      title: "Tasks that are yours",
      body: "Work assigned to you, not to an agent. Questions from agents live in Decisions; this list is the work only you can do.",
    },
    {
      title: "Hand it over",
      body: "Open a task to finish it, comment on it or assign it to an agent. Once an agent has it, it leaves this list.",
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
  version: 1,
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
export const CORE_TOURS: TourDefinition[] = [
  NEEDED_TOUR,
  DASHBOARD_TOUR,
  DECISIONS_TOUR,
  MY_TASKS_TOUR,
  TASKS_TOUR,
  AGENTS_TOUR,
  PROJECTS_TOUR,
  GOALS_TOUR,
  ROUTINES_TOUR,
  APPROVALS_TOUR,
  MEMORY_TOUR,
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
