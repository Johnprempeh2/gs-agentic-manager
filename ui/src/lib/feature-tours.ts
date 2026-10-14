import type { InstanceExperimentalSettings } from "@greatstone/shared";

/** One stop on a tour: the element with `data-tour="<target>"`, a title and a sentence or two. */
export interface TourStep {
  target: string;
  title: string;
  body: string;
}

export interface TourDefinition {
  id: string;
  /** Bump to show the tour again to everyone who has seen it. */
  version: number;
  /** The feature switch the tour belongs to; no tour while it is off. */
  flag: keyof InstanceExperimentalSettings;
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

/** Every tour, in the order the Tutorials list shows them. */
export const ALL_TOURS: TourDefinition[] = [
  PIPELINES_LIST_TOUR,
  PIPELINE_BOARD_TOUR,
  CLIENT_CASE_TOUR,
  STRATEGY_BOARD_TOUR,
  WEBSITE_TOUR,
  GITHUB_SHARE_TOUR,
  TEAM_CHAT_TOUR,
];
