import {
  DEEP_DIVE_ANSWER_LABELS,
  DEEP_DIVE_PILLAR_LABELS,
  deepDiveInterviewCounts,
  type DeepDiveAnswerStatus,
  type DeepDiveInterviewLog,
} from "@greatstone/shared";
import { formatDate } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";

/** Answered reads as done, unclear needs attention, not answered is inert. */
const ANSWER_TONE: Record<DeepDiveAnswerStatus, string> = {
  answered: "succeeded",
  unclear: "warning",
  not_answered: "backlog",
};

/** One line: "3 answered · 1 unclear · 2 not answered · 1 note". */
export function interviewLogCountsText(log: DeepDiveInterviewLog): string {
  const c = deepDiveInterviewCounts(log);
  return [
    `${c.answered} answered`,
    `${c.unclear} unclear`,
    `${c.not_answered} not answered`,
    `${c.notes} ${c.notes === 1 ? "note" : "notes"}`,
  ].join(" · ");
}

/**
 * An interview logged from a transcript (GRE-4430): every question with
 * whether it was answered, the answer and the speaker's own words, grouped
 * by the Deep Dive's workstreams, then talk outside the questions.
 */
export function InterviewLogView({ log }: { log: DeepDiveInterviewLog }) {
  const groups = new Map<string, DeepDiveInterviewLog["items"]>();
  for (const item of log.items) {
    const key = item.workstream ?? "";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {log.interviewee} · held {formatDate(log.heldOn)} ·
        questions from {log.questionSource}
      </p>
      {[...groups].map(([workstream, items]) => (
        <section key={workstream || "unplaced"} className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{workstream || "No workstream named"}</h4>
          <ol className="divide-y divide-border rounded-md border border-border">
            {items.map((item, index) => (
              <li key={`${index}-${item.question}`} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 break-words text-sm font-medium">{item.question}</p>
                  <StatusBadge status={ANSWER_TONE[item.status]} label={DEEP_DIVE_ANSWER_LABELS[item.status]} />
                </div>
                {item.answer ? <p className="break-words text-sm">{item.answer}</p> : null}
                {item.quote ? (
                  <blockquote className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
                    "{item.quote}"{item.at ? <span className="ml-2 font-mono text-xs">{item.at}</span> : null}
                  </blockquote>
                ) : null}
                {item.pillars?.length ? (
                  <p className="text-xs text-muted-foreground">{item.pillars.map((p) => DEEP_DIVE_PILLAR_LABELS[p]).join(", ")}</p>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ))}
      {log.outsideNotes?.length ? (
        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outside the questions</h4>
          <ul className="space-y-1">
            {log.outsideNotes.map((note, index) => (
              <li key={index} className="break-words text-sm">
                {note.note}
                {note.quote ? <span className="text-muted-foreground"> "{note.quote}"</span> : null}
                {note.at ? <span className="ml-2 font-mono text-xs text-muted-foreground">{note.at}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
