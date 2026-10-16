import type { DraftDiffSegment } from "@greatstone/shared";

// The text the drafting agent wakes up with after a person resolves a
// request_draft_review card. Rides the existing `paperclipAgentMessage` wake
// slot (capped at 12,000 chars downstream), so every adapter receives it. The
// full original, final text and diff stay on the interaction result.

const MAX_FINAL_TEXT_CHARS = 8_000;
const MAX_LISTED_CHANGES = 15;
const MAX_CHANGE_SIDE_CHARS = 200;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Groups the word diff into "removed X / added Y" lines. */
export function listDraftChanges(segments: DraftDiffSegment[]): string[] {
  const changes: { removed: string; added: string }[] = [];
  let current: { removed: string; added: string } | null = null;
  for (const segment of segments) {
    if (segment.type === "same") {
      // Whitespace between two edits keeps them as one change.
      if (/\S/.test(segment.text)) current = null;
      continue;
    }
    if (!current) {
      current = { removed: "", added: "" };
      changes.push(current);
    }
    current[segment.type] += segment.text;
  }
  return changes.map(({ removed, added }) => {
    const parts = [];
    if (removed.trim()) parts.push(`removed "${clip(removed.trim(), MAX_CHANGE_SIDE_CHARS)}"`);
    if (added.trim()) parts.push(`added "${clip(added.trim(), MAX_CHANGE_SIDE_CHARS)}"`);
    return `- ${parts.join(", ")}`;
  });
}

export function buildDraftReviewAgentMessage(interaction: {
  kind: string;
  status: string;
  payload?: unknown;
  result?: unknown;
}): string | null {
  if (interaction.kind !== "request_draft_review") return null;
  const payload = readObject(interaction.payload);
  const result = readObject(interaction.result);
  const purpose = typeof payload.purpose === "string" ? payload.purpose : "your draft";

  if (interaction.status === "rejected") {
    const note = typeof result.reason === "string" && result.reason.trim() ? result.reason.trim() : null;
    return [
      `The person asked for a redraft of "${purpose}".`,
      note ? `Their note: ${note}` : "They left no note; ask in a comment if the direction is unclear.",
      "Write a new version and post it with request_draft_review. Do not send or file the old draft.",
    ].join("\n");
  }

  if (interaction.status !== "accepted") return null;
  const draft = readObject(result.draft);
  const finalBody = typeof draft.finalBody === "string" ? draft.finalBody : null;
  if (finalBody === null) return null;

  if (draft.edited !== true) {
    return [
      `The person approved "${purpose}" as is.`,
      "Carry on with the next step you planned for it (for example send it or file it), using the text exactly as drafted.",
    ].join("\n");
  }

  const segments = Array.isArray(draft.diff) ? (draft.diff as DraftDiffSegment[]) : [];
  const changes = listDraftChanges(segments);
  const lines = [
    `The person edited "${purpose}" and sent it back (${typeof draft.editSummary === "string" ? draft.editSummary : "edited"}).`,
    "Use their edited text exactly as written for the next step (for example send it or file it). Do not reintroduce wording they removed.",
    "",
    "Final text:",
    "<<<",
    clip(finalBody, MAX_FINAL_TEXT_CHARS),
    ">>>",
    "",
    "What they changed:",
    ...changes.slice(0, MAX_LISTED_CHANGES),
    ...(changes.length > MAX_LISTED_CHANGES ? [`- and ${changes.length - MAX_LISTED_CHANGES} more`] : []),
  ];
  if (draft.learnFromEdits !== false) {
    lines.push(
      "",
      "Learn from this: if you have memory_contribute, save one short factual note to my_notes about what this person changes in drafts like this (tone, length, greeting, formatting, wording), so your next draft needs fewer edits. Recall those notes before drafting for them again.",
    );
  }
  return lines.join("\n");
}
