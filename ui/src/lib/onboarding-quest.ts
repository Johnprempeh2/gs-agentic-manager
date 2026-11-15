import { QUEST_CHAPTERS, type QuestChapterProgress } from "@greatstone/shared";
import type { QuestState } from "@/api/onboarding";
import type { TourDefinition } from "./feature-tours";

type Step = QuestChapterProgress["steps"][number];

/** The spotlight for one quest step: a one-stop tour on the existing engine, run only when "Show me" asks for it. */
export const questHintId = (stepKey: string) => `questhint-${stepKey}`;

export function questHintTour(step: Pick<Step, "key" | "title" | "body" | "target">): TourDefinition {
  return {
    id: questHintId(step.key),
    version: 1,
    autoStart: false,
    label: step.title,
    title: step.title,
    description: step.body,
    steps: [{ target: step.target, title: step.title, body: step.body }],
  };
}

/** Where "Show me" goes, with the spotlight asked for; null while the practice task does not exist. */
export function showMeHref(step: Pick<Step, "key" | "path">, practiceIssueId: string | null): string | null {
  if (step.path.includes("{practice}") && !practiceIssueId) return null;
  const path = step.path.replace("{practice}", practiceIssueId ?? "");
  if (/[?&]tour=/.test(path)) return path;
  return `${path}${path.includes("?") ? "&" : "?"}tour=${questHintId(step.key)}`;
}

export function findStepInState(state: QuestState, key: string): Step | undefined {
  for (const chapter of state.chapters) {
    const step = chapter.steps.find((entry) => entry.key === key);
    if (step) return step;
  }
  return undefined;
}

/** The visit step this page completes for this person, when it is theirs and not yet done. */
export function pendingVisit(path: string, state: QuestState | undefined): string | null {
  if (!state?.startedAt || state.finishedAt) return null;
  const clean = path.replace(/([?&])tour=[^&]*&?/, "$1").replace(/[?&]$/, "");
  for (const chapter of QUEST_CHAPTERS) {
    for (const step of chapter.steps) {
      if (step.how !== "visit" || !step.match?.test(clean)) continue;
      const mine = findStepInState(state, step.key);
      if (mine && !mine.doneAt) return step.key;
    }
  }
  return null;
}

/** What changed between two reads, for the "step done" and "chapter complete" notes. */
export function questChanges(prev: QuestState | undefined, next: QuestState) {
  if (!prev?.startedAt || prev.startedAt !== next.startedAt) return { steps: [], chapters: [], finished: false };
  const wasDone = new Set(prev.chapters.flatMap((chapter) => chapter.steps.filter((step) => step.doneAt).map((step) => step.key)));
  const hadBadge = new Set(prev.chapters.filter((chapter) => chapter.badge).map((chapter) => chapter.key));
  return {
    steps: next.chapters.flatMap((chapter) => chapter.steps.filter((step) => step.doneAt && !wasDone.has(step.key)).map((step) => step.title)),
    chapters: next.chapters.filter((chapter) => chapter.badge && !hadBadge.has(chapter.key)).map((chapter) => chapter.title),
    finished: !prev.finishedAt && Boolean(next.finishedAt),
  };
}
