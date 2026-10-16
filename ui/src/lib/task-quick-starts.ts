/**
 * Quick starts for New task: plain-English starting points that fill in a
 * clear brief, so nobody faces a blank box. Words in square brackets are the
 * parts to fill in; the dialog selects the first one in the title.
 */
export interface TaskQuickStart {
  id: string;
  label: string;
  title: string;
  description: string;
}

const DONE_WHEN_APPROVAL = "Do not send anything outside the company without my approval.";

export const TASK_QUICK_STARTS: readonly TaskQuickStart[] = [
  {
    id: "research-company",
    label: "Research a company",
    title: "Research [company name]",
    description: [
      "## What I need",
      "A one-page brief on [company name] so I can decide how to approach them.",
      "",
      "## Cover",
      "- What they do and who their customers are",
      "- Size, ownership and any recent news",
      "- The people we should know",
      "- Where we could help them",
      "",
      "## Done when",
      "The brief is attached to this task, with links to your sources.",
    ].join("\n"),
  },
  {
    id: "meeting-brief",
    label: "Prepare a meeting brief",
    title: "Meeting brief: [who] on [date]",
    description: [
      "## The meeting",
      "I am meeting [who] on [date] about [topic].",
      "",
      "## Include",
      "- Who they are and what they care about",
      "- What we have discussed with them before",
      "- Three questions I should ask",
      "- What a good outcome looks like",
      "",
      "## Done when",
      "A one-page brief is attached to this task the day before the meeting.",
    ].join("\n"),
  },
  {
    id: "draft-email",
    label: "Draft an email",
    title: "Draft an email to [who] about [topic]",
    description: [
      "## What the email should do",
      "[Say what you want the reader to know or do.]",
      "",
      "## Tone",
      "Warm, clear and short. British English.",
      "",
      "## Done when",
      `A draft is ready for me to review in this task. ${DONE_WHEN_APPROVAL}`,
    ].join("\n"),
  },
  {
    id: "proposal",
    label: "Write a proposal",
    title: "Proposal for [client]",
    description: [
      "## Background",
      "[What the client asked for and why it matters to them.]",
      "",
      "## Include",
      "- Their challenge, in their words",
      "- What we will do, in stages",
      "- Timings and what we need from them",
      "- Price and terms",
      "",
      "## Done when",
      `A draft proposal is attached to this task for my review. ${DONE_WHEN_APPROVAL}`,
    ].join("\n"),
  },
  {
    id: "summarise",
    label: "Summarise a document",
    title: "Summarise [document]",
    description: [
      "## The document",
      "Attach it below, or paste a link here.",
      "",
      "## Give me",
      "- The five points that matter most",
      "- Anything I need to decide or reply to",
      "- Dates, amounts and names worth noting",
      "",
      "## Done when",
      "The summary is posted on this task, no longer than one page.",
    ].join("\n"),
  },
  {
    id: "plan-project",
    label: "Plan a project",
    title: "Plan: [project name]",
    description: [
      "## The goal",
      "[What success looks like and by when.]",
      "",
      "## Give me",
      "- The main stages and who should do each one",
      "- Risks and what we need from other people",
      "- A first week of tasks",
      "",
      "## Done when",
      "The plan is on this task for my approval before any work starts.",
    ].join("\n"),
  },
  {
    id: "board-update",
    label: "Write a board update",
    title: "Board update for [month]",
    description: [
      "## Who it is for",
      "[The board, investors or partners] reading it before [meeting or date].",
      "",
      "## Cover",
      "- Headline: how the month went, in three lines",
      "- Progress against our goals, with numbers",
      "- Money: income, spending and cash",
      "- Risks and what we are doing about them",
      "- Decisions or help we need from them",
      "",
      "## Done when",
      `A draft of no more than two pages is attached to this task for my review. ${DONE_WHEN_APPROVAL}`,
    ].join("\n"),
  },
  {
    id: "decision-paper",
    label: "Help me decide",
    title: "Decide: [the question]",
    description: [
      "## The decision",
      "I need to decide [the question] by [date].",
      "",
      "## Give me",
      "- Two or three options, each in one paragraph",
      "- What each one costs, and what could go wrong",
      "- Your recommendation and why",
      "",
      "## Done when",
      "A one-page comparison is posted on this task, with your recommendation at the top.",
    ].join("\n"),
  },
  {
    id: "follow-up",
    label: "Chase a reply",
    title: "Follow up with [who] about [topic]",
    description: [
      "## Where things stand",
      "We last spoke to [who] on [date] and are waiting for [what we need from them].",
      "",
      "## Give me",
      "- A short, friendly follow-up message ready to send",
      "- A reminder on this task if there is still no reply in a week",
      "",
      "## Done when",
      `The draft message is on this task for my review. ${DONE_WHEN_APPROVAL}`,
    ].join("\n"),
  },
];

/** The first [placeholder] in a text, as a start and end index, or null. */
export function firstPlaceholderRange(text: string): { start: number; end: number } | null {
  const match = /\[[^\]]+\]/.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

const QUICK_START_PLACEHOLDERS: ReadonlySet<string> = new Set(
  TASK_QUICK_STARTS.flatMap((quickStart) =>
    `${quickStart.title}\n${quickStart.description}`.match(/\[[^\]]+\]/g) ?? [],
  ),
);

/**
 * The quick start words in brackets still left in a draft, once each, in
 * the order they appear. Only the quick starts' own placeholders count, so a
 * markdown link or other square brackets the user wrote are never flagged.
 */
export function unfilledPlaceholders(title: string, description: string): string[] {
  const found = `${title}\n${description}`.match(/\[[^\]]+\]/g) ?? [];
  return [...new Set(found.filter((token) => QUICK_START_PLACEHOLDERS.has(token)))];
}
