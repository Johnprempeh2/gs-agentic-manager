import type { AskUserQuestionsQuestion, AttentionItem, IssueThreadInteraction } from "@greatstone/shared";
import type { SpokenOption } from "./focus-speech";

/**
 * Which Decisions feed rows Focus mode takes, and what it reads aloud for each
 * (GRE-55). First version: questions, confirmations and suggested tasks.
 * Approvals, join requests, reviews and the rest stay in List.
 */
const FOCUS_INTERACTION_KINDS = new Set<string>([
  "ask_user_questions",
  "request_confirmation",
  "request_checkbox_confirmation",
  "suggest_tasks",
]);

export function focusItemKind(item: AttentionItem): string | null {
  const kind = item.subject.metadata?.kind;
  return typeof kind === "string" ? kind : null;
}

export function focusItemIssueId(item: AttentionItem): string | null {
  const issueId = item.subject.metadata?.issueId;
  if (typeof issueId === "string" && issueId) return issueId;
  return item.relatedIssue?.id ?? null;
}

export function isFocusItem(item: AttentionItem): boolean {
  if (item.sourceKind !== "issue_thread_interaction") return false;
  const kind = focusItemKind(item);
  return kind !== null && FOCUS_INTERACTION_KINDS.has(kind) && focusItemIssueId(item) !== null;
}

export function focusKindLabel(kind: string | null): string {
  if (kind === "ask_user_questions") return "Question";
  if (kind === "suggest_tasks") return "Tasks";
  return "Confirm";
}

/**
 * Single-question sets get the Focus answer form (options, spoken note,
 * Submit & next). Everything else renders the list's own interaction card.
 */
export function focusNativeQuestion(interaction: IssueThreadInteraction): AskUserQuestionsQuestion | null {
  if (interaction.kind !== "ask_user_questions") return null;
  const { questions } = interaction.payload;
  return questions.length === 1 ? questions[0]! : null;
}

export interface FocusSpeechContent {
  question: string;
  background: string | null;
  options: SpokenOption[];
  optionNoun: string;
}

function joinBackground(parts: Array<string | null | undefined>, question: string): string | null {
  const seen = new Set<string>([question.trim()]);
  const kept: string[] = [];
  for (const part of parts) {
    const text = part?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    kept.push(text);
  }
  return kept.length > 0 ? kept.join("\n\n") : null;
}

export function focusSpeechContent(interaction: IssueThreadInteraction, fallbackTitle: string | null): FocusSpeechContent {
  const title = interaction.title ?? fallbackTitle ?? "";
  switch (interaction.kind) {
    case "ask_user_questions": {
      const { questions } = interaction.payload;
      if (questions.length === 1) {
        const question = questions[0]!;
        return {
          question: question.prompt,
          background: joinBackground([interaction.summary, question.helpText], question.prompt),
          options: question.options.map((option) => ({ label: option.label, description: option.description })),
          optionNoun: "Option",
        };
      }
      const question = interaction.payload.title ?? title ?? "Questions";
      return {
        question: question || "Questions",
        background: joinBackground([interaction.summary], question),
        options: questions.map((entry) => ({ label: entry.prompt })),
        optionNoun: "Question",
      };
    }
    case "request_confirmation":
      return {
        question: interaction.payload.prompt,
        background: joinBackground([interaction.summary, interaction.payload.detailsMarkdown], interaction.payload.prompt),
        options: [
          { label: interaction.payload.acceptLabel || "Accept" },
          { label: interaction.payload.rejectLabel || "Decline" },
        ],
        optionNoun: "Option",
      };
    case "request_checkbox_confirmation":
      return {
        question: interaction.payload.prompt,
        background: joinBackground([interaction.summary, interaction.payload.detailsMarkdown], interaction.payload.prompt),
        options: interaction.payload.options.map((option) => ({ label: option.label, description: option.description })),
        optionNoun: "Option",
      };
    case "suggest_tasks": {
      const question = title || "Suggested tasks";
      return {
        question,
        background: joinBackground([interaction.summary], question),
        options: interaction.payload.tasks
          .filter((task) => !task.hiddenInPreview)
          .map((task) => ({ label: task.title })),
        optionNoun: "Task",
      };
    }
    default:
      return { question: title, background: interaction.summary ?? null, options: [], optionNoun: "Option" };
  }
}
