/** The words GS Agentic Manager uses, in plain words for people who are new to it. */
export type GlossaryEntry = {
  id: string;
  term: string;
  plain: string;
  example?: string;
};

export const GLOSSARY: GlossaryEntry[] = [
  {
    id: "agent",
    term: "Agent",
    plain: "An AI worker on your team. Each agent has a job, a manager and a budget, and works on the tasks you give it.",
    example: "A marketing agent that writes the weekly newsletter.",
  },
  {
    id: "task",
    term: "Task",
    plain: "One piece of work with one owner. The owner can be an agent or a person.",
    example: "Draft the proposal for Acme.",
  },
  {
    id: "run",
    term: "Run",
    plain: "One working session of an agent. The agent wakes up, does some work on its tasks and writes down what it did.",
  },
  {
    id: "routine",
    term: "Routine",
    plain: "Work that repeats on a schedule. Each time it is due, it makes a new task.",
    example: "Every Monday at 9am, send the sales summary.",
  },
  {
    id: "project",
    term: "Project",
    plain: "A group of tasks that work towards one result.",
  },
  {
    id: "goal",
    term: "Goal",
    plain: "A result the organisation wants, with a number to show how close you are.",
    example: "Sign 10 new clients this quarter.",
  },
  {
    id: "decision",
    term: "Decision",
    plain: "A point where an agent has stopped and needs a person to choose, answer or approve before it can go on.",
  },
  {
    id: "approval",
    term: "Sign-off",
    plain: "A step that needs a person's yes before it happens, such as hiring an agent or spending more money.",
  },
  {
    id: "blocked",
    term: "Blocked",
    plain: "Work that has stopped and cannot go on by itself. Someone needs to give a steer, fix something or hand it on.",
  },
  {
    id: "budget",
    term: "Budget",
    plain: "The most an agent may spend each month. When it reaches the limit it pauses until someone raises it.",
  },
  {
    id: "skill",
    term: "Skill",
    plain: "Written know-how an agent can use, such as your house style or how to file an invoice.",
  },
  {
    id: "app",
    term: "App",
    plain: "An outside service the agents can use for you, such as email, a calendar or GitHub. You connect it once in Apps.",
  },
  {
    id: "memory",
    term: "Memory",
    plain: "What the organisation knows and has learned, kept in one place so every agent can use it.",
  },
  {
    id: "pipeline",
    term: "Pipeline",
    plain: "A board of stages that items move through, such as clients going from first call to signed.",
  },
  {
    id: "lead",
    term: "Lead",
    plain: "A possible client who has shown interest but has not become a deal yet.",
    example: "Someone who filled in the contact form on your website.",
  },
  {
    id: "deal",
    term: "Deal",
    plain: "A piece of business you are working to win with a client. It moves through the stages of a pipeline until it is won or lost.",
  },
  {
    id: "devtools",
    term: "DevTools journey",
    plain: "The pipeline for clients brought over from Pipedrive. It keeps their Pipedrive stages, deal details and history.",
  },
  {
    id: "hold",
    term: "Hold",
    plain: "A safety pause on a task. When a run stops part-way through something outside the app, such as sending an email, the task waits until a person says what happened.",
  },
  {
    id: "clear-and-wake",
    term: "Clear and wake",
    plain: "The button that lifts a hold. You say what happened, and the agent picks the task up again.",
  },
];

const BY_ID = new Map(GLOSSARY.map((entry) => [entry.id, entry]));

export function glossaryEntry(id: string): GlossaryEntry | undefined {
  return BY_ID.get(id);
}
